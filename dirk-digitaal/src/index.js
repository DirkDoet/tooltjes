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

// ------------------------------------------------------------------ agent ---

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-opus-5";
const ANTHROPIC_VERSION = "2023-06-01";
const CHAT_MAX_TOKENS = 4096;

// Vraag die de allereerste, automatische analyse uitlokt (AC-3).
export const FIRST_ANALYSIS_PROMPT =
  "Geef mij een eerste analyse van mijn Search Console-data: noem de opvallendste " +
  "zoekwoorden en pagina's, de grootste kansen en de aandachtspunten. Sluit af met " +
  "de vraag waar ik op wil inzoomen.";

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

const PLACEHOLDER = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dirk Digitaal</title>
<style>body{font-family:system-ui,sans-serif;max-width:34rem;margin:6rem auto;padding:0 1rem;color:#222}a.knop{display:inline-block;margin-top:1rem;background:#cc0000;color:#fff;padding:.6rem 1.1rem;border-radius:6px;text-decoration:none}</style>
</head><body>
<h1>Dirk Digitaal</h1>
<p>Koppel je Google Search Console om je zoekprestaties te bekijken. Het kantoor met de AI-agent komt hier binnenkort te staan.</p>
<a class="knop" href="/oauth/start">Koppel Search Console</a>
</body></html>`;

// GSC-data laden en cachen in de sessie (één keer per sessie), zodat elke
// vervolgvraag op dezelfde data leunt (AC-4). Kiest de eerste beschikbare site.
async function ensureGscData(stub, token, cached) {
  if (cached) return cached;
  const sites = await fetchGscSites(token);
  if (!sites || !sites.length) return null;
  const perf = await fetchGscPerformance(token, sites[0].siteUrl, "28");
  if (!perf) return null;
  const gsc = { sites: sites.map((s) => s.siteUrl), actief: sites[0].siteUrl, prestaties: perf };
  await stub.fetch("https://do/chat/set-gsc", { method: "POST", body: JSON.stringify({ gsc }) });
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
  const { token, messages: history, gsc: cachedGsc } = await stateResp.json();

  // Inkomende vraag (optioneel). Zonder vraag + lege historie → eerste analyse.
  let userText = "";
  try {
    const body = await request.json();
    userText = (body && typeof body.message === "string") ? body.message.trim() : "";
  } catch (e) { /* geen/lege body → eerste analyse */ }
  if (!userText && (!history || history.length === 0)) userText = FIRST_ANALYSIS_PROMPT;
  if (!userText) return json({ error: "Stel een vraag over je Search Console-data." }, 400);

  const gsc = await ensureGscData(stub, token, cachedGsc);
  if (!gsc) return json({ error: "Kon je Search Console-data niet laden. Is je site gekoppeld in Google?" }, 502);

  const messages = buildAnthropicMessages(history, userText);

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
      const toevoegen = [{ role: "user", content: userText }];
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

    // AC-2 — placeholder-startpagina.
    if (path === "/" && request.method === "GET") {
      return new Response(PLACEHOLDER, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
