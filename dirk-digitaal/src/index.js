/*
 * Dirk Digitaal — GSC-koppeling + sessie (backend Worker, DIR-12)
 *
 * Google OAuth (alleen-lezen Search Console) → ephemere sessie in een Durable
 * Object → endpoints die GSC-data teruggeven. Bewust NIETS permanents: geen
 * database, geen refresh-token; de sessie wist zichzelf na 30 min inactiviteit.
 *
 * Secrets (via `wrangler secret put`, niet in code):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 *
 * De pure helpers onderaan worden geëxporteerd voor unit-tests.
 */

const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min inactiviteit
const COOKIE = "dd_session";
const STATE_COOKIE = "dd_oauth_state";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

// ---------------------------------------------------------------- helpers ---

// Google's toestemmings-URL opbouwen. access_type "online" → geen refresh-token.
export function buildGoogleAuthUrl({ clientId, redirectUri, state }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPE,
    access_type: "online",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
  });
  return AUTH_ENDPOINT + "?" + p.toString();
}

export function parseCookies(header) {
  const uit = {};
  for (const deel of (header || "").split(";")) {
    const i = deel.indexOf("=");
    if (i === -1) continue;
    const k = deel.slice(0, i).trim();
    const v = deel.slice(i + 1).trim();
    if (k) uit[k] = decodeURIComponent(v);
  }
  return uit;
}

export function isExpired(lastActive, now, ttlMs = SESSION_TTL_MS) {
  return !lastActive || now - lastActive > ttlMs;
}

// GSC-rijen omzetten naar een compact, afgerond formaat voor de frontend/agent.
function mapRows(rows, sleutel) {
  return (rows || []).map((r) => ({
    [sleutel]: (r.keys && r.keys[0]) || "",
    clicks: Math.round(r.clicks || 0),
    impressions: Math.round(r.impressions || 0),
    ctr: Math.round((r.ctr || 0) * 1000) / 10, // percentage, 1 decimaal
    position: Math.round((r.position || 0) * 10) / 10,
  }));
}

export function shapePerformance(queriesRows, pagesRows) {
  return {
    queries: mapRows(queriesRows, "query"),
    pages: mapRows(pagesRows, "page"),
  };
}

// startDate/endDate (YYYY-MM-DD) op basis van "aantal dagen terug".
export function dateRange(days, now) {
  const d = Math.max(1, Math.min(Number(days) || 28, 400));
  const end = new Date(now);
  const start = new Date(now - d * 24 * 60 * 60 * 1000);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

// De periode van `days` dagen die direct vóór de huidige periode ligt (voor de trend).
export function previousDateRange(days, now) {
  const d = Math.max(1, Math.min(Number(days) || 28, 400));
  const dagMs = 24 * 60 * 60 * 1000;
  const end = new Date(now - d * dagMs);       // begin van de huidige periode
  const start = new Date(now - 2 * d * dagMs);
  const iso = (x) => x.toISOString().slice(0, 10);
  return { startDate: iso(start), endDate: iso(end) };
}

// Procentuele verandering huidig vs. vorig (afgerond op hele procenten).
export function computeTrend(current, previous) {
  const pct = (nu, was) => {
    if (!was) return nu > 0 ? 100 : 0;
    return Math.round(((nu - was) / was) * 100);
  };
  const c = current || {};
  const p = previous || {};
  return {
    clicksPct: pct(c.clicks || 0, p.clicks || 0),
    impressionsPct: pct(c.impressions || 0, p.impressions || 0),
  };
}

// ------------------------------------------------------------------ agent ---

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_VERSION = "2023-06-01";
const CHAT_MAX_TOKENS = 4096;

// De vraag die de SEO-analyse uitlokt. Vraagt om een dashboard met vaste secties
// (## koppen), zodat de frontend het als kaarten kan renderen (AC-4/AC-5).
// NB: een Cloudflare Worker-entrymodule mag alleen functies / handlers / Durable
// Objects als named export hebben — een kale string-export wordt door de runtime
// geweigerd. Daarom als functie geëxporteerd voor de tests.
const ANALYSIS_PROMPT =
  "Maak een SEO-analyse van de gekozen site op basis van de data. Gebruik EXACT deze " +
  "vier secties, elk met een '## '-kop, en '- ' voor opsommingen:\n" +
  "## Samenvatting\nKort (2-3 zinnen) hoe de site het doet.\n" +
  "## Sterke pagina's\nDe best presterende pagina's/zoekwoorden (clicks + positie), met cijfers.\n" +
  "## Kansen\nConcrete kansen: hoge impressies + lage CTR, of posities ~5-15 (bijna pagina 1). Noem de pagina/zoekwoord + wat te doen.\n" +
  "## Trend\nVergelijk deze 28 dagen met de vorige 28 dagen (clicks en impressies omhoog/omlaag, met percentages uit de data).\n" +
  "Sluit af met een korte vraag waar ik op wil inzoomen. Schrijf in het Nederlands, jij-vorm.";

export function firstAnalysisPrompt() {
  return ANALYSIS_PROMPT;
}

// Systeemprompt: GSC-analist, Nederlands, jij-vorm, gegrond in de sessie-data
// (aanpak uit de klant-analyse-skill: concreet, cijfermatig, actiegericht).
export function buildSystemPrompt(gsc) {
  const data = gsc ? JSON.stringify(gsc, null, 2) : "(nog geen data geladen)";
  return [
    "Je bent de GSC-analist van Dirk Digitaal: een scherpe, behulpzame SEO-analist.",
    "Schrijf altijd in het Nederlands en in de jij-vorm. Antwoord HELDER: korte zinnen,",
    "concrete cijfers, geen jargon-brei. Verwijs naar echte zoekwoorden, pagina's en",
    "getallen. Geef bruikbare, prioriteerbare aanbevelingen; verzin geen data.",
    "",
    "Je hebt een tool `gsc_query` om LIVE specifieke Search Console-data op te halen",
    "(per pagina, zoekwoord of periode, eventueel gefilterd op één pagina/zoekwoord).",
    "Gebruik die tool zodra de vraag over data gaat die niet in het overzicht hieronder",
    "staat (bijv. een specifieke pagina of zoekwoord). Baseer je antwoord dan op de",
    "opgehaalde cijfers, niet op een aanname. Lukt ophalen niet, zeg dat eerlijk.",
    "",
    "Als de gebruiker vraagt om een downloadbaar document (bijv. een rapport met",
    "actiepunten of een blog), geef dan UITSLUITEND een documentblok terug, exact zo:",
    "%%DOC <korte-bestandsslug>",
    "# Titel",
    "<nette Markdown met kopjes en '- ' bullets, gegrond in de data>",
    "%%ENDDOC",
    "Kies een beschrijvende slug (bijv. gsc-actiepunten of blog-beste-pagina). Zet geen",
    "tekst buiten het blok. Voor gewone vragen: normaal antwoorden, zonder documentblok.",
    "",
    "Search Console-data van deze sessie (top zoekwoorden en pagina's, laatste periode):",
    data,
  ].join("\n");
}

// Bouwt de messages-array voor de Messages API uit de sessie-historie + nieuwe vraag.
export function buildAnthropicMessages(history, userText) {
  const messages = (history || []).map((m) => ({ role: m.role, content: m.content }));
  if (userText) messages.push({ role: "user", content: userText });
  return messages;
}

// Haalt de tekst-deltas uit een Anthropic SSE-stream (voor het bewaren in de historie).
export function extractTextFromSSE(sse) {
  let out = "";
  for (const regel of (sse || "").split("\n")) {
    const t = regel.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const evt = JSON.parse(payload);
      if (evt.type === "content_block_delta" && evt.delta && typeof evt.delta.text === "string") {
        out += evt.delta.text;
      }
    } catch (e) { /* niet-JSON regels overslaan */ }
  }
  return out;
}

// Herkent een documentblok in het agent-antwoord (DIR-18). De agent markeert een
// downloadbaar document als:  %%DOC <bestandsslug>\n<markdown>\n%%ENDDOC
// Geeft { slug, markdown } terug, of null als er geen documentblok is.
export function parseDocMarker(text) {
  const m = (text || "").match(/%%DOC[ \t]+([^\n]*)\n([\s\S]*?)\n?%%ENDDOC/);
  if (!m) return null;
  const slug = m[1].trim() || "document";
  const markdown = m[2].trim();
  if (!markdown) return null;
  return { slug, markdown };
}

// Nette, beschrijvende .md-bestandsnaam op basis van de slug + datum (YYYYMMDD).
export function docFilename(slug, dateStr) {
  const veilig = String(slug || "document")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "document";
  const datum = (dateStr || "").replace(/[^0-9]/g, "").slice(0, 8);
  return veilig + (datum ? "-" + datum : "") + ".md";
}

function json(obj, status = 200, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(extraHeaders || {}) },
  });
}

function sessionCookie(id, maxAgeSec) {
  const parts = [
    `${COOKIE}=${id}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  return parts.join("; ");
}

// ---------------------------------------------------- Durable Object (sessie)

export class SessionDO {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname === "/put") {
      const { token } = await request.json();
      await this.state.storage.put({ token, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/get") {
      const data = await this.state.storage.get(["token", "lastActive"]);
      const token = data.get("token");
      const lastActive = data.get("lastActive");
      if (!token || isExpired(lastActive, now)) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ token: null }, 404);
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ token });
    }

    // Chat-state (historie + gecachete GSC-data), session-only. Elke aanraking
    // vernieuwt de activiteit + het TTL-alarm.
    if (url.pathname === "/chat/state") {
      const data = await this.state.storage.get(["token", "lastActive", "messages", "gsc"]);
      const token = data.get("token");
      if (!token || isExpired(data.get("lastActive"), now)) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ token: null }, 404);
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ token, messages: data.get("messages") || [], gsc: data.get("gsc") || null });
    }

    if (url.pathname === "/chat/set-gsc") {
      const { gsc } = await request.json();
      await this.state.storage.put({ gsc, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    // Site kiezen/wisselen: nieuwe data cachen én de chat-historie wissen, zodat
    // de nieuwe analyse schoon op de gekozen site gegrond is (AC-3).
    if (url.pathname === "/chat/select") {
      const { gsc } = await request.json();
      await this.state.storage.put({ gsc, messages: [], lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/chat/append") {
      const { messages } = await request.json();
      const bestaand = (await this.state.storage.get("messages")) || [];
      const nieuw = bestaand.concat(messages || []);
      await this.state.storage.put({ messages: nieuw, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/destroy") {
      const token = await this.state.storage.get("token");
      await this.state.storage.deleteAll();
      await this.state.storage.deleteAlarm();
      return json({ token: token || null });
    }

    return json({ error: "onbekend" }, 404);
  }

  // Auto-wissen na 30 min inactiviteit.
  async alarm() {
    await this.state.storage.deleteAll();
  }
}

// ------------------------------------------------------------- Worker-router

function sessionStub(env, id) {
  return env.SESSIONS.get(env.SESSIONS.idFromName(id));
}

async function huidigeToken(request, env) {
  const cookies = parseCookies(request.headers.get("Cookie"));
  const id = cookies[COOKIE];
  if (!id) return null;
  const resp = await sessionStub(env, id).fetch("https://do/get");
  if (!resp.ok) return null;
  const { token } = await resp.json();
  return token || null;
}

async function fetchGscSites(token) {
  const resp = await fetch(GSC_BASE + "/sites", { headers: { Authorization: "Bearer " + token } });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel }));
}

async function fetchGscPerformance(token, site, days) {
  const { startDate, endDate } = dateRange(days, Date.now());
  const endpoint = GSC_BASE + "/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
  const vraag = (dimension) =>
    fetch(endpoint, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ startDate, endDate, dimensions: [dimension], rowLimit: 10 }),
    });
  const [qResp, pResp] = await Promise.all([vraag("query"), vraag("page")]);
  if (!qResp.ok || !pResp.ok) return null;
  const qData = await qResp.json();
  const pData = await pResp.json();
  return { site, startDate, endDate, ...shapePerformance(qData.rows, pData.rows) };
}

// Totalen (clicks + impressies) voor een periode, zonder dimensies.
async function fetchGscTotals(token, site, startDate, endDate) {
  const endpoint = GSC_BASE + "/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ startDate, endDate }),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const row = (data.rows && data.rows[0]) || {};
  return { clicks: Math.round(row.clicks || 0), impressions: Math.round(row.impressions || 0) };
}

// Volledige analyse-data voor één site: top zoekwoorden/pagina's van de huidige
// 28 dagen + totalen van deze én de vorige 28 dagen, met de berekende trend (AC-4).
async function fetchGscPerformanceWithTrend(token, site) {
  const now = Date.now();
  const cur = dateRange("28", now);
  const prev = previousDateRange("28", now);
  const [perf, curTot, prevTot] = await Promise.all([
    fetchGscPerformance(token, site, "28"),
    fetchGscTotals(token, site, cur.startDate, cur.endDate),
    fetchGscTotals(token, site, prev.startDate, prev.endDate),
  ]);
  if (!perf || !curTot || !prevTot) return null;
  return {
    periode: { van: cur.startDate, tot: cur.endDate },
    vorige_periode: { van: prev.startDate, tot: prev.endDate },
    queries: perf.queries,
    pages: perf.pages,
    totalen: curTot,
    vorige_totalen: prevTot,
    trend: computeTrend(curTot, prevTot),
  };
}

// ---------------------------------------------------- live GSC-tool (DIR-20) ---

// Tool-definitie waarmee de agent tijdens het gesprek gericht GSC-data ophaalt.
export function gscTool() {
  return {
    name: "gsc_query",
    description:
      "Haal live Google Search Console-prestaties op voor de gekozen site. Gebruik dit " +
      "bij een vraag over een specifieke pagina, zoekwoord of periode die niet in het " +
      "beginoverzicht staat. Groepeer op query, page of date; optioneel filteren op een " +
      "pagina of zoekwoord (bevat-match).",
    input_schema: {
      type: "object",
      properties: {
        dimension: { type: "string", enum: ["query", "page", "date"], description: "Waarop groeperen." },
        days: { type: "integer", description: "Aantal dagen terug (default 28, max 180)." },
        filter_type: { type: "string", enum: ["page", "query"], description: "Optioneel filterveld." },
        filter_value: { type: "string", description: "Filterwaarde (bevat-match)." },
        row_limit: { type: "integer", description: "Max rijen (default 10, max 25)." },
      },
      required: ["dimension"],
    },
  };
}

function clamp(n, lo, hi, dflt) {
  const x = Number(n);
  if (!Number.isFinite(x)) return dflt;
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

// Bouwt de searchAnalytics.query-body uit de tool-argumenten (met verstandige limieten, AC-3).
export function buildGscQueryBody(args, now) {
  const a = args || {};
  const days = clamp(a.days, 1, 180, 28);
  const { startDate, endDate } = dateRange(days, now);
  const dim = ["query", "page", "date"].includes(a.dimension) ? a.dimension : "query";
  const body = { startDate, endDate, dimensions: [dim], rowLimit: clamp(a.row_limit, 1, 25, 10) };
  if ((a.filter_type === "page" || a.filter_type === "query") && a.filter_value) {
    body.dimensionFilterGroups = [{
      filters: [{ dimension: a.filter_type, operator: "contains", expression: String(a.filter_value) }],
    }];
  }
  return body;
}

async function fetchGscQuery(token, site, args) {
  if (!site) return { error: "Geen site gekozen." };
  const body = buildGscQueryBody(args, Date.now());
  const endpoint = GSC_BASE + "/sites/" + encodeURIComponent(site) + "/searchAnalytics/query";
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { error: "Kon deze data niet ophalen bij Google (" + resp.status + ")." };
  const data = await resp.json();
  const sleutel = body.dimensions[0];
  const rows = (data.rows || []).map((r) => ({
    [sleutel]: (r.keys && r.keys[0]) || "",
    clicks: Math.round(r.clicks || 0),
    impressions: Math.round(r.impressions || 0),
    ctr: Math.round((r.ctr || 0) * 1000) / 10,
    position: Math.round((r.position || 0) * 10) / 10,
  }));
  return { periode: { van: body.startDate, tot: body.endDate }, dimensie: sleutel, rijen: rows };
}

// Splitst een assistant-response in tekst + tool_use-blokken.
export function parseAssistant(content) {
  let text = "";
  const toolUses = [];
  for (const b of content || []) {
    if (b.type === "text" && typeof b.text === "string") text += b.text;
    else if (b.type === "tool_use") toolUses.push(b);
  }
  return { text: text.trim(), toolUses };
}

async function callAnthropic(env, system, messages) {
  const resp = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: CHAT_MAX_TOKENS,
      system,
      messages,
      tools: [gscTool()],
    }),
  });
  if (!resp.ok) return null;
  return resp.json();
}

// Verpakt platte tekst als een SSE-stream die de bestaande frontend (content_block_delta) leest.
function sseResponse(text) {
  const enc = new TextEncoder();
  const stuk = [];
  for (let i = 0; i < text.length; i += 48) stuk.push(text.slice(i, i + 48));
  const stream = new ReadableStream({
    start(controller) {
      for (const p of stuk) {
        const evt = { type: "content_block_delta", delta: { type: "text_delta", text: p } };
        controller.enqueue(enc.encode("data: " + JSON.stringify(evt) + "\n\n"));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

const OFFICE_HTML = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dirk Digitaal</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&family=VT323&display=swap" rel="stylesheet">
<style>
  :root{ --navy:#2b2b33; --panel:#3E3E3E; --teal:#015092; --teal2:#2f7fbf;
    --cream:#f4f0e6; --ink:#171717; --accent:#F18E02; --shadow:#000;
    --baksteen:#8a3b2e; --voeg:#5f2a20; --mosterd:#d9a441; --plant:#3c7d3c;
    --hond:#e0b566; --honddonker:#b98a3e; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:#0e1116; color:#e8e2d8; image-rendering:pixelated;
    font-family:'VT323',monospace; -webkit-font-smoothing:none; }
  .scene-host{ min-height:100vh; display:flex; align-items:center; justify-content:center;
    overflow:hidden; background:radial-gradient(120% 90% at 50% 20%,#1a2129 0%,#0e1116 70%); }
  /* ---- kantoor-scène (blauwdruk DIR-21, front-cutaway) ---- */
  @keyframes dd-blink{0%,60%{opacity:1}61%,100%{opacity:.25}}
  @keyframes dd-bulb{0%,100%{opacity:.9}50%{opacity:.6}}
  @keyframes dd-cta{0%,100%{opacity:1}50%{opacity:.55}}
  @keyframes dd-legA{0%,49%{transform:translateY(0)}50%,100%{transform:translateY(-2px)}}
  @keyframes dd-legB{0%,49%{transform:translateY(-2px)}50%,100%{transform:translateY(0)}}
  @keyframes dd-tail{0%,100%{transform:rotate(-8deg)}50%{transform:rotate(10deg)}}
  @keyframes dd-dogwalk{0%{left:6%;transform:scaleX(1)}34%{left:64%;transform:scaleX(1)}40%{left:66%;transform:scaleX(1)}46%{left:66%;transform:scaleX(-1)}52%{left:66%;transform:scaleX(-1)}86%{left:6%;transform:scaleX(-1)}92%{left:6%;transform:scaleX(1)}100%{left:6%;transform:scaleX(1)}}
  @keyframes dd-modal-in{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}
  .scene-wrap{ position:relative; width:min(100vw,177.78vh); aspect-ratio:16/9; max-height:100vh; }
  #agent-desk{ cursor:pointer; transition:filter .12s; }
  #agent-desk:hover, #agent-desk:focus{ outline:none;
    filter:drop-shadow(0 0 6px #F18E02) drop-shadow(0 0 14px rgba(241,142,2,.6)); }
  .dog{ position:absolute; bottom:6%; left:6%; width:9%; pointer-events:none;
    animation:dd-dogwalk 26s ease-in-out infinite; }
  /* chat-portret naast de chat (AC-2) */
  .chatrow{ display:flex; flex:1; min-height:0; }
  .chatmain{ flex:1; display:flex; flex-direction:column; min-width:0; }
  .portret{ flex:0 0 84px; display:flex; flex-direction:column; align-items:center; padding:.6rem;
    background:#14202b; border-right:3px solid var(--ink); }
  .portret .avatar{ width:72px; height:72px; background:#0b1219; border:2px solid var(--accent);
    display:flex; align-items:center; justify-content:center; font-size:2.2rem; }
  .portret .pnaam{ margin-top:.4rem; font-size:.85rem; letter-spacing:1px; color:#3fd06a; }
  @media (prefers-reduced-motion: reduce){ .scene-wrap *{ animation:none !important; } }
  @media (max-width:640px){ .portret{ flex-basis:60px; }
    .portret .avatar{ width:48px; height:48px; font-size:1.5rem; } }

  /* chat */
  .overlay{ display:none; position:fixed; inset:0; background:#0a0b1299;
    align-items:center; justify-content:center; padding:1rem; z-index:10; }
  .chat{ width:min(34rem,100%); max-height:90vh; display:flex; flex-direction:column;
    background:var(--cream); color:var(--ink); border:4px solid var(--ink);
    box-shadow:8px 8px 0 var(--shadow); }
  .chat header{ background:var(--teal); color:var(--cream); padding:.5rem .7rem;
    display:flex; align-items:center; justify-content:space-between; border-bottom:3px solid var(--ink); }
  .chat header b{ letter-spacing:1px; font-size:.95rem; }
  .x{ background:var(--accent); color:#fff; border:2px solid var(--ink); cursor:pointer;
    font-family:inherit; font-weight:bold; padding:.1rem .5rem; }
  .msgs{ flex:1; overflow:auto; padding:.7rem; display:flex; flex-direction:column; gap:.5rem;
    background:#fbf9f3; min-height:8rem; }
  .bubble{ padding:.5rem .6rem; border:2px solid var(--ink); max-width:85%; white-space:pre-wrap;
    word-break:break-word; font-size:.9rem; line-height:1.35; }
  .bubble.user{ align-self:flex-end; background:var(--teal2); color:#08211d; }
  .bubble.agent{ align-self:flex-start; background:#fff; }
  .notice{ font-size:.72rem; color:#4a4e6d; padding:.4rem .7rem; background:#efe9db;
    border-top:2px solid var(--ink); }
  .notice.flash{ background:var(--teal2); color:#08211d; }
  .composer{ display:none; gap:.4rem; padding:.6rem; border-top:3px solid var(--ink); background:var(--cream); }
  .composer input{ flex:1; font-family:inherit; font-size:.9rem; padding:.45rem;
    border:2px solid var(--ink); }
  button.knop{ font-family:inherit; font-weight:bold; cursor:pointer; border:2px solid var(--ink);
    background:var(--teal); color:var(--cream); padding:.45rem .8rem; box-shadow:2px 2px 0 var(--shadow); }
  button.knop:disabled{ opacity:.5; cursor:default; }
  .bar{ display:flex; gap:.5rem; padding:.6rem; border-top:2px solid var(--ink); background:var(--cream); flex-wrap:wrap; }
  button.rood{ background:var(--accent); }
  /* site-keuze + dashboard */
  .sitekeuze{ align-self:flex-start; background:#fff; border:2px solid var(--ink); padding:.6rem; max-width:100%; }
  .sitekeuze p{ margin:0 0 .5rem; font-size:.9rem; }
  .sitekeuze .sitebtn{ display:block; width:100%; text-align:left; margin:.25rem 0; }
  .dash{ align-self:stretch; display:flex; flex-direction:column; gap:.6rem; }
  .card{ background:#fff; border:2px solid var(--ink); box-shadow:3px 3px 0 var(--shadow); }
  .card h3{ margin:0; background:var(--teal); color:var(--cream); font-size:.85rem; letter-spacing:1px;
    padding:.35rem .6rem; border-bottom:2px solid var(--ink); }
  .card .body{ padding:.5rem .7rem; font-size:.88rem; line-height:1.4; white-space:pre-wrap; word-break:break-word; }
  .card .body ul{ margin:.2rem 0; padding-left:1.1rem; }
  .download-knop{ align-self:flex-start; background:var(--accent); color:#111; }
  @media (max-width:640px){ .kamer{ transform:scale(.66); transform-origin:top center; }
    .stage{ height:280px; } h1.titel{ font-size:1.5rem; } }
</style>
</head><body>
<div class="scene-host">
  <div class="scene-wrap">
    <svg viewBox="0 0 640 360" width="100%" height="100%" shape-rendering="crispEdges" style="display:block;position:absolute;inset:0;image-rendering:pixelated;">
      <defs>
        <pattern id="brick" width="32" height="16" patternUnits="userSpaceOnUse">
          <rect width="32" height="16" fill="#6d271c"/>
          <rect width="32" height="1" y="0" fill="#3f130d"/>
          <rect width="1" height="8" x="0" y="0" fill="#3f130d"/>
          <rect width="1" height="8" x="16" y="8" fill="#3f130d"/>
          <rect width="32" height="1" y="8" fill="#3f130d"/>
          <rect width="30" height="6" x="1" y="1" fill="#7d3125"/>
          <rect width="14" height="6" x="1" y="9" fill="#7d3125"/>
          <rect width="14" height="6" x="17" y="9" fill="#7d3125"/>
        </pattern>
        <symbol id="deskEmpty" viewBox="0 0 100 80">
          <rect x="46" y="30" width="8" height="12" fill="#0c0c0c"/>
          <rect x="40" y="42" width="20" height="4" fill="#0c0c0c"/>
          <rect x="30" y="6" width="40" height="26" fill="#0a0a0a"/>
          <rect x="34" y="10" width="32" height="18" fill="#14202b"/>
          <rect x="37" y="13" width="12" height="2" fill="#22384a"/>
          <rect x="37" y="18" width="20" height="2" fill="#1d2f3e"/>
          <rect x="37" y="23" width="8" height="2" fill="#1d2f3e"/>
          <rect x="8" y="46" width="84" height="8" fill="#2b2b2b"/>
          <rect x="8" y="54" width="84" height="22" fill="#141414"/>
          <rect x="14" y="54" width="4" height="22" fill="#0c0c0c"/>
          <rect x="82" y="54" width="4" height="22" fill="#0c0c0c"/>
          <rect x="36" y="48" width="28" height="4" fill="#333"/>
        </symbol>
        <symbol id="plant" viewBox="0 0 40 60">
          <rect x="10" y="40" width="20" height="18" fill="#8a4a2b"/>
          <rect x="10" y="40" width="20" height="4" fill="#a85c37"/>
          <rect x="12" y="18" width="6" height="24" fill="#2f7d3a"/>
          <rect x="22" y="14" width="6" height="28" fill="#2f7d3a"/>
          <rect x="17" y="10" width="6" height="32" fill="#3c9c49"/>
          <rect x="6" y="24" width="6" height="16" fill="#256b30"/>
          <rect x="28" y="22" width="6" height="18" fill="#256b30"/>
          <rect x="14" y="6" width="4" height="10" fill="#3c9c49"/>
          <rect x="24" y="4" width="4" height="12" fill="#3c9c49"/>
        </symbol>
        <symbol id="hex" viewBox="0 0 40 36">
          <polygon points="10,2 30,2 38,18 30,34 10,34 2,18" fill="#1c242c" stroke="#F18E02" stroke-width="1"/>
        </symbol>
        <symbol id="robot" viewBox="0 0 40 40">
          <rect x="19" y="1" width="2" height="5" fill="#8a9096"/>
          <rect x="17" y="0" width="4" height="3" fill="#F18E02"/>
          <rect x="8" y="10" width="2" height="7" fill="#F18E02"/>
          <rect x="30" y="10" width="2" height="7" fill="#F18E02"/>
          <rect x="10" y="6" width="20" height="15" fill="#8a9096"/>
          <rect x="10" y="6" width="20" height="3" fill="#aab0b6"/>
          <rect x="12" y="9" width="16" height="9" fill="#14202b"/>
          <rect x="15" y="11" width="3" height="3" fill="#3fd0e6"/>
          <rect x="22" y="11" width="3" height="3" fill="#3fd0e6"/>
          <rect x="15" y="15" width="10" height="1" fill="#3285D1"/>
          <rect x="12" y="20" width="16" height="14" fill="#015092"/>
          <rect x="12" y="20" width="16" height="3" fill="#0a6bbf"/>
          <rect x="18" y="24" width="4" height="4" fill="#F18E02"/>
          <rect x="8" y="22" width="4" height="9" fill="#6a7076"/>
          <rect x="28" y="22" width="4" height="9" fill="#6a7076"/>
        </symbol>
      </defs>
      <polygon points="0,0 640,0 544,48 96,48" fill="#171b20"/>
      <polygon points="0,0 96,48 96,50 0,4" fill="#0f1216"/>
      <polygon points="0,4 96,48 96,240 0,360" fill="#3a2a22"/>
      <polygon points="0,4 96,48 96,60 0,20" fill="#241812"/>
      <polygon points="640,4 544,48 544,240 640,360" fill="#33241d"/>
      <polygon points="640,4 544,48 544,60 640,20" fill="#241812"/>
      <polygon points="96,240 544,240 640,360 0,360" fill="#4b4f55"/>
      <polygon points="96,240 544,240 544,246 96,246" fill="#3c4045"/>
      <rect x="0" y="352" width="640" height="8" fill="#3a3e43"/>
      <polygon points="230,240 210,360 214,360 234,240" fill="#454951"/>
      <polygon points="410,240 430,360 426,360 406,240" fill="#454951"/>
      <rect x="96" y="48" width="448" height="192" fill="url(#brick)"/>
      <rect x="96" y="48" width="448" height="192" fill="#000" opacity="0.12"/>
      <rect x="96" y="234" width="448" height="6" fill="#20130e"/>
      <g>
        <use href="#hex" x="112" y="70" width="40" height="36"/>
        <use href="#hex" x="150" y="70" width="40" height="36"/>
        <use href="#hex" x="131" y="100" width="40" height="36"/>
        <use href="#hex" x="169" y="100" width="40" height="36"/>
        <use href="#hex" x="112" y="130" width="40" height="36"/>
        <use href="#hex" x="150" y="130" width="40" height="36"/>
        <rect x="120" y="76" width="24" height="24" fill="#c98a5a"/>
        <rect x="158" y="76" width="24" height="24" fill="#8aa0b5"/>
        <rect x="139" y="106" width="24" height="24" fill="#b56a4a"/>
        <rect x="177" y="106" width="24" height="24" fill="#7d9c6a"/>
        <rect x="120" y="136" width="24" height="24" fill="#9a8fb5"/>
        <rect x="158" y="136" width="24" height="24" fill="#c9a05a"/>
      </g>
      <rect x="300" y="56" width="236" height="176" fill="#20262c"/>
      <rect x="300" y="56" width="236" height="4" fill="#2b333a"/>
      <text x="316" y="120" font-family="'Press Start 2P'" font-size="12" fill="#F18E02" transform="rotate(-3 316 120)">CREATIVITY</text>
      <text x="330" y="140" font-family="'Press Start 2P'" font-size="12" fill="#F18E02" transform="rotate(-3 330 140)">NEVER DIES</text>
      <text x="340" y="176" font-family="'Press Start 2P'" font-size="14" fill="#3285D1" transform="rotate(2 340 176)">DREAM BIG</text>
      <text x="322" y="210" font-family="'Press Start 2P'" font-size="10" fill="#e8e2d8" transform="rotate(-2 322 210)">NO PAIN</text>
      <text x="360" y="226" font-family="'Press Start 2P'" font-size="10" fill="#e8e2d8" transform="rotate(-2 360 226)">NO GAIN</text>
      <g>
        <rect x="174" y="48" width="2" height="58" fill="#0a0a0a"/>
        <rect x="168" y="106" width="14" height="12" fill="#3a2f18"/>
        <rect x="170" y="112" width="10" height="10" fill="#ffb733" style="animation:dd-bulb 3.2s ease-in-out infinite"/>
        <rect x="330" y="48" width="2" height="48" fill="#0a0a0a"/>
        <rect x="324" y="96" width="14" height="12" fill="#3a2f18"/>
        <rect x="326" y="102" width="10" height="10" fill="#ffb733" style="animation:dd-bulb 2.6s ease-in-out infinite"/>
        <rect x="464" y="48" width="2" height="58" fill="#0a0a0a"/>
        <rect x="458" y="106" width="14" height="12" fill="#3a2f18"/>
        <rect x="460" y="112" width="10" height="10" fill="#ffb733" style="animation:dd-bulb 3.6s ease-in-out infinite"/>
      </g>
      <g>
        <rect x="470" y="222" width="86" height="20" fill="#c99a1e"/>
        <rect x="470" y="216" width="86" height="10" fill="#d9ab2c"/>
        <rect x="470" y="200" width="10" height="24" fill="#b8891a"/>
        <rect x="546" y="200" width="10" height="24" fill="#b8891a"/>
        <rect x="482" y="206" width="28" height="14" fill="#e4b83e"/>
        <rect x="514" y="206" width="28" height="14" fill="#e4b83e"/>
        <rect x="470" y="240" width="86" height="6" fill="#7d5c10"/>
      </g>
      <use href="#plant" x="500" y="176" width="34" height="52"/>
      <use href="#plant" x="104" y="182" width="30" height="46"/>
      <use href="#deskEmpty" x="130" y="158" width="96" height="77"/>
      <text x="160" y="226" font-family="'Press Start 2P'" font-size="6" fill="#7a828a">SOON</text>
      <use href="#deskEmpty" x="416" y="158" width="96" height="77"/>
      <text x="446" y="226" font-family="'Press Start 2P'" font-size="6" fill="#7a828a">SOON</text>
      <use href="#deskEmpty" x="384" y="244" width="132" height="106"/>
      <text x="428" y="336" font-family="'Press Start 2P'" font-size="7" fill="#7a828a">SOON</text>
      <g id="agent-desk" role="button" tabindex="0" aria-label="Open de GSC-agent">
        <rect x="146" y="220" width="150" height="126" fill="#000" opacity="0"/>
        <rect x="196" y="262" width="46" height="46" fill="#111"/>
        <rect x="200" y="266" width="38" height="30" fill="#1c1c1c"/>
        <!-- GSC-agent: de robot-mascotte (zelfde figuur als het chat-portret), iets groter -->
        <use href="#robot" x="184" y="232" width="72" height="72"/>
        <rect x="150" y="304" width="132" height="10" fill="#2b2b2b"/>
        <rect x="150" y="314" width="132" height="34" fill="#141414"/>
        <rect x="156" y="314" width="5" height="34" fill="#0c0c0c"/>
        <rect x="271" y="314" width="5" height="34" fill="#0c0c0c"/>
        <rect x="252" y="298" width="8" height="8" fill="#0c0c0c"/>
        <rect x="246" y="278" width="36" height="24" fill="#0a0a0a"/>
        <rect x="250" y="282" width="28" height="16" fill="#3a2400"/>
        <rect x="252" y="284" width="14" height="2" fill="#F18E02"/>
        <rect x="252" y="288" width="20" height="2" fill="#c97400"/>
        <rect x="252" y="292" width="10" height="2" fill="#F18E02"/>
        <rect x="176" y="306" width="46" height="5" fill="#333"/>
        <rect x="150" y="216" width="96" height="18" fill="#0b1219"/>
        <rect x="150" y="216" width="96" height="18" fill="none" stroke="#F18E02" stroke-width="1"/>
        <circle cx="161" cy="225" r="4" fill="#3fd06a" style="animation:dd-blink 2s steps(1) infinite"/>
        <text x="170" y="229" font-family="'Press Start 2P'" font-size="6" fill="#e8e2d8">GSC-AGENT</text>
      </g>
      <ellipse cx="86" cy="336" rx="46" ry="12" fill="#2a2f34"/>
      <ellipse cx="86" cy="334" rx="38" ry="9" fill="#6d3b8f" opacity="0.55"/>
      <ellipse cx="86" cy="333" rx="30" ry="6" fill="#824aa8" opacity="0.5"/>
      <polygon points="0,300 640,300 640,360 0,360" fill="#000" opacity="0.10"/>
    </svg>

    <div class="dog" aria-hidden="true">
      <svg viewBox="0 0 60 40" width="100%" shape-rendering="crispEdges" style="image-rendering:pixelated;display:block;">
        <g style="transform-origin:8px 16px;animation:dd-tail .5s ease-in-out infinite">
          <rect x="2" y="14" width="8" height="4" fill="#c99a4e"/>
        </g>
        <rect x="8" y="12" width="34" height="14" fill="#d9a441"/>
        <rect x="8" y="12" width="34" height="4" fill="#e6b755"/>
        <rect x="38" y="8" width="16" height="16" fill="#d9a441"/>
        <rect x="38" y="8" width="16" height="4" fill="#e6b755"/>
        <rect x="38" y="8" width="5" height="12" fill="#b8842f"/>
        <rect x="52" y="16" width="6" height="6" fill="#e6b755"/>
        <rect x="56" y="17" width="3" height="3" fill="#1a1a1a"/>
        <rect x="47" y="13" width="3" height="3" fill="#2a1c0c"/>
        <rect x="40" y="20" width="4" height="6" fill="#F18E02"/>
        <g style="animation:dd-legA .34s steps(1) infinite">
          <rect x="12" y="26" width="5" height="9" fill="#b8842f"/>
          <rect x="34" y="26" width="5" height="9" fill="#b8842f"/>
        </g>
        <g style="animation:dd-legB .34s steps(1) infinite">
          <rect x="20" y="26" width="5" height="9" fill="#c99a4e"/>
          <rect x="42" y="26" width="5" height="9" fill="#c99a4e"/>
        </g>
      </svg>
    </div>

    <div style="position:absolute;top:0;left:0;right:0;height:30%;background:linear-gradient(to bottom, rgba(8,11,15,.82) 0%, rgba(8,11,15,.5) 55%, rgba(8,11,15,0) 100%);pointer-events:none;"></div>
    <div style="position:absolute;top:5%;left:0;right:0;text-align:center;pointer-events:none;">
      <div style="font-family:'Press Start 2P',monospace;color:#F18E02;font-size:clamp(18px,4.4vw,52px);letter-spacing:2px;text-shadow:4px 4px 0 #015092,8px 8px 0 rgba(0,0,0,.35);">DIRK DIGITAAL</div>
      <div style="margin-top:14px;font-family:'VT323',monospace;color:#e8e2d8;font-size:clamp(16px,2.4vw,30px);letter-spacing:3px;text-shadow:2px 2px 0 #000;">Verwarrend duidelijk</div>
    </div>
    <div style="position:absolute;bottom:4%;left:0;right:0;text-align:center;pointer-events:none;">
      <span style="display:inline-block;font-family:'VT323',monospace;font-size:clamp(15px,2.1vw,26px);letter-spacing:1px;color:#e8e2d8;background:rgba(11,18,25,.72);border:1px solid #F18E02;padding:6px 16px;text-shadow:1px 1px 0 #000;animation:dd-cta 2.4s ease-in-out infinite;">
        <span style="color:#F18E02">&#9656;</span> Klik op de GSC-agent om een gesprek te starten
      </span>
    </div>
  </div>
</div>

<div class="overlay" id="chat-overlay" role="dialog" aria-label="GSC-agent chat">
  <div class="chat">
    <header><b>GSC-agent</b><button class="x" id="chat-close" aria-label="Sluiten">X</button></header>
    <div class="chatrow">
      <div class="portret" aria-hidden="true">
        <div class="avatar"><svg viewBox="0 0 40 40" width="64" height="64" shape-rendering="crispEdges" style="image-rendering:pixelated"><use href="#robot"/></svg></div>
        <div class="pnaam">&#9679; online</div>
      </div>
      <div class="chatmain">
        <div class="msgs" id="chat-msgs">
          <div class="bubble agent">Hoi! Ik ben je GSC-agent. Koppel je Google Search Console, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.</div>
        </div>
        <div class="notice" id="privacy-notice">Privacy: je koppeling en dit gesprek leven alleen in deze sessie. Ze wissen zichzelf als je weggaat of na 30 minuten. Er wordt niets blijvend opgeslagen. Klik hieronder op "Koppel Google" om te beginnen.</div>
        <div class="bar">
          <button class="knop" id="chat-connect">Koppel Google</button>
          <button class="knop" id="chat-switch" style="display:none">Andere site</button>
          <button class="knop rood" id="chat-disconnect">Verbreek &amp; wis</button>
        </div>
        <div class="composer" id="chat-composer">
          <input id="chat-input" type="text" placeholder="Stel een vraag over je cijfers..." autocomplete="off">
          <button class="knop" id="chat-send">Stuur</button>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function(){
  var overlay=document.getElementById('chat-overlay');
  var msgs=document.getElementById('chat-msgs');
  var input=document.getElementById('chat-input');
  var sendBtn=document.getElementById('chat-send');
  var connectBtn=document.getElementById('chat-connect');
  var switchBtn=document.getElementById('chat-switch');
  var composer=document.getElementById('chat-composer');
  var agent=document.getElementById('agent-desk');
  var notice=document.getElementById('privacy-notice');
  var connected=false, busy=false, started=false;

  function openChat(){ overlay.style.display='flex'; }
  function closeChat(){ overlay.style.display='none'; }
  function setConnected(v){ connected=v; connectBtn.style.display=v?'none':'inline-block';
    if(notice) notice.style.display=v?'none':'block'; }
  function setActive(v){ composer.style.display=v?'flex':'none'; switchBtn.style.display=v?'inline-block':'none'; }
  function addBubble(who,text){ var b=document.createElement('div'); b.className='bubble '+who;
    b.textContent=text; msgs.appendChild(b); msgs.scrollTop=msgs.scrollHeight; return b; }
  function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  function connect(){ window.location.href='/oauth/start'; }

  // Zet de gestreamde analyse-tekst met '## '-koppen om naar kaarten (AC-5).
  function renderDashboard(text){
    var wrap=document.createElement('div'); wrap.className='dash';
    var lines=text.split('\\n'); var titel=null, body=[];
    function flush(){ if(titel===null) return;
      var card=document.createElement('div'); card.className='card';
      var h=document.createElement('h3'); h.textContent=titel; card.appendChild(h);
      var bd=document.createElement('div'); bd.className='body';
      bd.innerHTML=body.join('\\n'); card.appendChild(bd); wrap.appendChild(card); titel=null; body=[]; }
    for(var i=0;i<lines.length;i++){ var ln=lines[i]; var m=ln.match(/^##\\s+(.*)/);
      if(m){ flush(); titel=m[1].trim(); continue; }
      if(titel!==null){ var t=ln.replace(/^\\s*-\\s+/,'\\u2022 ');
        body.push(esc(t).replace(/\\*\\*(.+?)\\*\\*/g,'<b>$1</b>')); } }
    flush();
    if(!wrap.children.length){ var c=document.createElement('div'); c.className='card';
      var b2=document.createElement('div'); b2.className='body'; b2.textContent=text; c.appendChild(b2); wrap.appendChild(c); }
    return wrap;
  }

  function renderSitePicker(sites){
    var box=document.createElement('div'); box.className='sitekeuze';
    var p=document.createElement('p'); p.textContent='Welke website wil je analyseren?'; box.appendChild(p);
    (sites||[]).forEach(function(s){ var b=document.createElement('button'); b.className='knop sitebtn';
      b.textContent=s; b.addEventListener('click',function(){ box.remove(); addBubble('user','Analyseer '+s);
        streamChat({site:s}, true); }); box.appendChild(b); });
    msgs.appendChild(box); msgs.scrollTop=msgs.scrollHeight;
  }

  // Documentblok herkennen (DIR-18): "%%DOC <slug>" ... "%%ENDDOC" met markdown ertussen.
  function parseDoc(text){
    var m=(text||'').match(/%%DOC[ \\t]+([^\\n]*)\\n([\\s\\S]*?)\\n?%%ENDDOC/);
    if(!m) return null;
    var md=m[2].trim(); if(!md) return null;
    return { slug:(m[1].trim()||'document'), markdown:md };
  }
  function bestandsnaam(slug){
    var d=new Date(); var yyyymmdd=''+d.getFullYear()+('0'+(d.getMonth()+1)).slice(-2)+('0'+d.getDate()).slice(-2);
    var veilig=String(slug||'document').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,60)||'document';
    return veilig+'-'+yyyymmdd+'.md';
  }
  function toonDownload(slug, md){
    var naam=bestandsnaam(slug);
    var b=document.createElement('button'); b.className='knop download-knop';
    b.textContent='\\u2b07 Download '+naam;
    b.addEventListener('click',function(){
      try{
        var blob=new Blob([md],{type:'text/markdown;charset=utf-8'});
        var url=URL.createObjectURL(blob);
        var a=document.createElement('a'); a.href=url; a.download=naam;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function(){ URL.revokeObjectURL(url); }, 2000);
      }catch(e){ b.textContent='Download lukte niet — selecteer de tekst en kopieer.'; }
    });
    msgs.appendChild(b); msgs.scrollTop=msgs.scrollHeight;
  }

  async function streamChat(payload, dashboard){
    if(busy) return; busy=true; sendBtn.disabled=true;
    var bubble=addBubble('agent', dashboard?'Ik maak je analyse...':'...'); var got='';
    try{
      var r=await fetch('/api/chat',{ method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload||{}) });
      var ct=r.headers.get('Content-Type')||'';
      if(!r.ok||ct.indexOf('application/json')!==-1){
        var j={}; try{ j=await r.json(); }catch(e){}
        if(j&&j.needSite){ bubble.remove(); renderSitePicker(j.sites); busy=false; sendBtn.disabled=false; return; }
        bubble.textContent=(j&&j.error)||'Er ging iets mis. Probeer het opnieuw.';
        if(r.status===401){ setConnected(false); setActive(false); started=false; }
        busy=false; sendBtn.disabled=false; return;
      }
      var reader=r.body.getReader(); var dec=new TextDecoder(); var buf='';
      while(true){ var c=await reader.read(); if(c.done) break;
        buf+=dec.decode(c.value,{stream:true}); var lines=buf.split('\\n'); buf=lines.pop();
        for(var i=0;i<lines.length;i++){ var line=lines[i].trim();
          if(line.indexOf('data:')!==0) continue; var p=line.slice(5).trim();
          if(!p||p==='[DONE]') continue;
          try{ var evt=JSON.parse(p);
            if(evt.type==='content_block_delta'&&evt.delta&&typeof evt.delta.text==='string'){
              got+=evt.delta.text; bubble.textContent=got; msgs.scrollTop=msgs.scrollHeight; } }catch(e){} } }
      if(!got){ bubble.textContent='De agent gaf geen antwoord. Probeer het opnieuw.'; }
      else if(dashboard){ msgs.replaceChild(renderDashboard(got), bubble); msgs.scrollTop=msgs.scrollHeight; setActive(true); }
      else {
        var doc=parseDoc(got);
        if(doc){ bubble.textContent=doc.markdown; toonDownload(doc.slug, doc.markdown); }
        setActive(true);
      }
    }catch(e){ bubble.textContent='Kon de agent niet bereiken. Probeer het opnieuw.'; }
    busy=false; sendBtn.disabled=false;
  }

  // Startpunt na koppelen: backend beslist tussen site-keuze (meerdere) of directe analyse (één).
  async function startFlow(){ if(started) return; started=true; await streamChat({}, true); }

  async function send(){ var t=(input.value||'').trim(); if(!t||busy) return; input.value='';
    addBubble('user',t); await streamChat({message:t}, false); }

  async function switchSite(){ if(busy) return;
    try{ var r=await fetch('/api/gsc/sites'); if(!r.ok) return; var j=await r.json(); renderSitePicker(j.sites||[]); }catch(e){} }

  async function disconnect(){ try{ await fetch('/api/disconnect'); }catch(e){}
    setConnected(false); setActive(false); started=false; msgs.innerHTML='';
    notice.textContent='Je sessie is gewist. Er is niets bewaard.'; notice.classList.add('flash'); }

  agent.addEventListener('click',function(){ openChat(); if(connected&&!started) startFlow(); });
  agent.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openChat(); if(connected&&!started) startFlow(); } });
  document.getElementById('chat-close').addEventListener('click',closeChat);
  connectBtn.addEventListener('click',connect);
  switchBtn.addEventListener('click',switchSite);
  document.getElementById('chat-disconnect').addEventListener('click',disconnect);
  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });

  // Bij (her)laden: al gekoppeld? Dan chat openen en de flow starten (na terugkeer van Google).
  fetch('/api/gsc/sites').then(function(r){ if(r.ok){ setConnected(true); openChat(); startFlow(); }
    else{ setConnected(false); } }).catch(function(){ setConnected(false); });
})();

// Kantoorhond: loopt rond en gaat af en toe bij de mand liggen (AC-4).
// Respecteert prefers-reduced-motion: dan ligt de hond stil in de mand (AC-5).
(function(){
  var hond=document.getElementById('hond'); if(!hond) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Vloercoördinaten (binnen de 340x340 iso-vloer). Mand ligt rechtsvoor.
  var MIN=30, MAX=300, BED={x:246,y:250};
  var x=120, y=150;
  function place(px,py){ hond.style.left=px+'px'; hond.style.top=py+'px'; }
  function faceDir(fx,tx){ if(tx<fx) hond.classList.add('links'); else hond.classList.remove('links'); }
  place(x,y);
  if(reduce){ hond.classList.add('ligt'); place(BED.x,BED.y); return; }
  function walkTo(tx,ty,cb){ faceDir(x,tx); hond.classList.remove('ligt'); hond.classList.add('loopt');
    x=tx; y=ty; place(tx,ty); setTimeout(function(){ hond.classList.remove('loopt'); if(cb) cb(); }, 2600); }
  function lie(cb){ hond.classList.add('ligt'); setTimeout(function(){ hond.classList.remove('ligt'); if(cb) cb(); }, 4000); }
  function rnd(){ return Math.floor(Math.random()*(MAX-MIN))+MIN; }
  function loop(){
    if(Math.random()<0.4){ walkTo(BED.x,BED.y,function(){ lie(function(){ setTimeout(loop,600); }); }); }
    else { walkTo(rnd(),rnd(),function(){ setTimeout(loop,1000+Math.random()*2200); }); }
  }
  setTimeout(loop,1500);
})();
</script>
</body></html>`;

// Data voor één gekozen site laden + in de sessie zetten (historie schoon).
async function selectSite(stub, token, siteUrl, alleSites) {
  const perf = await fetchGscPerformanceWithTrend(token, siteUrl);
  if (!perf) return null;
  const gsc = { sites: alleSites, actief: siteUrl, ...perf };
  await stub.fetch("https://do/chat/select", { method: "POST", body: JSON.stringify({ gsc }) });
  return gsc;
}

async function handleChat(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "De agent is nog niet geconfigureerd (API-sleutel ontbreekt)." }, 500);
  }

  const cookies = parseCookies(request.headers.get("Cookie"));
  const id = cookies[COOKIE];
  if (!id) return json({ error: "Niet gekoppeld. Koppel eerst je Search Console." }, 401);

  const stub = sessionStub(env, id);
  const stateResp = await stub.fetch("https://do/chat/state");
  if (!stateResp.ok) return json({ error: "Niet gekoppeld. Koppel eerst je Search Console." }, 401);
  let { token, messages: history, gsc } = await stateResp.json();

  // Body: optioneel { message } (vervolgvraag) en/of { site } (kiezen/wisselen).
  let body = {};
  try { body = await request.json(); } catch (e) { /* lege body toegestaan */ }
  const wantSite = (body && typeof body.site === "string") ? body.site.trim() : "";
  let userText = (body && typeof body.message === "string") ? body.message.trim() : "";

  let promptText;              // wat naar het model gaat
  let storedUser = userText;   // wat in de historie komt

  if (wantSite) {
    // AC-2/AC-3: site kiezen of wisselen → nieuwe analyse.
    const sites = await fetchGscSites(token);
    if (!sites || !sites.length) return json({ error: "Geen Search Console-sites gevonden in je account." }, 502);
    if (!sites.some((s) => s.siteUrl === wantSite)) return json({ error: "Die site staat niet in je account." }, 400);
    gsc = await selectSite(stub, token, wantSite, sites.map((s) => s.siteUrl));
    if (!gsc) return json({ error: "Kon de prestaties van die site niet laden." }, 502);
    history = [];
    promptText = ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + wantSite + "]";
  } else if (!gsc) {
    // Nog geen site gekozen: 1 site → automatisch analyseren; meerdere → vraag welke.
    const sites = await fetchGscSites(token);
    if (!sites || !sites.length) return json({ error: "Geen Search Console-sites gevonden in je account." }, 502);
    if (sites.length > 1) {
      return json({ needSite: true, sites: sites.map((s) => s.siteUrl) });
    }
    gsc = await selectSite(stub, token, sites[0].siteUrl, sites.map((s) => s.siteUrl));
    if (!gsc) return json({ error: "Kon de prestaties van je site niet laden." }, 502);
    history = [];
    promptText = ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + sites[0].siteUrl + "]";
  } else {
    // Site al gekozen → vervolgvraag.
    if (!userText) return json({ error: "Stel een vraag over je cijfers." }, 400);
    promptText = userText;
  }

  const system = buildSystemPrompt(gsc);
  const site = gsc && gsc.actief;
  const convo = buildAnthropicMessages(history, promptText);

  // Agentische tool-loop: het model mag live GSC-data ophalen (gsc_query) vóór het
  // antwoordt. Max iteraties beperkt kosten/rate (AC-3). We voeren de loop niet-
  // streamend uit en sturen de uiteindelijke tekst als SSE naar de bestaande frontend.
  let finalText = "";
  try {
    for (let i = 0; i < 5; i++) {
      const resp = await callAnthropic(env, system, convo);
      if (!resp || !resp.content) {
        return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
      }
      const parsed = parseAssistant(resp.content);
      if (resp.stop_reason === "tool_use" && parsed.toolUses.length) {
        convo.push({ role: "assistant", content: resp.content });
        const resultaten = [];
        for (const tu of parsed.toolUses) {
          let out;
          try { out = await fetchGscQuery(token, site, tu.input); }
          catch (e) { out = { error: "kon deze data niet ophalen" }; }
          resultaten.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) });
        }
        convo.push({ role: "user", content: resultaten });
        continue;
      }
      finalText = parsed.text;
      break;
    }
  } catch (e) {
    return json({ error: "Kon de AI-agent niet bereiken. Probeer het zo opnieuw." }, 502);
  }
  if (!finalText) finalText = "Ik kon je vraag nu niet beantwoorden. Probeer het iets anders te formuleren.";

  ctx.waitUntil(
    stub.fetch("https://do/chat/append", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: storedUser }, { role: "assistant", content: finalText }] }),
    }).catch(() => {})
  );

  return sseResponse(finalText);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;
    const redirectUri = origin + "/oauth/callback";

    // Startpagina: het 2D retro-kantoor (DIR-14).
    if (path === "/" && request.method === "GET") {
      return new Response(OFFICE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // AC-3 — start OAuth.
    if (path === "/oauth/start") {
      if (!env.GOOGLE_CLIENT_ID) return json({ error: "Koppeling niet geconfigureerd (client-ID ontbreekt)." }, 500);
      const state = crypto.randomUUID();
      const authUrl = buildGoogleAuthUrl({ clientId: env.GOOGLE_CLIENT_ID, redirectUri, state });
      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          "Set-Cookie": `${STATE_COOKIE}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
        },
      });
    }

    // AC-4 — callback: code → access token → sessie in DO + cookie.
    if (path === "/oauth/callback") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const cookies = parseCookies(request.headers.get("Cookie"));
      if (!code || !state || state !== cookies[STATE_COOKIE]) {
        return json({ error: "Ongeldige of verlopen inlogpoging. Probeer opnieuw." }, 400);
      }
      if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
        return json({ error: "Koppeling niet geconfigureerd." }, 500);
      }

      const body = new URLSearchParams({
        code,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });
      const tokenResp = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!tokenResp.ok) {
        return json({ error: "Kon niet inloggen bij Google. Probeer opnieuw." }, 502);
      }
      const tok = await tokenResp.json();
      const accessToken = tok.access_token;
      if (!accessToken) return json({ error: "Geen toegang gekregen van Google." }, 502);

      const sessionId = crypto.randomUUID();
      await sessionStub(env, sessionId).fetch("https://do/put", {
        method: "POST",
        body: JSON.stringify({ token: accessToken }),
      });

      // Sessie-cookie zetten, state-cookie wissen, terug naar de startpagina.
      const headers = new Headers({ Location: origin + "/" });
      headers.append("Set-Cookie", sessionCookie(sessionId, Math.floor(SESSION_TTL_MS / 1000)));
      headers.append("Set-Cookie", `${STATE_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      return new Response(null, { status: 302, headers });
    }

    // AC-8 — disconnect: token revoken + sessie vernietigen.
    if (path === "/api/disconnect") {
      const cookies = parseCookies(request.headers.get("Cookie"));
      const id = cookies[COOKIE];
      if (id) {
        const resp = await sessionStub(env, id).fetch("https://do/destroy");
        const { token } = await resp.json();
        if (token) {
          try {
            await fetch(REVOKE_ENDPOINT + "?token=" + encodeURIComponent(token), { method: "POST" });
          } catch (e) { /* revoke best-effort */ }
        }
      }
      return json({ ok: true }, 200, { "Set-Cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    // AC-6 — GSC-sites.
    if (path === "/api/gsc/sites") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Search Console via /oauth/start." }, 401);
      const sites = await fetchGscSites(token);
      if (!sites) return json({ error: "Kon je sites niet ophalen bij Google." }, 502);
      return json({ sites });
    }

    // AC-7 — GSC-prestaties (top zoekwoorden + top pagina's).
    if (path === "/api/gsc/performance") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Search Console via /oauth/start." }, 401);
      const site = url.searchParams.get("site");
      if (!site) return json({ error: "Geef een site op via ?site=<url>." }, 400);
      const perf = await fetchGscPerformance(token, site, url.searchParams.get("days"));
      if (!perf) return json({ error: "Kon de prestaties niet ophalen bij Google." }, 502);
      return json(perf);
    }

    // AC-1..AC-6 — GSC-agent: streaming chat gegrond in de sessie-data.
    if (path === "/api/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    return json({ error: "Onbekende route." }, 404);
  },
};
