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
    "Schrijf altijd in het Nederlands en in de jij-vorm. Wees concreet en cijfermatig:",
    "verwijs naar echte zoekwoorden, pagina's en getallen uit de data hieronder.",
    "Geef bruikbare, prioriteerbare aanbevelingen; verzin geen data die er niet staat.",
    "Als de gebruiker iets vraagt dat niet uit deze data te halen is, zeg dat eerlijk.",
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

const OFFICE_HTML = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dirk Digitaal</title>
<style>
  :root{ --navy:#1a1c2c; --panel:#3b3f5c; --teal:#257179; --teal2:#2a9d8f;
    --cream:#f4f0e6; --ink:#12131f; --accent:#b13e53; --shadow:#000; }
  *{ box-sizing:border-box; }
  body{ margin:0; background:var(--navy); color:var(--cream);
    font-family:"Courier New",ui-monospace,monospace; image-rendering:pixelated;
    -webkit-font-smoothing:none; }
  .wrap{ max-width:60rem; margin:0 auto; padding:1rem; }
  h1.titel{ text-align:center; letter-spacing:2px; margin:.6rem 0 1rem;
    font-size:2rem; text-transform:uppercase; color:var(--cream);
    text-shadow:3px 3px 0 var(--accent); }
  .titel small{ display:block; font-size:.7rem; letter-spacing:1px; color:#c9c6bd; margin-top:.3rem; text-shadow:none; }
  .office{ background:var(--panel);
    background-image:repeating-linear-gradient(0deg,#0000 0 22px,#00000022 22px 24px);
    border:4px solid var(--ink); box-shadow:6px 6px 0 var(--shadow);
    padding:1.2rem; }
  .floor{ display:grid; grid-template-columns:repeat(2,1fr); gap:1rem; }
  .desk{ background:#4a4e6d; border:3px solid var(--ink); box-shadow:4px 4px 0 var(--shadow);
    padding:.9rem; text-align:center; position:relative; min-height:9rem;
    display:flex; flex-direction:column; align-items:center; justify-content:flex-end; }
  .monitor{ width:66px; height:52px; background:var(--ink); border:3px solid #0a0b12;
    border-radius:4px; display:flex; align-items:center; justify-content:center; margin-bottom:.5rem; }
  .screen{ width:46px; height:32px; background:#0d3b3f; box-shadow:inset 0 0 0 2px #062023; }
  .desk.leeg{ opacity:.6; }
  .desk.agent{ cursor:pointer; }
  .desk.agent .screen{ background:var(--teal2); animation:blink 1.6s steps(2,end) infinite; }
  @keyframes blink{ 50%{ background:#1c5c56; } }
  .desk.agent:hover, .desk.agent:focus{ outline:none; box-shadow:6px 6px 0 var(--accent);
    transform:translate(-1px,-1px); }
  .sprite{ font-size:1.6rem; line-height:1; margin-bottom:.35rem; }
  .plate{ background:var(--ink); color:var(--cream); font-size:.7rem; letter-spacing:1px;
    padding:.25rem .5rem; border:2px solid #0a0b12; width:100%; }
  .badge{ position:absolute; top:.4rem; right:.4rem; font-size:.6rem; background:var(--accent);
    color:#fff; padding:.1rem .35rem; border:2px solid var(--ink); }
  .hint{ text-align:center; font-size:.75rem; color:#c9c6bd; margin-top:1rem; }

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
  @media (max-width:640px){ .floor{ grid-template-columns:1fr; } h1.titel{ font-size:1.5rem; } }
</style>
</head><body>
<div class="wrap">
  <h1 class="titel">Dirk Digitaal<small>jouw digitale marketingbureau &mdash; klik een agent aan</small></h1>
  <div class="office" role="group" aria-label="Kantoor">
    <div class="floor">
      <div class="desk agent" id="agent-desk" role="button" tabindex="0" aria-label="Open de GSC-agent">
        <span class="badge">online</span>
        <div class="sprite">&#129302;</div>
        <div class="monitor"><div class="screen"></div></div>
        <div class="plate">GSC-agent</div>
      </div>
      <div class="desk leeg"><div class="sprite">&#128100;</div><div class="monitor"><div class="screen"></div></div><div class="plate">binnenkort</div></div>
      <div class="desk leeg"><div class="sprite">&#128100;</div><div class="monitor"><div class="screen"></div></div><div class="plate">binnenkort</div></div>
      <div class="desk leeg"><div class="sprite">&#128100;</div><div class="monitor"><div class="screen"></div></div><div class="plate">binnenkort</div></div>
    </div>
  </div>
  <p class="hint">Klik op de GSC-agent aan het eerste bureau om je Search Console te koppelen en je cijfers te bespreken.</p>
</div>

<div class="overlay" id="chat-overlay" role="dialog" aria-label="GSC-agent chat">
  <div class="chat">
    <header><b>GSC-agent</b><button class="x" id="chat-close" aria-label="Sluiten">X</button></header>
    <div class="msgs" id="chat-msgs">
      <div class="bubble agent">Hoi! Ik ben je GSC-agent. Koppel je Google Search Console, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.</div>
    </div>
    <div class="notice" id="privacy-notice">Privacy: je koppeling en dit gesprek leven alleen in deze sessie. Ze wissen zichzelf als je weggaat of na 30 minuten. Er wordt niets blijvend opgeslagen.</div>
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
  function setConnected(v){ connected=v; connectBtn.style.display=v?'none':'inline-block'; }
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
      else { setActive(true); }
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

  const messages = buildAnthropicMessages(history, promptText);

  let upstream;
  try {
    upstream = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: CHAT_MAX_TOKENS,
        stream: true,
        system: buildSystemPrompt(gsc),
        messages,
      }),
    });
  } catch (e) {
    return json({ error: "Kon de AI-agent niet bereiken. Probeer het zo opnieuw." }, 502);
  }
  if (!upstream.ok || !upstream.body) {
    return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
  }

  // Stream naar de client én een kopie meelezen om het antwoord in de historie te bewaren.
  const [naarClient, meelezen] = upstream.body.tee();
  ctx.waitUntil((async () => {
    try {
      const sse = await new Response(meelezen).text();
      const antwoord = extractTextFromSSE(sse);
      const toevoegen = [{ role: "user", content: storedUser }];
      if (antwoord) toevoegen.push({ role: "assistant", content: antwoord });
      await stub.fetch("https://do/chat/append", { method: "POST", body: JSON.stringify({ messages: toevoegen }) });
    } catch (e) { /* historie-bewaren is best-effort */ }
  })());

  return new Response(naarClient, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
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
