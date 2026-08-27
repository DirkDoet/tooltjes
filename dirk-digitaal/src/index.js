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

// Eén Google-koppeling dekt GSC (Albert), GA4 (Gertjan) en Google Ads (Ilona):
// read-only scopes worden samen aangevraagd (DIR-28/DIR-30).
const SCOPES = [
  "https://www.googleapis.com/auth/webmasters.readonly",
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/adwords", // Google Ads (Ilona, DIR-30)
];
const SCOPE = SCOPES.join(" ");
const SESSION_TTL_MS = 30 * 60 * 1000; // 30 min inactiviteit
const COOKIE = "dd_session";
const STATE_COOKIE = "dd_oauth_state";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";
const GA4_ADMIN_BASE = "https://analyticsadmin.googleapis.com/v1beta";
const GA4_DATA_BASE = "https://analyticsdata.googleapis.com/v1beta";
const GADS_VERSION = "v25";
const GADS_BASE = "https://googleads.googleapis.com/" + GADS_VERSION;
// Meta Ads per klant (magic-link + System User-token, achter admin-beheer) — DIR-30.
const META_VERSION = "v21.0";
const META_GRAPH_BASE = "https://graph.facebook.com/" + META_VERSION;
const ADMIN_COOKIE = "dd_admin";   // admin-sessie (klantbeheer)
const KLANT_COOKIE = "dd_klant";   // klant-sleutel (scoping via magic-link)

// ============================================================================
// ===== AGENT-INSTRUCTIES — HIER AANPASSEN, daarna `wrangler deploy` ==========
// ============================================================================
// De system-prompts van de agents op één plek. Per agent:
//   persona  = de basis-instructie (wie ben je + hoe antwoord je + tool-uitleg);
//              de laatste regel kondigt de sessie-data aan, die de code eronder plakt.
//   analyse  = de opdracht voor de eerste analyse (dashboard met '## '-secties).
// Tekst wijzigen? Pas hieronder aan en run `wrangler deploy` om het live te zetten.
// Nieuwe agent (bijv. Ilona uitbreiden)? Voeg een blok toe volgens hetzelfde patroon
// en verwijs ernaar vanuit de bijbehorende build...SystemPrompt / ..._ANALYSIS_PROMPT.
const AGENT_INSTRUCTIES = {
  // ---- Albert — GSC / SEO ----
  albert: {
    persona: [
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
    ],
    analyse:
      "Maak een SEO-analyse van de gekozen site op basis van de data. Gebruik EXACT deze " +
      "vier secties, elk met een '## '-kop, en '- ' voor opsommingen:\n" +
      "## Samenvatting\nKort (2-3 zinnen) hoe de site het doet.\n" +
      "## Sterke pagina's\nDe best presterende pagina's/zoekwoorden (clicks + positie), met cijfers.\n" +
      "## Kansen\nConcrete kansen: hoge impressies + lage CTR, of posities ~5-15 (bijna pagina 1). Noem de pagina/zoekwoord + wat te doen.\n" +
      "## Trend\nVergelijk deze 28 dagen met de vorige 28 dagen (clicks en impressies omhoog/omlaag, met percentages uit de data).\n" +
      "Sluit af met een korte vraag waar ik op wil inzoomen. Schrijf in het Nederlands, jij-vorm.",
  },
  // ---- Gertjan — GA4 ----
  gertjan: {
    persona: [
      "Je bent Gertjan, de GA4-data-specialist van Dirk Digitaal: scherp en behulpzaam.",
      "Schrijf altijd in het Nederlands en in de jij-vorm. Antwoord HELDER: korte zinnen,",
      "concrete cijfers, geen jargon-brei. Verwijs naar echte pagina's, kanalen en getallen.",
      "Geef bruikbare, prioriteerbare inzichten; verzin geen data.",
      "",
      "Je hebt een tool `ga4_report` om LIVE specifieke Google Analytics 4-cijfers op te halen",
      "(per pagina, kanaal, land, apparaat of datum, eventueel gefilterd). Gebruik die tool zodra de",
      "vraag over data gaat die niet in het overzicht hieronder staat. Baseer je antwoord dan op de",
      "opgehaalde cijfers, niet op een aanname. Lukt ophalen niet, zeg dat eerlijk.",
      "",
      "GA4-data van deze sessie (overzicht van de gekozen property):",
    ],
    analyse:
      "Maak een GA4-verkeersanalyse van de gekozen property op basis van de data. Gebruik EXACT deze " +
      "vijf secties, elk met een '## '-kop en '- ' voor opsommingen:\n" +
      "## Samenvatting\nKort (2-3 zinnen) hoe het verkeer eruitziet.\n" +
      "## Verkeer & trend\nGebruikers, sessies en paginaweergaven van deze periode vs. de vorige periode (met percentages uit de data).\n" +
      "## Top pagina's\nDe best bezochte pagina's, met cijfers.\n" +
      "## Kanalen\nWaar het verkeer vandaan komt (kanaalgroepen), met cijfers.\n" +
      "## Opvallend\nWat springt eruit of verdient aandacht (sterke stijging/daling, opvallend kanaal).\n" +
      "Sluit af met een korte vraag waar ik op wil inzoomen. Schrijf in het Nederlands, jij-vorm.",
  },
  // ---- Ilona — Google Ads (+ Meta voor gekoppelde klanten) ----
  ilona: {
    persona: [
      "Je bent Ilona, de advertentie-specialist van Dirk Digitaal (Google Ads en, voor gekoppelde klanten, Meta Ads).",
      "Schrijf altijd in het Nederlands en in de jij-vorm. Antwoord HELDER: korte zinnen,",
      "concrete cijfers (kosten in euro's, conversies), geen jargon-brei. Verwijs naar echte",
      "campagnes, zoekwoorden en getallen. Geef bruikbare, prioriteerbare aanbevelingen; verzin geen data.",
      "",
      "Je hebt een tool `ads_report` om LIVE specifieke Google Ads-cijfers op te halen (campagnes,",
      "zoekwoorden, advertentiegroepen of zoektermen). Gebruik die tool zodra de vraag over data gaat die",
      "niet in het overzicht hieronder staat. Baseer je antwoord dan op de opgehaalde cijfers, niet op een",
      "aanname. Lukt ophalen niet, zeg dat eerlijk.",
      "",
      "Google Ads-data van deze sessie (overzicht van het gekozen account):",
    ],
    analyse:
      "Maak een Google Ads-analyse van het gekozen account op basis van de data. Gebruik EXACT deze " +
      "vijf secties, elk met een '## '-kop en '- ' voor opsommingen:\n" +
      "## Samenvatting\nKort (2-3 zinnen) hoe de advertenties presteren.\n" +
      "## Kosten & rendement\nTotale kosten, klikken, impressies en conversies; kosten per conversie waar mogelijk.\n" +
      "## Top campagnes\nDe campagnes met de meeste kosten/conversies, met cijfers.\n" +
      "## Kansen\nWaar geld beter besteed kan worden (dure campagnes zonder conversies, kansrijke zoekwoorden).\n" +
      "## Opvallend\nWat springt eruit of verdient aandacht.\n" +
      "Sluit af met een korte vraag waar ik op wil inzoomen. Schrijf in het Nederlands, jij-vorm.",
  },
  // ---- Anton — content/tekst (geen databron/koppeling) ----
  anton: {
    persona: [
      "Je bent Anton, de content- en tekstspecialist van Dirk Digitaal. Je hebt GEEN databron of",
      "koppeling — je werkt puur met de tekst en instructies die de gebruiker je geeft.",
      "Schrijf altijd in het Nederlands en in de jij-vorm (tenzij de gebruiker een andere taal vraagt,",
      "bijvoorbeeld bij vertalen). Lever HELDERE, direct bruikbare output; leg alleen kort uit als dat helpt.",
      "",
      "Je helpt met: schrijven, vertalen, spelling- en grammaticacontrole, inkorten, verlengen,",
      "herschrijven (andere toon of doelgroep) en SEO-teksten. Vraag door als de opdracht onduidelijk is;",
      "verzin geen feiten.",
      "",
      "Als de gebruiker vraagt om een downloadbaar document, geef dan UITSLUITEND een documentblok terug,",
      "exact zo:",
      "%%DOC <korte-bestandsslug>",
      "# Titel",
      "<nette Markdown met kopjes en '- ' bullets>",
      "%%ENDDOC",
      "Kies een beschrijvende slug (bijvoorbeeld blog-najaarsactie). Voor gewone bewerkingen: normaal",
      "antwoorden, zonder documentblok.",
    ],
  },
};
// ============================================================================
// ===== EINDE AGENT-INSTRUCTIES ==============================================
// ============================================================================

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

// ---------------------------------------------------- GA4 (Gertjan, DIR-28) ---

const GA4_METRICS = ["activeUsers", "sessions", "screenPageViews", "conversions"];
const GA4_DIMENSIONS = ["pagePath", "sessionDefaultChannelGroup", "country", "deviceCategory", "date"];

// Property-id normaliseren: "properties/123" of "123" → "123".
export function ga4PropertyId(property) {
  return String(property || "").replace(/^properties\//, "").trim();
}

// GA4 runReport-body uit tool-argumenten, met verstandige limieten (AC-3).
export function buildGa4ReportBody(args, now) {
  const a = args || {};
  const days = clamp(a.days, 1, 365, 28);
  const { startDate, endDate } = dateRange(days, now);
  const dim = GA4_DIMENSIONS.includes(a.dimension) ? a.dimension : "pagePath";
  const metric = GA4_METRICS.includes(a.metric) ? a.metric : "sessions";
  const body = {
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: dim }],
    metrics: [{ name: metric }],
    limit: clamp(a.row_limit, 1, 25, 10),
  };
  if (a.filter_value) {
    body.dimensionFilter = {
      filter: { fieldName: dim, stringFilter: { matchType: "CONTAINS", value: String(a.filter_value), caseSensitive: false } },
    };
  }
  return body;
}

// Tool waarmee Gertjan tijdens het gesprek gericht GA4-cijfers ophaalt (AC-4).
export function ga4Tool() {
  return {
    name: "ga4_report",
    description:
      "Haal live Google Analytics 4-cijfers op voor de gekozen property. Gebruik dit bij een " +
      "vraag over specifiek verkeer (pagina's, kanalen, land, apparaat of over tijd) die niet in " +
      "het beginoverzicht staat. Kies één metric en één dimensie; optioneel filteren (bevat-match).",
    input_schema: {
      type: "object",
      properties: {
        metric: { type: "string", enum: GA4_METRICS, description: "Maatstaf: gebruikers/sessies/paginaweergaven/conversies." },
        dimension: { type: "string", enum: GA4_DIMENSIONS, description: "Groeperen op pagina, kanaal, land, apparaat of datum." },
        days: { type: "integer", description: "Aantal dagen terug (default 28, max 365)." },
        filter_value: { type: "string", description: "Optioneel: bevat-match op de dimensie." },
        row_limit: { type: "integer", description: "Max rijen (default 10, max 25)." },
      },
      required: ["metric", "dimension"],
    },
  };
}

// runReport-rijen met één dimensie + één metric → compact formaat.
export function shapeGa4Rows(rows, dimName) {
  return (rows || []).map((r) => ({
    [dimName]: (r.dimensionValues && r.dimensionValues[0] && r.dimensionValues[0].value) || "",
    waarde: Number((r.metricValues && r.metricValues[0] && r.metricValues[0].value) || 0),
  }));
}

// Totalen uit een runReport zonder dimensie (meerdere metrics) → { metricName: getal }.
export function shapeGa4Totals(report) {
  const row = (report && report.rows && report.rows[0]) || {};
  const vals = row.metricValues || [];
  const headers = (report && report.metricHeaders) || [];
  const out = {};
  headers.forEach((h, i) => { out[h.name] = Number((vals[i] && vals[i].value) || 0); });
  return out;
}

// Procentuele trend voor GA4 (gebruikers + sessies).
export function computeGa4Trend(current, previous) {
  const pct = (nu, was) => (!was ? (nu > 0 ? 100 : 0) : Math.round(((nu - was) / was) * 100));
  const c = current || {}, p = previous || {};
  return {
    activeUsersPct: pct(c.activeUsers || 0, p.activeUsers || 0),
    sessionsPct: pct(c.sessions || 0, p.sessions || 0),
  };
}

const GA4_ANALYSIS_PROMPT = AGENT_INSTRUCTIES.gertjan.analyse;

export function ga4FirstAnalysisPrompt() {
  return GA4_ANALYSIS_PROMPT;
}

// Systeemprompt: Gertjan (GA4). Instructie-tekst staat bovenin bij AGENT_INSTRUCTIES.
export function buildGa4SystemPrompt(ga4) {
  const data = ga4 ? JSON.stringify(ga4, null, 2) : "(nog geen data geladen)";
  return AGENT_INSTRUCTIES.gertjan.persona.concat([data]).join("\n");
}

// ------------------------------------------ Google Ads (Ilona, DIR-30) ---

// Rapport-definities: GAQL-bron + label (GAQL-veld) + JSON-pad (REST camelCase).
const ADS_REPORTS = {
  campaigns:    { from: "campaign",         gaqlLabel: "campaign.name",                     jsonPath: ["campaign", "name"] },
  keywords:     { from: "keyword_view",     gaqlLabel: "ad_group_criterion.keyword.text",   jsonPath: ["adGroupCriterion", "keyword", "text"] },
  ad_groups:    { from: "ad_group",         gaqlLabel: "ad_group.name",                     jsonPath: ["adGroup", "name"] },
  search_terms: { from: "search_term_view", gaqlLabel: "search_term_view.search_term",      jsonPath: ["searchTermView", "searchTerm"] },
};

// "customers/123" → "123".
export function adsCustomerId(resourceName) {
  return String(resourceName || "").replace(/^customers\//, "").trim();
}

// Bouwt een GAQL-query + metadata uit tool-argumenten (met verstandige limieten, AC-3).
export function buildAdsQuery(args, now) {
  const a = args || {};
  const report = ADS_REPORTS[a.report] ? a.report : "campaigns";
  const conf = ADS_REPORTS[report];
  const days = clamp(a.days, 1, 365, 28);
  const { startDate, endDate } = dateRange(days, now);
  const limit = clamp(a.row_limit, 1, 50, 10);
  const query =
    "SELECT " + conf.gaqlLabel + ", metrics.cost_micros, metrics.clicks, metrics.impressions, metrics.conversions " +
    "FROM " + conf.from + " WHERE segments.date BETWEEN '" + startDate + "' AND '" + endDate + "' " +
    "ORDER BY metrics.cost_micros DESC LIMIT " + limit;
  return { query, report, startDate, endDate, jsonPath: conf.jsonPath };
}

// Tool waarmee Ilona live Google Ads-cijfers ophaalt (AC-4).
export function adsTool() {
  return {
    name: "ads_report",
    description:
      "Haal live Google Ads-cijfers op voor het gekozen account. Kies een rapport (campagnes, " +
      "zoekwoorden, advertentiegroepen of zoektermen); optioneel periode en limiet.",
    input_schema: {
      type: "object",
      properties: {
        report: { type: "string", enum: Object.keys(ADS_REPORTS), description: "Welk rapport." },
        days: { type: "integer", description: "Aantal dagen terug (default 28, max 365)." },
        row_limit: { type: "integer", description: "Max rijen (default 10, max 50)." },
      },
      required: ["report"],
    },
  };
}

// GoogleAds search-resultaten (REST) → compact formaat. cost_micros → euro's.
export function shapeAdsRows(results, jsonPath) {
  const pad = jsonPath || [];
  const lees = (o) => pad.reduce((x, k) => (x == null ? undefined : x[k]), o);
  return (results || []).map((r) => {
    const m = r.metrics || {};
    return {
      label: lees(r) || "",
      kosten: Math.round((Number(m.costMicros || 0) / 1e6) * 100) / 100,
      clicks: Math.round(Number(m.clicks || 0)),
      impressies: Math.round(Number(m.impressions || 0)),
      conversies: Math.round(Number(m.conversions || 0) * 10) / 10,
    };
  });
}

// Totalen optellen uit een rijenset (voor het eerste overzicht).
export function sumAdsRows(rows) {
  return (rows || []).reduce((t, r) => ({
    kosten: Math.round((t.kosten + (r.kosten || 0)) * 100) / 100,
    clicks: t.clicks + (r.clicks || 0),
    impressies: t.impressies + (r.impressies || 0),
    conversies: Math.round((t.conversies + (r.conversies || 0)) * 10) / 10,
  }), { kosten: 0, clicks: 0, impressies: 0, conversies: 0 });
}

const ADS_ANALYSIS_PROMPT = AGENT_INSTRUCTIES.ilona.analyse;

export function adsFirstAnalysisPrompt() {
  return ADS_ANALYSIS_PROMPT;
}

// Systeemprompt: Ilona (Google Ads). Instructie-tekst staat bovenin bij AGENT_INSTRUCTIES.
export function buildAdsSystemPrompt(ads) {
  const data = ads ? JSON.stringify(ads, null, 2) : "(nog geen data geladen)";
  return AGENT_INSTRUCTIES.ilona.persona.concat([data]).join("\n");
}

// Systeemprompt: Anton (content/tekst). Geen databron — puur de persona (DIR-39).
export function buildContentSystemPrompt() {
  return AGENT_INSTRUCTIES.anton.persona.join("\n");
}

// -------------------- Meta Ads + admin + klanten (KV, DIR-30) ---

// HMAC-SHA256 → hex (Web Crypto). Voor appsecret_proof én de admin-cookie.
async function hmacHex(key, message) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// appsecret_proof = HMAC-SHA256 van het access token met het app-secret (AC-3).
export async function appsecretProof(token, appSecret) {
  return hmacHex(appSecret || "", token || "");
}

// Constante-tijd string-vergelijk (voorkomt timing-lek).
function veiligGelijk(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let r = 0;
  for (let i = 0; i < x.length; i++) r |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return r === 0;
}

// Unieke, niet-raadbare sleutel voor een klant-magic-link (AC-1/AC-6).
export function randomKey() {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s; // 36 hex-tekens
}

// Admin-cookie: HMAC van een vaste string met het wachtwoord (niet te vervalsen).
async function adminCookieValue(env) {
  return hmacHex(env.ADMIN_PASSWORD || "", "dd-admin-v1");
}

// Geldige admin-sessie? (AC-1/AC-6)
async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const got = parseCookies(request.headers.get("Cookie"))[ADMIN_COOKIE];
  if (!got) return false;
  return veiligGelijk(got, await adminCookieValue(env));
}

// Meta klaar? (system-token + app-secret aanwezig)
function metaConfigured(env) {
  return !!(env.META_SYSTEM_TOKEN && env.META_APP_SECRET);
}

// ---- Klant-config in KV: sleutel -> { naam, adAccountId } (AC-1). ----
async function kvAddClient(env, naam, adAccountId) {
  if (!env.CLIENTS) return null;
  const key = randomKey();
  const rec = { naam: String(naam || "").slice(0, 120), adAccountId: metaActId(adAccountId) };
  await env.CLIENTS.put(key, JSON.stringify(rec));
  return { key, ...rec };
}
async function kvGetClient(env, key) {
  if (!env.CLIENTS || !key) return null;
  const raw = await env.CLIENTS.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}
async function kvListClients(env) {
  if (!env.CLIENTS) return [];
  const uit = [];
  const list = await env.CLIENTS.list({ limit: 1000 });
  for (const k of list.keys || []) {
    const rec = await kvGetClient(env, k.name);
    if (rec) uit.push({ key: k.name, naam: rec.naam, adAccountId: rec.adAccountId });
  }
  return uit;
}
async function kvDeleteClient(env, key) {
  if (!env.CLIENTS || !key) return false;
  await env.CLIENTS.delete(key);
  return true;
}

// ---- Meta Graph-helpers (server-to-server, system-token + appsecret_proof) ----
async function metaGraphGet(env, path, params) {
  const token = env.META_SYSTEM_TOKEN;
  const proof = await appsecretProof(token, env.META_APP_SECRET);
  const qs = new URLSearchParams(params || {});
  qs.set("access_token", token);
  qs.set("appsecret_proof", proof);
  const resp = await fetch(META_GRAPH_BASE + path + "?" + qs.toString());
  if (!resp.ok) return null;
  return resp.json();
}

// Normaliseer een ad-account-id naar "act_<cijfers>".
export function metaActId(id) {
  const s = String(id || "").trim();
  if (!s) return "";
  return /^act_/.test(s) ? s : "act_" + s.replace(/\D/g, "");
}

// Ruwe Graph-ad-account-nodes → [{act, id, name}] (DIR-40).
function shapeMetaAccounts(data) {
  return (data && data.data || []).map((a) => ({ act: metaActId(a.id || a.account_id), id: a.account_id || metaActId(a.id).replace(/^act_/, ""), name: a.name || a.id }));
}

// Ad-accounts die het system-token ziet (primair me/adaccounts, fallback BM) — DIR-40 AC-1.
const META_BUSINESS_ID = "360632044272098"; // Business Manager "Dirk Doet"
async function fetchMetaAdAccounts(env) {
  const mine = await metaGraphGet(env, "/me/adaccounts", { fields: "account_id,name", limit: "500" });
  let accounts = mine ? shapeMetaAccounts(mine) : [];
  if (accounts.length === 0) {
    // Fallback: via Business Manager (client + owned ad-accounts).
    const bizId = env.META_BUSINESS_ID || META_BUSINESS_ID;
    const merged = {};
    for (const edge of ["client_ad_accounts", "owned_ad_accounts"]) {
      const bm = await metaGraphGet(env, "/" + bizId + "/" + edge, { fields: "account_id,name", limit: "500" });
      for (const a of shapeMetaAccounts(bm)) merged[a.act] = a;
    }
    accounts = Object.values(merged);
  }
  return accounts;
}

// Query-params voor act_<id>/insights. time_range als APARTE params (AC-4).
export function buildMetaInsightsParams(args, now) {
  const a = args || {};
  const days = clamp(a.days, 1, 365, 28);
  const { startDate, endDate } = dateRange(days, now);
  const level = ["account", "campaign"].includes(a.level) ? a.level : "campaign";
  const p = {
    level,
    fields: "campaign_name,spend,impressions,clicks,reach,ctr,cpc,actions",
    limit: String(clamp(a.row_limit, 1, 50, 15)),
  };
  p["time_range[since]"] = startDate;
  p["time_range[until]"] = endDate;
  return p;
}

// Meta-insights-rijen → compact formaat.
export function shapeMetaInsights(rows) {
  return (rows || []).map((r) => {
    const acties = Array.isArray(r.actions) ? r.actions.reduce((t, x) => t + Number(x.value || 0), 0) : 0;
    return {
      campagne: r.campaign_name || "(account)",
      spend: Math.round(Number(r.spend || 0) * 100) / 100,
      impressies: Math.round(Number(r.impressions || 0)),
      clicks: Math.round(Number(r.clicks || 0)),
      bereik: Math.round(Number(r.reach || 0)),
      ctr: Math.round(Number(r.ctr || 0) * 100) / 100,
      cpc: Math.round(Number(r.cpc || 0) * 100) / 100,
      resultaten: Math.round(acties * 10) / 10,
    };
  });
}

// Tool waarmee Ilona live Meta-cijfers ophaalt voor het klant-account (AC-5).
export function metaTool() {
  return {
    name: "meta_report",
    description:
      "Haal live Meta (Facebook/Instagram) Ads-cijfers op voor het account van deze klant: spend, " +
      "impressies, klikken, bereik, CTR, CPC en resultaten, per campagne. Gebruik dit voor vragen " +
      "over Meta-advertenties. Benoem duidelijk dat het om Meta gaat.",
    input_schema: {
      type: "object",
      properties: {
        level: { type: "string", enum: ["campaign", "account"], description: "Detailniveau." },
        days: { type: "integer", description: "Aantal dagen terug (default 28, max 365)." },
        row_limit: { type: "integer", description: "Max rijen (default 15, max 50)." },
      },
      required: [],
    },
  };
}

// Tool-call: Meta-insights live ophalen voor het (KV-gescopte) account (AC-4).
async function fetchMetaInsights(env, act, args) {
  const actId = metaActId(act);
  if (!actId) return { error: "Geen Meta-account gekoppeld voor deze klant." };
  const data = await metaGraphGet(env, "/" + actId + "/insights", buildMetaInsightsParams(args, Date.now()));
  if (!data) return { error: "Kon deze Meta-data niet ophalen bij Facebook." };
  return { rijen: shapeMetaInsights(data.data) };
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
const ANALYSIS_PROMPT = AGENT_INSTRUCTIES.albert.analyse;

export function firstAnalysisPrompt() {
  return ANALYSIS_PROMPT;
}

// Systeemprompt: Albert (GSC). Instructie-tekst staat bovenin bij AGENT_INSTRUCTIES.
export function buildSystemPrompt(gsc) {
  const data = gsc ? JSON.stringify(gsc, null, 2) : "(nog geen data geladen)";
  return AGENT_INSTRUCTIES.albert.persona.concat([data]).join("\n");
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

    // GA4/Gertjan-sessiestate (DIR-28): aparte keys (ga4, ga4messages) zodat de
    // GSC/Albert-flow ongemoeid blijft. Elke aanraking vernieuwt activiteit + alarm.
    if (url.pathname === "/chat/state-ga4") {
      const data = await this.state.storage.get(["token", "lastActive", "ga4messages", "ga4"]);
      const token = data.get("token");
      if (!token || isExpired(data.get("lastActive"), now)) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ token: null }, 404);
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ token, messages: data.get("ga4messages") || [], ga4: data.get("ga4") || null });
    }

    if (url.pathname === "/chat/select-ga4") {
      const { ga4 } = await request.json();
      await this.state.storage.put({ ga4, ga4messages: [], lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/chat/append-ga4") {
      const { messages } = await request.json();
      const bestaand = (await this.state.storage.get("ga4messages")) || [];
      const nieuw = bestaand.concat(messages || []);
      await this.state.storage.put({ ga4messages: nieuw, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    // Ads/Ilona-sessiestate (DIR-30): aparte keys (ads, adsmessages).
    if (url.pathname === "/chat/state-ads") {
      const data = await this.state.storage.get(["token", "lastActive", "adsmessages", "ads"]);
      const token = data.get("token");
      if (!token || isExpired(data.get("lastActive"), now)) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ token: null }, 404);
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ token, messages: data.get("adsmessages") || [], ads: data.get("ads") || null });
    }

    if (url.pathname === "/chat/select-ads") {
      const { ads } = await request.json();
      await this.state.storage.put({ ads, adsmessages: [], lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    if (url.pathname === "/chat/append-ads") {
      const { messages } = await request.json();
      const bestaand = (await this.state.storage.get("adsmessages")) || [];
      const nieuw = bestaand.concat(messages || []);
      await this.state.storage.put({ adsmessages: nieuw, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    // Anton (content) sessie-historie (DIR-39): geen token nodig.
    if (url.pathname === "/chat/state-content") {
      const data = await this.state.storage.get(["lastActive", "contentmessages"]);
      if (isExpired(data.get("lastActive"), now)) {
        return json({ messages: [] });
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ messages: data.get("contentmessages") || [] });
    }

    if (url.pathname === "/chat/append-content") {
      const { messages } = await request.json();
      const bestaand = (await this.state.storage.get("contentmessages")) || [];
      const nieuw = bestaand.concat(messages || []);
      await this.state.storage.put({ contentmessages: nieuw, lastActive: now });
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    // Sessie aanmaken/aanraken zonder Google-token (voor klant-magic-link, DIR-30).
    if (url.pathname === "/touch") {
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ ok: true });
    }

    // Ilona-sessiestate die ook zonder Google-token werkt (klant-sessie).
    if (url.pathname === "/chat/state-ilona") {
      const data = await this.state.storage.get(["token", "lastActive", "adsmessages", "ads"]);
      if (isExpired(data.get("lastActive"), now)) {
        await this.state.storage.deleteAll();
        await this.state.storage.deleteAlarm();
        return json({ token: null }, 404);
      }
      await this.state.storage.put("lastActive", now);
      await this.state.storage.setAlarm(now + SESSION_TTL_MS);
      return json({ token: data.get("token") || null, messages: data.get("adsmessages") || [], ads: data.get("ads") || null });
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

// ------------------------------------------------- GA4-fetchers (DIR-28) ---

// GA4-properties van het account (Admin API accountSummaries) → [{property, displayName}].
async function fetchGa4Properties(token) {
  const resp = await fetch(GA4_ADMIN_BASE + "/accountSummaries?pageSize=200", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  const uit = [];
  for (const acc of data.accountSummaries || []) {
    for (const ps of acc.propertySummaries || []) {
      uit.push({ property: ps.property, displayName: ps.displayName || ps.property });
    }
  }
  return uit;
}

// Eén runReport uitvoeren (Data API) voor een property + body → JSON of null.
async function runGa4Report(token, property, body) {
  const pid = ga4PropertyId(property);
  if (!pid) return null;
  const resp = await fetch(GA4_DATA_BASE + "/properties/" + pid + ":runReport", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return null;
  return resp.json();
}

// Tool-call: één metric + één dimensie live ophalen voor de gekozen property.
async function fetchGa4Query(token, property, args) {
  if (!property) return { error: "Geen property gekozen." };
  const body = buildGa4ReportBody(args, Date.now());
  const report = await runGa4Report(token, property, body);
  if (!report) return { error: "Kon deze GA4-data niet ophalen bij Google." };
  const dim = body.dimensions[0].name;
  return {
    periode: { van: body.dateRanges[0].startDate, tot: body.dateRanges[0].endDate },
    dimensie: dim,
    metric: body.metrics[0].name,
    rijen: shapeGa4Rows(report.rows, dim),
  };
}

// Totalen (users/sessies/pageviews/conversies) voor een periode, zonder dimensie.
async function fetchGa4Totals(token, property, startDate, endDate) {
  const report = await runGa4Report(token, property, {
    dateRanges: [{ startDate, endDate }],
    metrics: GA4_METRICS.map((name) => ({ name })),
  });
  if (!report) return null;
  return shapeGa4Totals(report);
}

// Volledige eerste-analyse-data voor één property: totalen deze + vorige 28 dagen
// (met trend), top pagina's en top kanalen (AC-5).
async function fetchGa4Overview(token, property) {
  const now = Date.now();
  const cur = dateRange("28", now);
  const prev = previousDateRange("28", now);
  const [curTot, prevTot, pagesRep, chanRep] = await Promise.all([
    fetchGa4Totals(token, property, cur.startDate, cur.endDate),
    fetchGa4Totals(token, property, prev.startDate, prev.endDate),
    runGa4Report(token, property, {
      dateRanges: [{ startDate: cur.startDate, endDate: cur.endDate }],
      dimensions: [{ name: "pagePath" }], metrics: [{ name: "screenPageViews" }],
      limit: 10, orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
    }),
    runGa4Report(token, property, {
      dateRanges: [{ startDate: cur.startDate, endDate: cur.endDate }],
      dimensions: [{ name: "sessionDefaultChannelGroup" }], metrics: [{ name: "sessions" }],
      limit: 10, orderBys: [{ metric: { metricName: "sessions" }, desc: true }],
    }),
  ]);
  if (!curTot || !prevTot) return null;
  return {
    periode: { van: cur.startDate, tot: cur.endDate },
    vorige_periode: { van: prev.startDate, tot: prev.endDate },
    totalen: curTot,
    vorige_totalen: prevTot,
    trend: computeGa4Trend(curTot, prevTot),
    top_paginas: shapeGa4Rows(pagesRep && pagesRep.rows, "pagePath"),
    kanalen: shapeGa4Rows(chanRep && chanRep.rows, "kanaal"),
  };
}

// -------------------------------------------- Google Ads-fetchers (DIR-30) ---

// Headers voor de Google Ads API: Bearer + developer-token (+ login-customer-id).
function adsHeaders(token, env, loginCid) {
  const h = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
    "developer-token": env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
  };
  if (loginCid) h["login-customer-id"] = adsCustomerId(loginCid);
  return h;
}

// Leest een Google Ads-foutrespons uit → korte NL-melding (DIR-43, AC-3).
// Slikt niets meer in: status + api-message tonen, ruwe body server-side loggen.
async function adsErrorMessage(resp) {
  let body = "";
  try { body = await resp.text(); } catch (e) { /* body niet leesbaar */ }
  console.log("Google Ads API-fout", resp.status, body);
  let apiMsg = "";
  try {
    const j = JSON.parse(body);
    const err = j && j.error;
    apiMsg = (err && err.message) ||
      (err && err.details && err.details[0] && err.details[0].errors &&
        err.details[0].errors[0] && err.details[0].errors[0].message) || "";
  } catch (e) { /* geen JSON-body */ }
  const s = resp.status;
  if (s === 401) return "Google Ads gaf een fout (401): je toegang is verlopen — koppel je Google-account opnieuw.";
  if (s === 403) return "Google Ads gaf een fout (403): " + (apiMsg || "geen toegang of de vereiste rechten/scope ontbreken.");
  return "Google Ads gaf een fout (" + s + "): " + (apiMsg || "onbekende fout.");
}

// GAQL om (sub)accounts onder een (MCC-)account te vinden (DIR-43, AC-1).
const ADS_CLIENT_QUERY =
  "SELECT customer_client.id, customer_client.descriptive_name, customer_client.manager, customer_client.level " +
  "FROM customer_client WHERE customer_client.level <= 1";

// Toegankelijke Google Ads-accounts → { accounts:[{customer,id,naam,loginCid}] } of { error }.
// Traverseert elke toegankelijke (MCC-)account via customer_client en geeft de niet-manager
// subaccounts terug, met loginCid = de MCC-id waaronder ze hangen. Losse accounts blijven werken.
async function fetchAdsCustomers(token, env) {
  const resp = await fetch(GADS_BASE + "/customers:listAccessibleCustomers", { headers: adsHeaders(token, env) });
  if (!resp.ok) return { error: await adsErrorMessage(resp) };
  const data = await resp.json();
  const managers = data.resourceNames || [];
  if (!managers.length) return { error: "Google Ads vond geen toegankelijke accounts in je koppeling." };

  const clients = [];
  const seen = new Set();
  let anyOk = false, lastErr = null;
  for (const rn of managers) {
    const mccId = adsCustomerId(rn);
    const res = await runAdsSearch(token, env, rn, ADS_CLIENT_QUERY, mccId);
    if (!res || res.error) { lastErr = (res && res.error) || lastErr; continue; }
    anyOk = true;
    for (const row of res.results || []) {
      const cc = row.customerClient || {};
      if (cc.manager === true) continue;                 // MCC's/managers overslaan — geen ad-account
      const cid = String(cc.id || "").trim();
      if (!cid || seen.has(cid)) continue;               // ontdubbelen op client-id
      seen.add(cid);
      clients.push({ customer: "customers/" + cid, id: cid, naam: cc.descriptiveName || "", loginCid: mccId });
    }
  }
  if (!clients.length) {
    if (!anyOk && lastErr) return { error: lastErr };     // echte API-fout, niet "geen accounts"
    return { error: "Google Ads vond geen advertentie-accounts onder je koppeling." };
  }
  return { accounts: clients };
}

// Eén GAQL-query uitvoeren (googleAds:search) → JSON, of { error } bij een API-fout.
// loginCid = de manager/MCC-id die als login-customer-id mee moet (AC-2); valt terug op het account zelf.
async function runAdsSearch(token, env, customer, query, loginCid) {
  const cid = adsCustomerId(customer);
  if (!cid) return { error: "Geen geldig Google Ads-account-id." };
  const resp = await fetch(GADS_BASE + "/customers/" + cid + "/googleAds:search", {
    method: "POST",
    headers: adsHeaders(token, env, loginCid || customer),
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) return { error: await adsErrorMessage(resp) };
  return resp.json();
}

// Tool-call: een rapport live ophalen voor het gekozen account.
async function fetchAdsReport(token, env, customer, args, loginCid) {
  if (!customer) return { error: "Geen account gekozen." };
  const q = buildAdsQuery(args, Date.now());
  const data = await runAdsSearch(token, env, customer, q.query, loginCid);
  if (!data) return { error: "Kon deze Google Ads-data niet ophalen bij Google." };
  if (data.error) return { error: data.error };
  return { periode: { van: q.startDate, tot: q.endDate }, rapport: q.report, rijen: shapeAdsRows(data.results, q.jsonPath) };
}

// Eerste-analyse-data: campagne-totalen + top campagnes van de laatste 28 dagen (AC-5).
async function fetchAdsOverview(token, env, customer, loginCid) {
  const q = buildAdsQuery({ report: "campaigns", days: 28, row_limit: 15 }, Date.now());
  const data = await runAdsSearch(token, env, customer, q.query, loginCid);
  if (!data || data.error) return null;
  const rows = shapeAdsRows(data.results, q.jsonPath);
  return {
    periode: { van: q.startDate, tot: q.endDate },
    totalen: sumAdsRows(rows),
    top_campagnes: rows.slice(0, 10),
  };
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

async function callAnthropic(env, system, messages, tools) {
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
      tools: tools || [gscTool()],
    }),
  });
  if (!resp.ok) return null;
  return resp.json();
}

// Verpakt platte tekst als een SSE-stream die de bestaande frontend (content_block_delta) leest.
function sseResponse(text, extraHeaders) {
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
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", ...(extraHeaders || {}) },
  });
}

// ── DIR-47/48/49 · Gedeelde iso-scène (Habbo-lat): kamer-shell + meubels +
// agents + hond. Stuk 3 (DIR-49) integreert deze iso-scène als de ECHTE scène
// op route `/` (OFFICE_HTML); alle bestaande chat/OAuth/portret-logica blijft.
// Echte 2:1 iso-projectie, vloer-dominant, één lichtrichting (links-boven),
// vlakke kleuren, crispe randen, back-to-front.
const ISO = { Ox: 320, Oy: 120, TW: 40, TH: 20, N: 9, H: 72 };
const isoX = (i, j) => ISO.Ox + (i - j) * (ISO.TW / 2);
const isoY = (i, j, z) => ISO.Oy + (i + j) * (ISO.TH / 2) - z;
// Tegel → %-positie binnen de 16:9 scène-wrap (voor de hond-overlay in OFFICE).
const isoPct = (i, j) => ({
  l: +(isoX(i, j) / 640 * 100).toFixed(2),
  b: +(((360 - isoY(i, j, 0)) / 360 * 100).toFixed(2)),
});
// 4 agents: bureau-tegel (i0,j0) + sta-tegel achter het bureau, sprite + kleuren.
// De id's blijven gelijk aan de front-scène zodat de bestaande klik/keyboard-
// binding (openAgent gsc/ga4/ads/anton) ongewijzigd blijft werken.
const ISO_DESKS = [
  { id: "agent-desk", key: "gsc", naam: "Albert", spec: "GSC / SEO-specialist", sym: "albert", i0: 1.5, j0: 1.3, tag: "#F18E02", dot: "#3fd06a", label: "de GSC-agent" },
  { id: "gertjan-desk", key: "ga4", naam: "Gertjan", spec: "GA4-data-specialist", sym: "gertjan", i0: 1.5, j0: 4.8, tag: "#3fd06a", dot: "#3fd06a", label: "de GA4-agent Gertjan" },
  { id: "ilona-desk", key: "ads", naam: "Ilona", spec: "Google Ads-specialist", sym: "ilona", i0: 5.0, j0: 1.3, tag: "#e58fa8", dot: "#e58fa8", label: "de Ads-agent Ilona" },
  { id: "anton-desk", key: "anton", naam: "Anton", spec: "Content-specialist", sym: "anton", i0: 5.0, j0: 4.8, tag: "#3285D1", dot: "#3fd06a", label: "de content-agent Anton" },
];
const ISO_MAND = { i0: 5.6, j0: 7.4 };            // hondenmand-tegel (hond BED-doel)
const isoAgentFeet = (d) => ({ i: d.i0 + 0.9, j: d.j0 - 0.6 }); // sta-tegel achter bureau

function isoRoomInner() {
  // Vloer-dominant + warme chunky tegels, lage muren; 4 bureaus in strak 2×2
  // blok met gangpad; agents op hun sta-tegel (achter het bureau, occlusie via
  // back-to-front). 2:1 iso, achter-hoek, licht links-boven, crispe randen.
  const Ox = ISO.Ox, Oy = ISO.Oy, TW = ISO.TW, TH = ISO.TH, N = ISO.N, H = ISO.H;
  const X = isoX, Y = isoY;
  const P = (i, j, z) => X(i, j) + "," + Y(i, j, z);
  const poly = (pts, fill, extra) =>
    '<polygon points="' + pts.join(" ") + '" fill="' + fill + '"' + (extra || "") + "/>";
  const pline = (pts, stroke, w) =>
    '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + stroke +
    '" stroke-width="' + w + '"/>';
  const line = (x1, y1, x2, y2, stroke, w, op) =>
    '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 +
    '" stroke="' + stroke + '" stroke-width="' + w + '" opacity="' + op + '"/>';

  // Palet — warme vloer (hoofdvlak) + blauwe muren (huisstijl-contrast). Eén
  // lichtrichting links-boven: bevel licht op noord/west-tegelranden, donker
  // op zuid/oost. Vlakke kleuren, geen gradients.
  // DIR-61: betonlook-grijze vloer (koele tinten) i.p.v. warme houttegels.
  const tileA = "#b7bbc0", tileB = "#abafb4", tilePop = "#c2c6ca"; // beton-dambord (subtiele variatie)
  const bevelL = "#ccd0d4", bevelD = "#888c91";                    // tegel-volume (licht/schaduw)
  const wallLit = "#3a6ea0", wallDark = "#29517a";                 // muur-vlakken
  const capLit = "#cdd9e4", capDark = "#bcc9d6";                   // muur-bovenkant
  const skirtL = "#1c3a58", skirtR = "#173049";                    // plint
  const brick = "#20456a";                                         // baksteen-voegen
  const ORANJE = "#F18E02", ORANJE_D = "#c9760a";                  // huisstijl-accent

  let sFloor = "", sWall = "";

  // VLOER — groot ruit-grid van chunky warme tegels met per-tegel bevel:
  // noord/west-randen licht (vangen top-links licht), zuid/oost-randen donker.
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      let col = ((i + j) % 2 === 0) ? tileA : tileB;
      if ((i * 7 + j * 5) % 6 === 0) col = tilePop; // subtiele warme toon-variatie
      const T = P(i, j, 0), R = P(i + 1, j, 0), B = P(i + 1, j + 1, 0), L = P(i, j + 1, 0);
      sFloor += poly([T, R, B, L], col);
      sFloor += pline([L, T, R], bevelL, 1.5); // noord/west-randen — licht
      sFloor += pline([R, B, L], bevelD, 1.5); // zuid/oost-randen — schaduw
    }
  }
  // Vloer-rand (diamant-omtrek) crisp grijs kader.
  sFloor += poly([P(0, 0, 0), P(N, 0, 0), P(N, N, 0), P(0, N, 0)],
    "none", ' stroke="#6b6f74" stroke-width="2"');

  // DIR-61: Oosters/Perzisch tapijt links-vóór, plat op de vloer (iso-geprojecteerd,
  // ~2×3 tegels), warm rood/blauw met rand + middenmotief. Los van de hondenmand.
  // In sFloor → ligt onder de meubels/agents; die lopen er correct overheen.
  (function(){
    const ri = 3.0, rj = 5.4, rw = 2.0, rh = 3.0;          // links-vóór, vrij van bureaus/mand
    const inset = (a, b, m) => [P(ri + m, rj + m, 0), P(ri + rw - m, rj + m, 0),
      P(ri + rw - m, rj + rh - m, 0), P(ri + m, rj + rh - m, 0)];
    sFloor += poly(inset(0, 0, 0.0), "#2c4a7a");           // blauwe rand-basis
    sFloor += poly(inset(0, 0, 0.28), "#8a2f2f");          // rood veld
    sFloor += poly(inset(0, 0, 0.5), "none", ' stroke="#d9b45a" stroke-width="1"'); // gouden lijn
    // Midden-medaillon (ruit) — goud + blauw hart.
    const cx = ri + rw / 2, cj = rj + rh / 2;
    sFloor += poly([P(cx, cj - 0.55, 0), P(cx + 0.5, cj, 0), P(cx, cj + 0.55, 0), P(cx - 0.5, cj, 0)], "#d9b45a");
    sFloor += poly([P(cx, cj - 0.32, 0), P(cx + 0.29, cj, 0), P(cx, cj + 0.32, 0), P(cx - 0.29, cj, 0)], "#2c4a7a");
  })();

  // RECHTER MUUR (vlak j=0) — schaduw.
  sWall += poly([P(0, 0, 0), P(N, 0, 0), P(N, 0, H), P(0, 0, H)], wallDark);
  // LINKER MUUR (vlak i=0) — verlicht.
  sWall += poly([P(0, 0, 0), P(0, N, 0), P(0, N, H), P(0, 0, H)], wallLit);

  // Baksteen-voegen (subtiele horizontale iso-lijnen per muur).
  for (let k = 1; k <= 2; k++) {
    const z = k * 24;
    sWall += line(X(0, 0), Y(0, 0, z), X(0, N), Y(0, N, z), brick, 1, 0.35); // links
    sWall += line(X(0, 0), Y(0, 0, z), X(N, 0), Y(N, 0, z), "#12365a", 1, 0.35); // rechts
  }

  // Plint (donkere band onderaan elke muur) — Habbo-detail, diepte-anker.
  sWall += poly([P(0, 0, 0), P(0, N, 0), P(0, N, 6), P(0, 0, 6)], skirtL);
  sWall += poly([P(0, 0, 0), P(N, 0, 0), P(N, 0, 6), P(0, 0, 6)], skirtR);

  // Oranje huisstijl-accentstrip net onder de muur-bovenkant.
  sWall += poly([P(0, 0, H - 10), P(0, N, H - 10), P(0, N, H - 5), P(0, 0, H - 5)], ORANJE);
  sWall += poly([P(0, 0, H - 10), P(N, 0, H - 10), P(N, 0, H - 5), P(0, 0, H - 5)], ORANJE_D);

  // Muur-bovenkant (dikte) — top-vlakken, lichtst.
  sWall += poly([
    X(0, 0) + "," + Y(0, 0, H), X(0, N) + "," + Y(0, N, H),
    (X(0, N) - 7) + "," + (Y(0, N, H) - 3.5), (X(0, 0) - 7) + "," + (Y(0, 0, H) - 3.5)
  ], capLit); // linker cap (extrude -eX)
  sWall += poly([
    X(0, 0) + "," + Y(0, 0, H), X(N, 0) + "," + Y(N, 0, H),
    (X(N, 0) + 7) + "," + (Y(N, 0, H) - 3.5), (X(0, 0) + 7) + "," + (Y(0, 0, H) - 3.5)
  ], capDark); // rechter cap (extrude -eY)

  // Achter-hoek — verticale naad waar de 2 muren samenkomen, crisp benadrukt.
  sWall += line(X(0, 0), Y(0, 0, 0), X(0, 0), Y(0, 0, H), "#0f2e4d", 1.5, 0.9);

  // ── DIR-52 · Dirk-identiteit op de iso-muren ───────────────────────────────
  // Decals geschoren op de wand-vlakken: rechter muur helt down-right (matrix
  // a=1,b=0.5), linker muur down-left (a=-1,b=0.5); oorsprong = achter-boven-
  // hoek (320,48). Baksteen (url(#brick)) + graffiti (huisstijl) + hex-kunst +
  // hangende Edison-lampen (dd-bulb). Blijft achter de meubels (in sWall).
  const MR = 'matrix(1,0.5,0,1,320,48)';   // rechter muur-vlak
  const ML = 'matrix(-1,0.5,0,1,320,48)';  // linker muur-vlak (gespiegeld)
  // Baksteen-textuur op beide muren (subtiel, blauw blijft doorschijnen).
  sWall += '<g transform="' + MR + '" opacity="0.45"><rect x="0" y="0" width="180" height="72" fill="url(#brick)"/></g>';
  sWall += '<g transform="' + ML + '" opacity="0.45"><rect x="0" y="0" width="180" height="72" fill="url(#brick)"/></g>';
  // Graffiti op de rechter muur — arcade/pixel, huisstijlkleuren.
  sWall += '<g transform="' + MR + '" font-family="\'Press Start 2P\',monospace">'
    + '<text x="12" y="18" font-size="8" fill="#F18E02">CREATIVITY</text>'
    + '<text x="8" y="30" font-size="8" fill="#F18E02">NEVER DIES</text>'
    + '<text x="30" y="46" font-size="10" fill="#3285D1">DREAM BIG</text>'
    + '<text x="14" y="60" font-size="6.5" fill="#e8e2d8">NO PAIN NO GAIN</text>'
    + '</g>';
  // Hex-wandkunst op de linker muur — honingraat met kleurvlakken + oranje rand.
  const hexPts = [[38, 10], [60, 10], [49, 26], [71, 26], [38, 42], [60, 42]];
  const hexCol = ["#c98a5a", "#8aa0b5", "#b56a4a", "#7d9c6a", "#9a8fb5", "#c9a05a"];
  let hexG = '<g transform="' + ML + '">';
  hexPts.forEach((p, idx) => {
    hexG += '<use href="#hex" x="' + p[0] + '" y="' + p[1] + '" width="22" height="20"/>';
    hexG += '<rect x="' + (p[0] + 6) + '" y="' + (p[1] + 5) + '" width="10" height="10" fill="' + hexCol[idx] + '"/>';
  });
  hexG += '</g>';
  sWall += hexG;
  // Hangende Edison-lampen (snoer + fitting + flikkerende bulb) langs de achterrand.
  const lamps = [[236, 44], [320, 40], [404, 44]];
  lamps.forEach((p, idx) => {
    sWall += '<rect x="' + p[0] + '" y="' + (p[1] - 8) + '" width="1.5" height="18" fill="#0a0a0a"/>';
    sWall += '<rect x="' + (p[0] - 4) + '" y="' + (p[1] + 10) + '" width="9" height="7" fill="#3a2f18"/>';
    sWall += '<rect x="' + (p[0] - 3) + '" y="' + (p[1] + 16) + '" width="7" height="8" fill="#ffb733" style="animation:dd-bulb ' + (3 + idx * 0.4).toFixed(1) + 's ease-in-out infinite"/>';
  });

  // ── DIR-48 · iso-meubels & props op het grid (stuk 2) ──────────────────────
  // Chunky volumes (top + 2 zijvlakken), zelfde lichthoek (top lichtst, SW-zij
  // licht, SE-zij donker), contactschaduw per object, back-to-front getekend.
  const circ = (cx, cy, r, fill) =>
    '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"/>';
  const ell = (cx, cy, rx, ry, fill) =>
    '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry + '" fill="' + fill + '"/>';
  const shadow = (i0, j0, wi, wj) => {
    const m = 0.12;
    return poly([P(i0 + m, j0 + m, 0), P(i0 + wi - m, j0 + m, 0),
      P(i0 + wi - m, j0 + wj - m, 0), P(i0 + m, j0 + wj - m, 0)], "#000000", ' opacity="0.16"');
  };
  // chunky iso-box: SE-zijvlak (donker) + SW-zijvlak (licht) + top-vlak (lichtst).
  const box = (i0, j0, wi, wj, z0, z1, top, left, right) => {
    const se = poly([P(i0 + wi, j0, z0), P(i0 + wi, j0 + wj, z0),
      P(i0 + wi, j0 + wj, z1), P(i0 + wi, j0, z1)], right);
    const sw = poly([P(i0, j0 + wj, z0), P(i0 + wi, j0 + wj, z0),
      P(i0 + wi, j0 + wj, z1), P(i0, j0 + wj, z1)], left);
    const tp = poly([P(i0, j0, z1), P(i0 + wi, j0, z1),
      P(i0 + wi, j0 + wj, z1), P(i0, j0 + wj, z1)], top);
    return se + sw + tp;
  };

  // Ronde 2 (Craft-gap): chunkier + hoger meubilair (meer presence), strakke
  // 2×2 grid-ordening met gangpad, compactere vloer (N 11→9) → voller, minder
  // dode vloer. Vaste footprints zodat de 4 bureaus exact even groot zijn.
  const DW = 2.4, DD = 1.4, DH = 18; // bureau: breed×diep×hoog
  const desk = (i0, j0) => {
    let g = shadow(i0, j0, DW, DD);
    g += box(i0, j0, DW, DD, 0, DH, "#b07a34", "#9c6a2b", "#855620"); // hout-bureau
    const mi = i0 + 0.85, mj = j0 + 0.28, mw = 0.9, md = 0.42, z0 = DH, z1 = DH + 13;
    // Toetsenbord aan de AGENT-kant (DIR-55): tussen het zittende poppetje (lage j)
    // en de monitor, dus vóór de monitor getekend zodat de monitor het deels
    // verdekt — logisch correct (agent → toetsenbord → monitor).
    g += poly([P(i0 + 0.82, j0 + 0.04, DH), P(i0 + 1.40, j0 + 0.04, DH),
      P(i0 + 1.40, j0 + 0.24, DH), P(i0 + 0.82, j0 + 0.24, DH)], "#262b31");
    g += poly([P(i0 + 0.82, j0 + 0.04, DH), P(i0 + 1.40, j0 + 0.04, DH),
      P(i0 + 1.40, j0 + 0.08, DH), P(i0 + 0.82, j0 + 0.08, DH)], "#3a414a"); // bovenrand
    g += '<line x1="' + X(i0 + 0.88, j0 + 0.14) + '" y1="' + Y(i0 + 0.88, j0 + 0.14, DH) + '" x2="' + X(i0 + 1.34, j0 + 0.14) + '" y2="' + Y(i0 + 1.34, j0 + 0.14, DH) + '" stroke="#4a525c" stroke-width="0.6"/>';
    g += box(mi, mj, mw, md, z0, z1, "#2a2f3a", "#20242c", "#181b21"); // monitor-body (occludeert toetsenbord-voorkant)
    // scherm-vlak (SW, naar voren), huisstijl-blauw + oranje stip
    g += poly([P(mi, mj + md, z0 + 2), P(mi + mw, mj + md, z0 + 2),
      P(mi + mw, mj + md, z1 - 2), P(mi, mj + md, z1 - 2)], "#015092");
    g += circ(X(mi + mw * 0.5, mj + md), Y(mi + mw * 0.5, mj + md, (z0 + z1) / 2), 2, "#F18E02");
    return g;
  };
  const sofa = (i0, j0) => {
    let g = shadow(i0, j0, 1.5, 2.2);
    g += box(i0, j0, 1.5, 2.2, 0, 13, "#d9a520", "#c48f16", "#a67810");     // zitting mosterd
    g += box(i0, j0, 0.5, 2.2, 0, 24, "#c99a1a", "#b3860f", "#96700c");     // rugleuning (achter)
    g += box(i0, j0, 1.5, 0.35, 0, 20, "#cf9d1c", "#b98a12", "#9c760f");    // armleuning (rechts)
    return g;
  };
  const printer = (i0, j0) => {
    let g = shadow(i0, j0, 1.1, 1.1);
    g += box(i0, j0, 1.1, 1.1, 0, 15, "#d8dde3", "#c2c8d0", "#a7aeb8");
    g += pline([P(i0 + 0.2, j0 + 0.35, 15), P(i0 + 0.9, j0 + 0.35, 15)], "#8a929c", 2); // papiergleuf
    return g;
  };
  const koffie = (i0, j0) => {
    let g = shadow(i0, j0, 1.0, 1.0);
    g += box(i0, j0, 1.0, 1.0, 0, 24, "#33383f", "#262b31", "#1b1f24");
    g += circ(X(i0 + 0.5, j0 + 1.0), Y(i0 + 0.5, j0 + 1.0, 15), 2, "#F18E02"); // lampje
    return g;
  };
  const kast = (i0, j0) => { // archiefkast — vult zijstrook, meer 'ingericht'
    let g = shadow(i0, j0, 1.1, 1.1);
    g += box(i0, j0, 1.1, 1.1, 0, 20, "#3a6ea0", "#2f5c87", "#244a6e"); // huisstijl-blauw
    g += pline([P(i0 + 0.15, j0 + 1.1, 13), P(i0 + 0.95, j0 + 1.1, 13)], "#8fb4d6", 2); // lade-lijn
    return g;
  };
  const plant = (i0, j0) => {
    let g = shadow(i0, j0, 0.8, 0.8);
    g += box(i0 + 0.15, j0 + 0.15, 0.5, 0.5, 0, 10, "#b5623a", "#9c4f2d", "#813f22"); // pot
    const cx = X(i0 + 0.4, j0 + 0.4), cy = Y(i0 + 0.4, j0 + 0.4, 10);
    g += circ(cx, cy - 13, 8.5, "#357033");
    g += circ(cx - 6, cy - 7, 6.5, "#4f9247");
    g += circ(cx + 6, cy - 9, 6.5, "#3f7d3a");
    return g;
  };
  const mand = (i0, j0) => {
    let g = shadow(i0, j0, 1.2, 1.0);
    const cx = X(i0 + 0.6, j0 + 0.5), cy = Y(i0 + 0.6, j0 + 0.5, 0);
    g += ell(cx, cy, 24, 12, "#6b4423");
    g += ell(cx, cy - 4, 20, 10, "#7d5230");
    g += ell(cx, cy - 4, 15, 7, "#4a2f18");
    g += ell(cx, cy - 5, 14, 6, "#caa06a"); // kussen
    return g;
  };

  // Agent-sprite op zijn sta-tegel achter het bureau (bestaande #-symbolen),
  // met contactschaduw. Wordt vóór het bureau getekend zodat het bureau de
  // onderbenen occludeert (zit-illusie) — DIR-49 #1/#7.
  // Zit-sprite krijgt een id zodat de roam-JS (DIR-51) hem kan verbergen terwijl
  // de agent rondloopt (bureau leeg, geen dubbel). class iso-seat voor rekken.
  const agentSprite = (d) => {
    const f = isoAgentFeet(d);
    const fx = X(f.i, f.j), fy = Y(f.i, f.j, 0);
    let g = '<g id="iso-seat-' + d.key + '" class="iso-seat" style="transform-box:fill-box;transform-origin:center bottom">';
    g += '<ellipse cx="' + fx + '" cy="' + fy + '" rx="13" ry="6" fill="#000" opacity="0.18"/>';
    // De sprite in een .typer-groep: subtiele "aan het werk"-beweging die bij het
    // poppetje hoort (DIR-54). Verborgen zit-sprite tijdens roamen → geen typen
    // aan een leeg bureau; geen losse handen (armen zitten in de sprite).
    g += '<g class="typer" style="transform-box:fill-box;transform-origin:center bottom">';
    g += '<use href="#' + d.sym + '" x="' + (fx - 15) + '" y="' + (fy - 37) + '" width="30" height="37"/>';
    g += '</g></g>';
    return g;
  };

  // Plaatsing op het grid (9×9). 4 identieke bureaus in een strak 2×2 blok
  // met kruis-gangpad; props langs de rand zodat de kamer bewust ingericht oogt.
  const objs = [];
  const put = (ci, cj, svg) => objs.push({ k: ci + cj, svg }); // sorteer op tegel-diepte
  // 2×2 bureau-blok met agents (rijen i=1.5 & 5.0, kolommen j=1.3 & 4.8).
  for (const d of ISO_DESKS) {
    const f = isoAgentFeet(d);
    put(f.i, f.j, agentSprite(d));                              // agent (achter) eerst
    put(d.i0 + DW / 2, d.j0 + DD / 2 + 0.02, desk(d.i0, d.j0)); // bureau occludeert
  }
  put(7.2 + 0.75, 6.6 + 1.1, sofa(7.2, 6.6));   // bank in voor-linker hoek
  put(7.4 + 0.5, 0.1 + 0.5, koffie(7.4, 0.1));  // koffie voor-rechter hoek
  put(0.1 + 0.55, 3.6 + 0.55, printer(0.1, 3.6)); // printer achter-midden
  put(3.8 + 0.55, 0.1 + 0.55, kast(3.8, 0.1));  // kast langs rechter zijstrook
  put(0.2 + 0.4, 0.2 + 0.4, plant(0.2, 0.2));   // plant achter-rechter hoek
  put(0.2 + 0.4, 7.6 + 0.4, plant(0.2, 7.6));   // plant achter-linker hoek
  put(5.6 + 0.6, 7.4 + 0.5, mand(5.6, 7.4));    // hondenmand bij de bank
  objs.sort((a, b) => a.k - b.k);                // back-to-front
  // DIR-53: elk object in een .dobj-laag met data-k (tegel-diepte) zodat de JS
  // de lopende agents + hond ertussen kan sorteren (restack) → correcte iso-
  // diepte tijdens beweging, nooit over een meubel heen.
  let sObj = "";
  for (const o of objs) sObj += '<g class="dobj" data-k="' + o.k.toFixed(3) + '">' + o.svg + '</g>';

  // Lopende agents (SVG-movers, verborgen tot een actie) — sprite met feet op de
  // oorsprong; JS zet style.transform=translate(feetX,feetY) + data-k + restack.
  let sMovers = "";
  for (const d of ISO_DESKS) {
    sMovers += '<g class="dobj mover roammover" id="iso-roam-' + d.key + '" data-k="0" tabindex="0" role="button" aria-label="Open ' + d.label + '" style="display:none;cursor:pointer">'
      + '<ellipse cx="0" cy="0" rx="12" ry="6" fill="#000" opacity="0.18"/>'
      + '<g class="roamfig">'
      + '<use href="#' + d.sym + '" x="-15" y="-37" width="30" height="37"/>'
      + '<g class="poot poot-a"><rect x="-6" y="-2" width="4" height="7" fill="#2a3138"/></g>'
      + '<g class="poot poot-b"><rect x="1" y="-2" width="4" height="7" fill="#2a3138"/></g>'
      // DIR-60: herkenbare draag-items (koffiekopje / papier / gieter met tuit+handvat).
      + '<g class="draag draag-koffie">'
      + '<path d="M14 -15 q3 1.5 0 4" stroke="#c9c2b4" stroke-width="1.5" fill="none"/>'   // oor
      + '<rect x="7" y="-15" width="7" height="8" rx="1" fill="#e8e2d8"/><rect x="7" y="-15" width="7" height="2" fill="#c9c2b4"/>'
      + '<rect x="9" y="-19" width="1" height="3" fill="#e8e2d8" opacity=".55"/><rect x="11.5" y="-20" width="1" height="3" fill="#e8e2d8" opacity=".55"/>' // stoom
      + '</g>'
      + '<g class="draag draag-papier"><rect x="7" y="-16" width="7" height="9" fill="#f4f0e6"/><rect x="8.5" y="-13" width="4" height="1" fill="#9aa2aa"/><rect x="8.5" y="-11" width="4" height="1" fill="#9aa2aa"/></g>'
      + '<g class="draag draag-gieter">'
      + '<rect x="6" y="-14" width="8" height="7" rx="1.5" fill="#3fa06a"/><rect x="6" y="-14" width="8" height="2" rx="1" fill="#57b97e"/>' // body
      + '<polygon points="13,-13 20,-16 20,-13.5 13.5,-10.5" fill="#2f7f56"/>'                 // tuit
      + '<rect x="19" y="-16.5" width="2.5" height="1.6" rx=".6" fill="#256a48"/>'              // sproeikop
      + '<path d="M7 -14 q3 -5 6 0" stroke="#2f7f56" stroke-width="1.6" fill="none"/>'          // handvat
      + '</g>'
      + '</g></g>';
  }
  // Hond (SVG-mover, DIR-53): ~60% schaal, feet op de oorsprong. Geneste groepen:
  // #iso-dog = positie (JS translate), .dogscale = schaal, .dogpose = zit/lig
  // (CSS), .dogfig = sprite. tail/leg-animatie op de deel-groepen.
  sMovers += '<g class="dobj mover" id="iso-dog" data-k="0"><g class="dogscale" transform="scale(0.6)"><g class="dogpose"><g class="dogfig" transform="translate(-30,-36)">'
    + '<g class="dogtail" style="transform-box:fill-box;transform-origin:right center;animation:dd-tail .5s ease-in-out infinite"><rect x="2" y="14" width="8" height="4" fill="#c99a4e"/></g>'
    + '<rect x="8" y="12" width="34" height="14" fill="#d9a441"/><rect x="8" y="12" width="34" height="4" fill="#e6b755"/>'
    + '<rect x="38" y="8" width="16" height="16" fill="#d9a441"/><rect x="38" y="8" width="16" height="4" fill="#e6b755"/>'
    + '<rect x="38" y="8" width="5" height="12" fill="#b8842f"/><rect x="52" y="16" width="6" height="6" fill="#e6b755"/>'
    + '<rect x="56" y="17" width="3" height="3" fill="#1a1a1a"/><rect x="47" y="13" width="3" height="3" fill="#2a1c0c"/>'
    + '<rect x="40" y="20" width="4" height="6" fill="#F18E02"/>'
    + '<g class="dogleg dogleg-a"><rect x="12" y="26" width="5" height="9" fill="#b8842f"/><rect x="34" y="26" width="5" height="9" fill="#b8842f"/></g>'
    + '<g class="dogleg dogleg-b"><rect x="20" y="26" width="5" height="9" fill="#c99a4e"/><rect x="42" y="26" width="5" height="9" fill="#c99a4e"/></g>'
    + '</g></g></g></g>';

  // Muren (achter) → vloer → #iso-depth (meubels/agents/movers, JS-gesorteerd).
  return '<rect x="0" y="0" width="640" height="360" fill="#2b2f36"/>' + sWall + sFloor
    + '<g id="iso-depth">' + sObj + sMovers + '</g>';
}

// Klikbare/keyboard-agent-hotspots + naamtags, bovenop de scène (DIR-49 #2).
// Elke <g id> houdt de bestaande front-scène-id's aan (agent-desk/gertjan-desk/
// ilona-desk/anton-desk) zodat de bestaande event-binding blijft werken. De
// zichtbare sprite zit in de scène (occlusie); hier de klik-hitzone + naamtag.
function isoAgentsOverlay() {
  // DIR-57 #1: dot-markers weg; klein PERMANENT label (naam · functie) boven elke
  // agent, altijd zichtbaar (vervangt de hover-only DIR-50). Hover-glow + klik +
  // aria-label blijven. Compact — mag de kamer niet domineren.
  const shortFn = { gsc: "GSC/SEO", ga4: "GA4", ads: "Google Ads", anton: "Content" };
  let s = "";
  for (const d of ISO_DESKS) {
    const f = isoAgentFeet(d);
    const fx = isoX(f.i, f.j), fy = isoY(f.i, f.j, 0);
    const headY = fy - 37;                    // bovenkant sprite
    const label = d.naam + " · " + shortFn[d.key];
    const lw = Math.max(44, Math.round(label.length * 4.3) + 10), lh = 12;
    const lx = fx - lw / 2, ly = headY - lh - 3;
    const deskFrontY = isoY(d.i0 + 2.4, d.j0 + 1.4, 0);   // voorrand bureau
    const hitH = Math.max(40, deskFrontY - ly + 8);
    s += '<g id="' + d.id + '" class="iso-agent" role="button" tabindex="0" aria-label="Open ' + d.label + ' (' + d.naam + ', ' + d.spec + ')">';
    s += '<rect x="' + (fx - 42) + '" y="' + ly + '" width="84" height="' + hitH + '" fill="#000" opacity="0"/>'; // klik-hitzone
    s += '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh + '" rx="2" fill="#0b1219" opacity="0.92"/>';
    s += '<rect x="' + lx + '" y="' + ly + '" width="' + lw + '" height="' + lh + '" rx="2" fill="none" stroke="' + d.tag + '" stroke-width="1"/>';
    s += '<text x="' + fx + '" y="' + (ly + 8.6) + '" text-anchor="middle" font-family="\'Segoe UI\',system-ui,Arial,sans-serif" font-weight="700" font-size="7" fill="#f4f0e6">' + label + '</text>';
    s += '</g>';
  }
  return s;
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
    --hond:#e0b566; --honddonker:#b98a3e;
    --leesfont:'Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif; }
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
  @keyframes dd-modal-in{from{transform:translateY(8px);opacity:0}to{transform:translateY(0);opacity:1}}
  /* Albert idle "aan het werk" (DIR-25) */
  @keyframes dd-type-l{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes dd-type-r{0%,100%{transform:translateY(-2px)}50%{transform:translateY(0)}}
  @keyframes dd-albert-idle{0%,58%,100%{transform:translateY(0)}28%{transform:translateY(-1px)}70%,82%{transform:translate(1.5px,0)}}
  .scene-wrap{ position:relative; width:min(100vw,177.78vh); aspect-ratio:16/9; max-height:100vh; }
  #agent-desk{ cursor:pointer; transition:filter .12s; }
  #agent-desk:hover, #agent-desk:focus{ outline:none;
    filter:drop-shadow(0 0 6px #F18E02) drop-shadow(0 0 14px rgba(241,142,2,.6)); }
  #gertjan-desk{ cursor:pointer; transition:filter .12s; }
  #gertjan-desk:hover, #gertjan-desk:focus{ outline:none;
    filter:drop-shadow(0 0 6px #3fd06a) drop-shadow(0 0 14px rgba(63,208,106,.6)); }
  #ilona-desk{ cursor:pointer; transition:filter .12s; }
  #ilona-desk:hover, #ilona-desk:focus{ outline:none;
    filter:drop-shadow(0 0 6px #e58fa8) drop-shadow(0 0 14px rgba(229,143,168,.6)); }
  #anton-desk{ cursor:pointer; transition:filter .12s; }
  #anton-desk:hover, #anton-desk:focus{ outline:none;
    filter:drop-shadow(0 0 6px #3285D1) drop-shadow(0 0 14px rgba(50,133,209,.6)); }
  /* DIR-57 #1: klein permanent naam+functie-label boven de agent (altijd zichtbaar). */
  .iso-agent{ cursor:pointer; }
  /* Hond (DIR-32): JS-gedreven, orthogonaal, zit/ligt bij de mand. */
  .dog{ position:absolute; bottom:6%; left:6%; width:9%; pointer-events:none;
    transition:left .6s linear, bottom .6s linear; }
  .dog.links{ transform:scaleX(-1); }
  .dog.loopt .dogleg-a{ animation:dd-legA .5s steps(1) infinite; }
  .dog.loopt .dogleg-b{ animation:dd-legB .5s steps(1) infinite; }
  .dog .dogbody{ transform-origin:bottom center; transition:transform .5s ease; }
  .dog .dogleg{ transition:transform .5s ease; }
  /* Zit: achterlijf ingezakt, kop omhoog (duidelijke zit-pose). Lig: plat/languit (DIR-44). */
  .dog.zit .dogbody{ transform:translateY(2px) rotate(-13deg); transform-origin:82% bottom; }
  .dog.zit .dogleg{ transform:translateY(6px) scaleY(.5); }
  .dog.ligt .dogbody{ transform:translateY(15px) scaleY(.32) scaleX(1.12); }
  .dog.ligt .dogleg{ transform:translateY(10px) scaleY(.4) scaleX(1.18); }
  /* Rondlopende agents (DIR-32): benen ALTIJD zichtbaar, alleen orthogonaal, dragen items. */
  .roam{ position:absolute; left:24%; bottom:12%; width:9%; display:none; z-index:4; cursor:pointer; }
  .roam.zichtbaar{ display:block; }
  .roam.links{ transform:scaleX(-1); }
  .roam .roam-fig{ transform-origin:bottom center; }
  .roam.loopt .roam-fig{ animation:dd-walkbob .42s steps(2) infinite; }
  .roam .poot{ display:block; }
  .roam.loopt .poot-a{ animation:dd-legA .34s steps(1) infinite; }
  .roam.loopt .poot-b{ animation:dd-legB .34s steps(1) infinite; }
  .roam .draag{ display:none; }
  .roam.draagt-koffie .draag-koffie{ display:block; }
  .roam.draagt-papier .draag-papier{ display:block; }
  .roam.draagt-gieter .draag-gieter{ display:block; }
  @keyframes dd-walkbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes dd-stretch{0%,100%{transform:translateY(0) scaleY(1)}45%{transform:translateY(-3px) scaleY(1.06)}}
  /* Hond aaien: bukken bij de mand (DIR-44 AC-6). */
  @keyframes dd-bend{0%,100%{transform:translateY(0) scaleY(1)}45%,60%{transform:translateY(7px) scaleY(.88)}}
  .roam.aait .roam-fig{ animation:dd-bend 1s ease-in-out infinite; }
  /* DIR-51: rekken/strekken in-place aan het eigen bureau (zit-sprite pulseert). */
  .iso-seat.rekt{ animation:dd-stretch 1.1s ease-in-out; }
  /* DIR-54: subtiele "aan het werk"-beweging op de zit-sprite (hoort bij het
     poppetje; verborgen zit-sprite tijdens roamen = automatisch geen typen). */
  @keyframes dd-worktype{ 0%,100%{ transform:translateY(0) } 50%{ transform:translateY(-1px) } 25%,75%{ transform:translateX(.4px) } }
  .iso-seat .typer{ animation:dd-worktype 1.5s ease-in-out infinite; }
  /* DIR-53: in-SVG movers (rondlopende agents + hond) — positie via JS translate. */
  .mover{ transform-box:view-box; }
  .roammover .draag{ display:none; }
  .roammover.draagt-koffie .draag-koffie{ display:block; }
  .roammover.draagt-papier .draag-papier{ display:block; }
  .roammover.draagt-gieter .draag-gieter{ display:block; }
  .roammover .roamfig{ transform-box:fill-box; transform-origin:bottom center; }
  .roammover.loopt .roamfig{ animation:dd-walkbob .42s steps(2) infinite; }
  .roammover.loopt .poot-a{ animation:dd-legA .34s steps(1) infinite; }
  .roammover.loopt .poot-b{ animation:dd-legB .34s steps(1) infinite; }
  .roammover .poot{ transform-box:fill-box; }
  .roammover.links .roamfig{ transform:scaleX(-1); }
  .roammover.aait .roamfig{ animation:dd-bend 1s ease-in-out infinite; }
  #iso-dog .dogpose{ transform-box:fill-box; transform-origin:center bottom; transition:transform .4s ease; }
  #iso-dog.links .dogpose{ transform:scaleX(-1); }
  #iso-dog.zit .dogpose{ transform:translateY(2px) scaleY(.82); }
  #iso-dog.ligt .dogpose{ transform:translateY(6px) scaleY(.5) scaleX(1.12); }
  #iso-dog.loopt .dogleg-a{ animation:dd-legA .5s steps(1) infinite; }
  #iso-dog.loopt .dogleg-b{ animation:dd-legB .5s steps(1) infinite; }
  #iso-dog .dogleg{ transform-box:fill-box; }
  #agent-desk.away #albert-body, #agent-desk.away .albert-hand{ opacity:0; }
  #agent-desk.rekt #albert-body{ animation:dd-stretch 2.2s ease-in-out; }
  #gertjan-desk.away #gertjan-body, #gertjan-desk.away .gertjan-hand{ opacity:0; }
  #gertjan-desk.rekt #gertjan-body{ animation:dd-stretch 2.2s ease-in-out; }
  #ilona-desk.away #ilona-body, #ilona-desk.away .ilona-hand{ opacity:0; }
  #ilona-desk.rekt #ilona-body{ animation:dd-stretch 2.2s ease-in-out; }
  #anton-desk.away #anton-body, #anton-desk.away .anton-hand{ opacity:0; }
  #anton-desk.rekt #anton-body{ animation:dd-stretch 2.2s ease-in-out; }
  /* chat-portret naast de chat (AC-2) */
  .chatrow{ display:flex; flex:1; min-height:0; }
  .chatmain{ flex:1; display:flex; flex-direction:column; min-width:0; }
  .portret{ position:relative; flex:0 0 84px; display:flex; flex-direction:column; align-items:center; padding:.6rem;
    background:#14202b; border-right:3px solid var(--ink); }
  .portret .avatar{ width:72px; height:72px; background:#0b1219; border:2px solid var(--accent);
    display:flex; align-items:center; justify-content:center; font-size:2.2rem; }
  .portret .pnaam{ margin-top:.4rem; font-size:.85rem; letter-spacing:1px; color:#3fd06a; }
  /* portret dynamisch (DIR-40): af en toe knipperen + 'typen' terwijl er een reactie binnenkomt */
  .portret .avatar svg{ display:block; width:100%; height:100%; }
  .portret .avatar .ooglid{ opacity:0; animation:dd-eyelid 5s steps(1,end) infinite; }
  @keyframes dd-eyelid{ 0%,92%,100%{ opacity:0; } 94%,97%{ opacity:1; } }
  .portret .avatar.aantypen svg{ animation:dd-portret-typ .5s ease-in-out infinite; transform-origin:50% 100%; }
  .portret .avatar.aantypen .ooglid{ animation:dd-eyelid 1.4s steps(1,end) infinite; }
  @keyframes dd-portret-typ{ 0%,100%{ transform:translateY(0); } 50%{ transform:translateY(-3px); } }
  /* DIR-58: '···'-typ-ballon uit het portret verwijderd; ogen blijven knipperen. */
  @media (prefers-reduced-motion: reduce){ .scene-wrap *{ animation:none !important; }
    .portret .avatar .ooglid, .portret .avatar.aantypen svg{ animation:none !important; } }
  @media (max-width:640px){ .portret{ flex-basis:60px; }
    .portret .avatar{ width:48px; height:48px; font-size:1.5rem; } }

  /* chat */
  .overlay{ display:none; position:fixed; inset:0; background:#0a0b1299;
    align-items:center; justify-content:center; padding:1rem; z-index:10; }
  .chat{ width:50vw; min-width:min(34rem,96vw); max-width:96vw; height:82vh; max-height:88vh;
    display:flex; flex-direction:column; font-family:var(--leesfont);
    background:var(--cream); color:var(--ink); border:4px solid var(--ink);
    box-shadow:8px 8px 0 var(--shadow); }
  @media (max-width:640px){ .chat{ width:100%; min-width:0; height:auto; max-height:92vh; } }
  .chat header{ background:var(--teal); color:var(--cream); padding:.5rem .7rem;
    display:flex; align-items:center; justify-content:space-between; border-bottom:3px solid var(--ink); }
  .chat header b{ letter-spacing:1px; font-size:.95rem; }
  .x{ background:var(--accent); color:var(--ink); border:2px solid var(--ink); cursor:pointer;
    font-family:var(--leesfont); font-weight:700; font-size:1.1rem; line-height:1; padding:.15rem .55rem; }
  .msgs{ flex:1; overflow:auto; padding:.7rem; display:flex; flex-direction:column; gap:.5rem;
    background:#fbf9f3; min-height:8rem; }
  .bubble{ padding:.55rem .7rem; border:2px solid var(--ink); max-width:85%; white-space:pre-wrap;
    word-break:break-word; font-family:var(--leesfont); font-size:1.02rem; line-height:1.5; }
  .bubble.user{ align-self:flex-end; background:var(--teal2); color:#08211d; }
  .bubble.agent{ align-self:flex-start; background:#fff; }
  /* DIR-59: opgemaakte markdown in agent-bubbles (tabellen/koppen/lijsten). */
  .bubble .md-tablewrap{ overflow-x:auto; max-width:100%; margin:.45rem 0; -webkit-overflow-scrolling:touch; }
  .bubble table.md-table{ border-collapse:collapse; font-size:.86rem; font-variant-numeric:tabular-nums; }
  .bubble .md-table th, .bubble .md-table td{ border:1px solid rgba(23,23,23,.28); padding:3px 8px; white-space:nowrap; }
  .bubble .md-table th{ background:#efe8d7; font-weight:700; }
  .bubble .md-table tbody tr:nth-child(even){ background:rgba(23,23,23,.05); }
  .bubble .md-h{ margin:.55rem 0 .28rem; font-family:'Press Start 2P',monospace; line-height:1.35; }
  .bubble h3.md-h{ font-size:.95rem; } .bubble h4.md-h{ font-size:.82rem; } .bubble h5.md-h{ font-size:.74rem; }
  .bubble .md-list{ margin:.3rem 0 .3rem 1.15rem; padding:0; }
  .bubble .md-list li{ margin:.12rem 0; }
  .bubble .md-p{ margin:.38rem 0; }
  .bubble .md-p:first-child, .bubble .md-h:first-child{ margin-top:0; }
  /* typing-indicator (AC-1): pixel-puntjes die verschijnen/verdwijnen */
  .typing{ display:inline-flex; gap:5px; align-items:center; padding:2px 1px; }
  .typing i{ width:7px; height:7px; background:var(--accent); display:inline-block;
    animation:dd-typing 1.3s ease-in-out infinite; }
  .typing i:nth-child(2){ animation-delay:.2s; }
  .typing i:nth-child(3){ animation-delay:.4s; }
  @keyframes dd-typing{ 0%,80%,100%{ opacity:0; } 40%{ opacity:1; } }
  @media (prefers-reduced-motion: reduce){ .typing i{ animation:none; opacity:1; } }
  .notice{ font-size:.72rem; color:#4a4e6d; padding:.4rem .7rem; background:#efe9db;
    border-top:2px solid var(--ink); }
  .notice.flash{ background:var(--teal2); color:#08211d; }
  .composer{ display:none; gap:.4rem; padding:.6rem; border-top:3px solid var(--ink); background:var(--cream); }
  .composer input{ flex:1; font-family:var(--leesfont); font-size:1rem; padding:.55rem;
    border:2px solid var(--ink); }
  button.knop{ font-family:var(--leesfont); font-weight:700; font-size:1rem; cursor:pointer; border:2px solid var(--ink);
    background:var(--teal); color:#fff; padding:.5rem .9rem; box-shadow:2px 2px 0 var(--shadow); }
  button.knop:disabled{ opacity:.5; cursor:default; }
  .bar{ display:flex; gap:.5rem; padding:.6rem; border-top:2px solid var(--ink); background:var(--cream); flex-wrap:wrap; }
  button.rood{ background:var(--accent); color:var(--ink); }
  /* site-keuze + dashboard */
  .sitekeuze{ align-self:flex-start; background:#fff; border:2px solid var(--ink); padding:.6rem; max-width:100%; }
  .sitekeuze p{ margin:0 0 .5rem; font-size:.9rem; }
  .sitekeuze .sitebtn{ display:block; width:100%; text-align:left; margin:.25rem 0; }
  .dash{ align-self:stretch; display:flex; flex-direction:column; gap:1rem; }
  .card{ background:#fff; border:2px solid var(--ink); box-shadow:3px 3px 0 var(--shadow); }
  .card h3{ margin:0; background:var(--teal); color:#fff; font-family:var(--leesfont);
    font-size:1.08rem; font-weight:700; letter-spacing:.3px;
    padding:.5rem .8rem; border-bottom:2px solid var(--ink); }
  .card .body{ padding:.8rem 1rem; font-family:var(--leesfont); font-size:1.04rem; line-height:1.65;
    white-space:pre-wrap; word-break:break-word; }
  .card .body ul{ margin:.4rem 0; padding-left:1.3rem; }
  .card .body li{ margin:.25rem 0; }
  .download-knop{ align-self:flex-start; background:var(--accent); color:#111; }
  @media (max-width:640px){ .kamer{ transform:scale(.66); transform-origin:top center; }
    .stage{ height:280px; } h1.titel{ font-size:1.5rem; } }
</style>
</head><body>
<div class="scene-host">
  <div class="scene-wrap">
    <!-- DIR-54: strakkere viewBox rond de iso-kamer (16:9) → vult het scherm
         beter, gecentreerd, niets afgeknipt; movers gebruiken dezelfde userspace. -->
    <svg viewBox="90 42 462 260" width="100%" height="100%" shape-rendering="crispEdges" style="display:block;position:absolute;inset:0;image-rendering:pixelated;">
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
        <!-- Compact bureau (DIR-31): monitor rechts, smaller blad, zichtbaar keyboard. -->
        <symbol id="deskEmpty" viewBox="0 0 100 80">
          <rect x="76" y="30" width="8" height="12" fill="#0c0c0c"/>
          <rect x="70" y="42" width="20" height="4" fill="#0c0c0c"/>
          <rect x="60" y="6" width="36" height="26" fill="#0a0a0a"/>
          <rect x="64" y="10" width="28" height="18" fill="#14202b"/>
          <rect x="67" y="13" width="12" height="2" fill="#22384a"/>
          <rect x="67" y="18" width="18" height="2" fill="#1d2f3e"/>
          <rect x="67" y="23" width="8" height="2" fill="#1d2f3e"/>
          <rect x="16" y="46" width="78" height="8" fill="#2b2b2b"/>
          <rect x="16" y="54" width="78" height="22" fill="#141414"/>
          <rect x="22" y="54" width="4" height="22" fill="#0c0c0c"/>
          <rect x="84" y="54" width="4" height="22" fill="#0c0c0c"/>
          <rect x="26" y="47" width="30" height="7" fill="#3a3f47"/>
          <rect x="28" y="48" width="26" height="2" fill="#20242a"/>
          <rect x="28" y="51" width="26" height="2" fill="#20242a"/>
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
        <!-- Albert (GSC/SEO): kort bruin haar, roze polo -->
        <symbol id="albert" viewBox="0 0 40 48">
          <rect x="9" y="30" width="22" height="18" fill="#e58fa8"/>
          <rect x="9" y="30" width="22" height="4" fill="#d16f8e"/>
          <rect x="18" y="30" width="4" height="11" fill="#d16f8e"/>
          <rect x="17" y="26" width="6" height="5" fill="#d99a63"/>
          <rect x="13" y="12" width="14" height="16" fill="#e8b98a"/>
          <rect x="13" y="12" width="14" height="3" fill="#f0c79a"/>
          <rect x="12" y="8" width="16" height="6" fill="#5a3a1e"/>
          <rect x="12" y="12" width="2" height="5" fill="#5a3a1e"/>
          <rect x="26" y="12" width="2" height="5" fill="#5a3a1e"/>
          <rect x="16" y="18" width="3" height="3" fill="#2a1c0c"/>
          <rect x="22" y="18" width="3" height="3" fill="#2a1c0c"/>
          <rect x="18" y="23" width="5" height="2" fill="#c98a5a"/>
        </symbol>
        <!-- Gertjan (GA4): bril, korte baard, licht overhemd (DIR-29) -->
        <symbol id="gertjan" viewBox="0 0 40 48">
          <rect x="9" y="30" width="22" height="18" fill="#c7ccd2"/>
          <rect x="9" y="30" width="22" height="4" fill="#aeb4bb"/>
          <rect x="19" y="30" width="2" height="18" fill="#aeb4bb"/>
          <rect x="17" y="26" width="6" height="5" fill="#d99a63"/>
          <rect x="13" y="12" width="14" height="16" fill="#e8b98a"/>
          <rect x="12" y="24" width="16" height="4" fill="#8a7050"/>
          <rect x="12" y="8" width="16" height="6" fill="#6a4e2a"/>
          <rect x="14" y="17" width="6" height="5" fill="#1a1a1a"/>
          <rect x="15" y="18" width="4" height="3" fill="#bfe0ec"/>
          <rect x="20" y="18" width="2" height="1" fill="#1a1a1a"/>
          <rect x="22" y="17" width="6" height="5" fill="#1a1a1a"/>
          <rect x="23" y="18" width="4" height="3" fill="#bfe0ec"/>
        </symbol>
        <!-- Ilona (Google Ads): blond opgestoken haar + bloemenblouse (DIR-36) -->
        <symbol id="ilona" viewBox="0 0 40 48">
          <rect x="9" y="30" width="22" height="18" fill="#2f7f6e"/>
          <rect x="13" y="34" width="2" height="2" fill="#F18E02"/>
          <rect x="19" y="38" width="2" height="2" fill="#e58fa8"/>
          <rect x="24" y="33" width="2" height="2" fill="#f0f0f0"/>
          <rect x="16" y="42" width="2" height="2" fill="#F18E02"/>
          <rect x="22" y="40" width="2" height="2" fill="#e58fa8"/>
          <rect x="17" y="26" width="6" height="5" fill="#e0a878"/>
          <rect x="13" y="12" width="14" height="16" fill="#f0c79a"/>
          <rect x="12" y="9" width="16" height="6" fill="#e6c86a"/>
          <rect x="18" y="4" width="6" height="6" fill="#e6c86a"/>
          <rect x="11" y="13" width="2" height="6" fill="#e6c86a"/>
          <rect x="27" y="13" width="2" height="6" fill="#e6c86a"/>
          <rect x="16" y="18" width="2" height="2" fill="#2a1c0c"/>
          <rect x="22" y="18" width="2" height="2" fill="#2a1c0c"/>
          <rect x="18" y="23" width="4" height="2" fill="#d98a8a"/>
        </symbol>
        <!-- Anton (content): kaal/kort haar, donker colbert + wit overhemd (DIR-39) -->
        <symbol id="anton" viewBox="0 0 40 48">
          <rect x="8" y="30" width="24" height="18" fill="#2a2f3a"/>
          <rect x="17" y="30" width="6" height="16" fill="#f0f0f0"/>
          <rect x="19" y="31" width="2" height="12" fill="#015092"/>
          <rect x="8" y="30" width="6" height="18" fill="#20242e"/>
          <rect x="26" y="30" width="6" height="18" fill="#20242e"/>
          <rect x="17" y="26" width="6" height="5" fill="#c98a5a"/>
          <rect x="13" y="12" width="14" height="16" fill="#d9a878"/>
          <rect x="13" y="12" width="14" height="3" fill="#e6b98a"/>
          <rect x="14" y="10" width="12" height="2" fill="#6a5a4a"/>
          <rect x="16" y="18" width="2" height="2" fill="#2a1c0c"/>
          <rect x="22" y="18" width="2" height="2" fill="#2a1c0c"/>
          <rect x="18" y="23" width="4" height="2" fill="#b57a55"/>
        </symbol>
      </defs>
      ${isoRoomInner()}${isoAgentsOverlay()}
    </svg>

    <!-- DIR-53: hond + rondlopende agents zitten nu IN de scène-SVG (iso-depth
         laag) met correcte back-to-front; geen HTML-overlays meer. -->

    <div style="position:absolute;top:0;left:0;right:0;height:30%;background:linear-gradient(to bottom, rgba(8,11,15,.82) 0%, rgba(8,11,15,.5) 55%, rgba(8,11,15,0) 100%);pointer-events:none;"></div>
    <div style="position:absolute;top:5%;left:0;right:0;text-align:center;pointer-events:none;">
      <div style="font-family:'Press Start 2P',monospace;color:#F18E02;font-size:clamp(18px,4.4vw,52px);letter-spacing:2px;text-shadow:4px 4px 0 #015092,8px 8px 0 rgba(0,0,0,.35);">DIRK DIGITAAL</div>
    </div>
    <div style="position:absolute;bottom:4%;left:0;right:0;text-align:center;pointer-events:none;">
      <span style="display:inline-block;font-family:'VT323',monospace;font-size:clamp(15px,2.1vw,26px);letter-spacing:1px;color:#e8e2d8;background:rgba(11,18,25,.72);border:1px solid #F18E02;padding:6px 16px;text-shadow:1px 1px 0 #000;animation:dd-cta 2.4s ease-in-out infinite;">
        <span style="color:#F18E02">&#9656;</span> Klik op een collega om een gesprek te starten
      </span>
    </div>
  </div>
</div>

<div class="overlay" id="chat-overlay" role="dialog" aria-label="GSC-agent chat">
  <div class="chat">
    <header><b id="chat-title">GSC-agent</b><button class="x" id="chat-close" aria-label="Sluiten">X</button></header>
    <div class="chatrow">
      <div class="portret" aria-hidden="true">
        <div class="avatar" id="chat-avatar"><svg viewBox="0 0 40 48" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true"><use href="#albert"/><rect class="ooglid" x="14" y="17" width="12" height="4" fill="#e8b98a"/></svg></div>
        <div class="pnaam" id="chat-pnaam">&#9679; Albert</div>
      </div>
      <div class="chatmain">
        <div class="msgs" id="chat-msgs">
          <div class="bubble agent">Hoi! Ik ben Albert, je GSC-agent. Koppel je Google-account, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.</div>
        </div>
        <div class="notice" id="privacy-notice">Privacy: je koppeling en dit gesprek leven alleen in deze sessie. Ze wissen zichzelf als je weggaat of na 30 minuten. Er wordt niets blijvend opgeslagen. Klik hieronder op "Koppel Google" om te beginnen.</div>
        <div class="bar">
          <button class="knop" id="chat-connect">Koppel Google</button>
          <button class="knop" id="chat-meta" style="display:none">Meta Ads</button>
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
  var metaBtn=document.getElementById('chat-meta');
  var switchBtn=document.getElementById('chat-switch');
  var composer=document.getElementById('chat-composer');
  var agent=document.getElementById('agent-desk');
  var gertjanDesk=document.getElementById('gertjan-desk');
  var ilonaDesk=document.getElementById('ilona-desk');
  var antonDesk=document.getElementById('anton-desk');
  var notice=document.getElementById('privacy-notice');
  var titleEl=document.getElementById('chat-title');
  var avatarEl=document.getElementById('chat-avatar');
  var pnaamEl=document.getElementById('chat-pnaam');
  var connected=false, busy=false, started=false;

  // Agent-config: welke agent je aanklikt bepaalt portret, persona en endpoints (DIR-29).
  var AGENTS={
    gsc:{ key:'gsc', naam:'Albert', titel:'GSC-agent', sym:'albert', huid:'#e8b98a', chat:'/api/chat', bron:'/api/gsc/sites',
      needKey:'needSite', listKey:'sites', selKey:'site', switchLabel:'Andere site',
      vraag:'Welke website wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je zoekcijfers...',
      intro:'Hoi! Ik ben Albert, je GSC-agent. Koppel je Google-account, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.',
      itemValue:function(x){return x;}, itemLabel:function(x){return x;} },
    ga4:{ key:'ga4', naam:'Gertjan', titel:'GA4-agent (Gertjan)', sym:'gertjan', huid:'#e8b98a', chat:'/api/ga4/chat', bron:'/api/ga4/properties',
      needKey:'needProperty', listKey:'properties', selKey:'property', switchLabel:'Andere property',
      vraag:'Welke GA4-property wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je GA4-cijfers...',
      intro:'Hoi! Ik ben Gertjan, je GA4-data-specialist. Koppel je Google-account, dan geef ik je meteen een overzicht van je verkeer en kun je me alles vragen.',
      itemValue:function(x){return x&&x.property;}, itemLabel:function(x){return (x&&(x.displayName||x.property))||'';} },
    ads:{ key:'ads', naam:'Ilona', titel:'Ads-agent (Ilona)', sym:'ilona', huid:'#f0c79a', chat:'/api/ads/chat', bron:'/api/ads/customers',
      needKey:'needAccount', listKey:'accounts', selKey:'customer', switchLabel:'Ander account', connectLabel:'Koppel Google Ads',
      vraag:'Welk Google Ads-account wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je advertentiecijfers...',
      intro:'Hoi! Ik ben Ilona, je advertentie-specialist. Kies een platform: "Koppel Google Ads" voor je Google-campagnes, of "Meta Ads" voor je Facebook/Instagram-cijfers (die komen via je persoonlijke klant-link).',
      itemValue:function(x){return x&&x.customer;}, itemLabel:function(x){return (x&&(x.naam?x.naam+' ('+x.id+')':(x.id||x.customer)))||'';} },
    anton:{ key:'anton', naam:'Anton', titel:'Content-specialist (Anton)', sym:'anton', huid:'#d9a878', chat:'/api/content/chat',
      geenKoppeling:true, ph:'Plak je tekst of vraag een bewerking...',
      intro:'Hoi! Ik ben Anton, je content-specialist. Plak een tekst en vraag me te schrijven, vertalen, spellingchecken, in te korten, te verlengen, SEO-optimaliseren of te herschrijven.' } };
  var cur=AGENTS.gsc;

  // Portret-SVG: agent-symbool + knipperend ooglid (huidskleur over de ogen). DIR-40.
  function avatarSVG(a){
    return '<svg viewBox="0 0 40 48" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true">'
      +'<use href="#'+a.sym+'"/>'
      +'<rect class="ooglid" x="14" y="17" width="12" height="4" fill="'+(a.huid||'#e8b98a')+'"/>'
      +'</svg>';
  }

  function openChat(key){ if(key) useAgent(key); overlay.style.display='flex'; }
  function closeChat(){ overlay.style.display='none'; }
  function useAgent(key){
    if(cur.key===key) return;              // zelfde agent → gesprek behouden
    cur=AGENTS[key];
    titleEl.textContent=cur.titel;
    avatarEl.innerHTML=avatarSVG(cur);
    pnaamEl.innerHTML='&#9679; '+cur.naam;
    input.placeholder=cur.ph; switchBtn.textContent=cur.switchLabel;
    if(connectBtn) connectBtn.textContent=cur.connectLabel||'Koppel Google';
    if(metaBtn) metaBtn.style.display=(key==='ads')?'inline-block':'none';   // Meta-knop alleen bij Ilona (DIR-42)
    started=false; setActive(false); msgs.innerHTML=''; addBubble('agent', cur.intro);
    if(cur.geenKoppeling){
      // Anton (DIR-39): geen koppel-stap → direct klaar om te chatten, geen privacy/koppel-scherm.
      if(notice) notice.style.display='none';
      if(connectBtn) connectBtn.style.display='none';
      setActive(true); switchBtn.style.display='none'; started=true;
    } else {
      if(connectBtn) connectBtn.style.display=connected?'none':'inline-block';
      if(notice){ notice.style.display=connected?'none':'block'; notice.classList.remove('flash'); }
    }
  }
  function setConnected(v){ connected=v; connectBtn.style.display=v?'none':'inline-block';
    if(notice) notice.style.display=v?'none':'block'; }
  function setActive(v){ composer.style.display=v?'flex':'none'; switchBtn.style.display=v?'inline-block':'none'; }
  function addBubble(who,text){ var b=document.createElement('div'); b.className='bubble '+who;
    b.textContent=text; msgs.appendChild(b); msgs.scrollTop=msgs.scrollHeight; return b; }
  function setTyping(b){ b.innerHTML='<span class="typing" role="status" aria-label="Agent is aan het typen"><i></i><i></i><i></i></span>'; }
  function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  function connect(){ try{ sessionStorage.setItem('dd_agent', cur.key); }catch(e){} window.location.href='/oauth/start'; }

  // Meta-knop (DIR-42): in een klant-magic-link-sessie direct Meta-modus; anders uitleg.
  function metaKlik(){
    if(busy) return;
    fetch('/api/meta/status').then(function(r){ return r.json(); }).then(function(j){
      if(j && j.available){
        if(notice) notice.style.display='none';
        if(connectBtn) connectBtn.style.display='none';
        setActive(true); started=true;
        addBubble('user','Laat mijn Meta-cijfers zien');
        streamChat({}, false);
      } else {
        addBubble('agent','Meta-cijfers (Facebook/Instagram) zie je via je persoonlijke klant-link. Vraag Dirk om jouw link — die maakt hij in het beheer. Voor je Google-campagnes klik je op "Koppel Google Ads".');
      }
    }).catch(function(){ addBubble('agent','Kon de Meta-status niet ophalen. Probeer het later opnieuw.'); });
  }

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

  function renderPicker(items){
    var box=document.createElement('div'); box.className='sitekeuze';
    var p=document.createElement('p'); p.textContent=cur.vraag; box.appendChild(p);
    (items||[]).forEach(function(it){ var val=cur.itemValue(it), label=cur.itemLabel(it);
      var b=document.createElement('button'); b.className='knop sitebtn';
      b.textContent=label; b.addEventListener('click',function(){ box.remove(); addBubble('user',cur.prefix+label);
        var payload={}; payload[cur.selKey]=val; streamChat(payload, true); }); box.appendChild(b); });
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

  // DIR-59: veilige markdown → HTML voor agent-antwoorden. Escape eerst ALLE HTML
  // uit de agent-tekst; render daarna alléén bekende constructies (pipe-tabellen,
  // koppen, bold/italic, lijsten, alinea's). Geen raw-HTML-injectie mogelijk.
  function mdToHtml(md){
    function esc(s){ return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'); }
    function inl(s){ s=s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>'); s=s.replace(/\\*([^*\\n]+)\\*/g,'<em>$1</em>'); return s; }
    function isSep(l){ return l.indexOf('|')>=0 && /^[\\s:|-]*-{2,}[\\s:|-]*$/.test(l); }
    function cells(l){ var t=l.trim(); if(t.charAt(0)==='|')t=t.slice(1); if(t.charAt(t.length-1)==='|')t=t.slice(0,-1); return t.split('|').map(function(c){return c.trim();}); }
    function isNum(s){ return /\\d/.test(s) && /^[-+]?[\\d.,%€$\\s]+$/.test(s); }
    var lines=esc(md).split('\\n'), i=0, n=lines.length, html='';
    while(i<n){
      var l=lines[i];
      if(l.indexOf('|')>=0 && i+1<n && isSep(lines[i+1])){
        var head=cells(l); i+=2; var rows=[];
        while(i<n && lines[i].indexOf('|')>=0 && lines[i].trim()!==''){ rows.push(cells(lines[i])); i++; }
        var aligns=head.map(function(_,ci){ return (rows.length && rows.every(function(r){return isNum(r[ci]||'');}))?'right':'left'; });
        var t='<div class="md-tablewrap"><table class="md-table"><thead><tr>';
        head.forEach(function(h,ci){ t+='<th style="text-align:'+aligns[ci]+'">'+inl(h)+'</th>'; });
        t+='</tr></thead><tbody>';
        rows.forEach(function(r){ t+='<tr>'; head.forEach(function(_,ci){ t+='<td style="text-align:'+aligns[ci]+'">'+inl(r[ci]||'')+'</td>'; }); t+='</tr>'; });
        html+=t+'</tbody></table></div>'; continue;
      }
      var hm=/^(#{1,3})\\s+(.*)$/.exec(l);
      if(hm){ var lv=hm[1].length+2; html+='<h'+lv+' class="md-h">'+inl(hm[2].trim())+'</h'+lv+'>'; i++; continue; }
      if(/^\\s*[-*]\\s+/.test(l) || /^\\s*\\d+\\.\\s+/.test(l)){
        var ordered=/^\\s*\\d+\\.\\s+/.test(l), tag=ordered?'ol':'ul', items='';
        while(i<n && (/^\\s*[-*]\\s+/.test(lines[i]) || /^\\s*\\d+\\.\\s+/.test(lines[i]))){ items+='<li>'+inl(lines[i].replace(/^\\s*([-*]|\\d+\\.)\\s+/,''))+'</li>'; i++; }
        html+='<'+tag+' class="md-list">'+items+'</'+tag+'>'; continue;
      }
      if(l.trim()===''){ i++; continue; }
      var para=l; i++;
      while(i<n && lines[i].trim()!=='' && lines[i].indexOf('|')<0 && !/^#{1,3}\\s+/.test(lines[i]) && !/^\\s*[-*]\\s+/.test(lines[i]) && !/^\\s*\\d+\\.\\s+/.test(lines[i])){ para+=' '+lines[i]; i++; }
      html+='<p class="md-p">'+inl(para.trim())+'</p>';
    }
    return html;
  }

  async function streamChat(payload, dashboard){
    if(busy) return; busy=true; sendBtn.disabled=true;
    if(avatarEl) avatarEl.classList.add('aantypen');   // portret 'typt' terwijl antwoord binnenkomt (DIR-40)
    var bubble=addBubble('agent',''); setTyping(bubble); var got='';
    try{
      var r=await fetch(cur.chat,{ method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload||{}) });
      var ct=r.headers.get('Content-Type')||'';
      if(!r.ok||ct.indexOf('application/json')!==-1){
        var j={}; try{ j=await r.json(); }catch(e){}
        if(j&&j[cur.needKey]){ bubble.remove(); renderPicker(j[cur.listKey]); busy=false; sendBtn.disabled=false; if(avatarEl) avatarEl.classList.remove('aantypen'); return; }
        bubble.textContent=(j&&j.error)||'Er ging iets mis. Probeer het opnieuw.';
        if(r.status===401){ setConnected(false); setActive(false); started=false; }
        busy=false; sendBtn.disabled=false; if(avatarEl) avatarEl.classList.remove('aantypen'); return;
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
        else { bubble.innerHTML=mdToHtml(got); }   // DIR-59: normale antwoorden als opgemaakte markdown
        setActive(true);
      }
    }catch(e){ bubble.textContent='Kon de agent niet bereiken. Probeer het opnieuw.'; }
    busy=false; sendBtn.disabled=false; if(avatarEl) avatarEl.classList.remove('aantypen');
  }

  // Startpunt na koppelen: backend beslist tussen site-keuze (meerdere) of directe analyse (één).
  async function startFlow(){ if(started) return; started=true; await streamChat({}, true); }

  async function send(){ var t=(input.value||'').trim(); if(!t||busy) return; input.value='';
    addBubble('user',t); await streamChat({message:t}, false); }

  async function switchBron(){ if(busy) return;
    try{ var r=await fetch(cur.bron); if(!r.ok) return; var j=await r.json(); renderPicker(j[cur.listKey]||[]); }catch(e){} }

  async function disconnect(){ try{ await fetch('/api/disconnect'); }catch(e){}
    setConnected(false); setActive(false); started=false; msgs.innerHTML='';
    notice.textContent='Je sessie is gewist. Er is niets bewaard.'; notice.classList.add('flash'); }

  function openAgent(key){ openChat(key); if(connected&&!started) startFlow(); }
  agent.addEventListener('click',function(){ openAgent('gsc'); });
  agent.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent('gsc'); } });
  if(gertjanDesk){
    gertjanDesk.addEventListener('click',function(){ openAgent('ga4'); });
    gertjanDesk.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent('ga4'); } });
  }
  if(ilonaDesk){
    ilonaDesk.addEventListener('click',function(){ openAgent('ads'); });
    ilonaDesk.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent('ads'); } });
  }
  if(antonDesk){
    antonDesk.addEventListener('click',function(){ openAgent('anton'); });
    antonDesk.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent('anton'); } });
  }
  // DIR-57 #1: labels staan nu permanent in de SVG (isoAgentsOverlay) — geen
  // hover-toggle-JS meer nodig; hover-glow blijft via de #...-desk:hover-CSS.
  document.getElementById('chat-close').addEventListener('click',closeChat);
  connectBtn.addEventListener('click',connect);
  if(metaBtn) metaBtn.addEventListener('click',metaKlik);
  switchBtn.addEventListener('click',switchBron);
  document.getElementById('chat-disconnect').addEventListener('click',disconnect);
  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });

  // DIR-53: rondlopende agents + hond IN de scène-SVG (iso-depth-laag) met
  // correcte back-to-front. Movers positioneren via style.transform=translate;
  // data-k = tegel-diepte (i+j); restack() sorteert de #iso-depth-kinderen zodat
  // een mover ACHTER een meubel verdwijnt en ervoor komt waar nodig — nooit over
  // een meubel heen. Orthogonaal pad langs de iso-assen via een centrale gang-hub
  // (blijft in de gangpaden). Max 1 loper, geen sprong, klik werkt lopend.
  (function(){
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var ISO=${JSON.stringify(ISO)};
    function sx(i,j){ return ISO.Ox+(i-j)*(ISO.TW/2); }
    function sy(i,j){ return ISO.Oy+(i+j)*(ISO.TH/2); }   // z=0 (feet op de vloer)
    var depth=document.getElementById('iso-depth');
    function restack(){
      if(!depth) return;
      var kids=Array.prototype.slice.call(depth.children);
      kids.sort(function(a,b){ return (parseFloat(a.getAttribute('data-k'))||0)-(parseFloat(b.getAttribute('data-k'))||0); });
      kids.forEach(function(n){ depth.appendChild(n); });
    }
    // Orthogonaal pad A→B langs de iso-assen (eerst i, dan j): 2 enkel-as-stappen.
    function ortho(a,b){ return [{i:b.i,j:a.j},{i:b.i,j:b.j}]; }
    var HUB={i:4.45,j:3.75};   // centrale gang-hub (vrij van meubels)
    var HOMES=${JSON.stringify(Object.fromEntries(ISO_DESKS.map((d) => { const f = isoAgentFeet(d); return [d.key, { i: +f.i.toFixed(2), j: +f.j.toFixed(2) }]; })))};
    var KOFFIE={i:6.6,j:1.2,drag:'koffie'}, PRINT={i:1.4,j:3.6,drag:'papier'};
    var PLANTA={i:1.4,j:1.2,drag:'gieter'}, PLANTB={i:1.4,j:6.8,drag:'gieter'};
    var DOGTILE={i:5.0,j:6.6,bend:true};
    var GEWONE=[KOFFIE,PRINT];   // DIR-60: alleen zichtbare carry-acties (geen leeg rondje)
    var ILONA=[PLANTA,PLANTB];
    var ACTIES={ gsc:GEWONE, ga4:GEWONE, ads:ILONA, anton:GEWONE };
    var actief=false;   // gedeelde lock: max ÉÉN loper tegelijk

    // DIR-56: vloeiend lopen via rAF-tween — de transform wordt elke frame
    // continu geïnterpoleerd (geen CSS-transition die restack onderbreekt).
    // restack alleen als de diepte-band (afgerond) wisselt → correcte back-to-
    // front zonder zichtbaar verspringen.
    // CSS-transition (niet rAF): loopt óók door als de tab op de achtergrond staat,
    // en glijdt vloeiend. restack gebeurt ÉÉN keer aan het begin van elk segment
    // (met de doel-diepte), dan draait de transition ononderbroken — geen sprong.
    function walker(el){
      var pos={i:0,j:0};
      function face(toi,toj){ var dx=sx(toi,toj)-sx(pos.i,pos.j); if(dx<0) el.classList.add('links'); else if(dx>0) el.classList.remove('links'); }
      function put(i,j){ el.style.transform='translate('+sx(i,j).toFixed(1)+'px,'+sy(i,j).toFixed(1)+'px)'; }
      function jumpTo(i,j){ el.style.transition='none'; put(i,j); el.setAttribute('data-k',(i+j).toFixed(3)); pos={i:i,j:j}; restack(); }
      function setDepth(k){ el.setAttribute('data-k',(+k).toFixed(3)); restack(); }
      function seg(ti,tj,cb){
        var fi=pos.i, fj=pos.j, dist=Math.abs(ti-fi)+Math.abs(tj-fj);
        if(dist<0.001){ cb&&cb(); return; }
        face(ti,tj);
        // Diepte voor dit segment eerst zetten + restack (vóór de transition, zodat
        // appendChild de lopende transition niet onderbreekt).
        el.setAttribute('data-k',(ti+tj).toFixed(3)); restack();
        var dur=Math.max(0.35, dist*0.42);
        el.style.transition='none'; put(fi,fj); void el.getBoundingClientRect();  // start vast
        el.style.transition='transform '+dur+'s linear';
        put(ti,tj);                                                                // glijd naar doel
        pos={i:ti,j:tj};
        setTimeout(cb, dur*1000+40);
      }
      function walkPath(pts,cb){ el.classList.add('loopt'); (function nxt(k){ if(k>=pts.length){ el.classList.remove('loopt'); cb&&cb(); return; } seg(pts[k].i,pts[k].j,function(){ nxt(k+1); }); })(0); }
      return { pos:function(){return pos;}, jumpTo:jumpTo, setDepth:setDepth, walkPath:walkPath };
    }

    function maakRoamer(key){
      var roam=document.getElementById('iso-roam-'+key);
      var seat=document.getElementById('iso-seat-'+key);
      if(!roam) return;
      roam.addEventListener('click',function(){ openAgent(key); });   // klik werkt ook lopend
      roam.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent(key); } });
      if(reduce) return;   // reduced-motion: blijven zitten
      var home=HOMES[key], spots=ACTIES[key];
      var w=walker(roam), busy=false;
      function trip(dest,opts){
        busy=true; actief=true;
        if(seat) seat.style.visibility='hidden';        // bureau leeg terwijl weg
        w.jumpTo(home.i,home.j);                        // zonder animatie op de zit-tegel
        roam.style.display='block';
        void roam.getBoundingClientRect();              // reflow → geen teleport (start staat vast)
        // Directe start (geen requestAnimationFrame — dat pauzeert op een verborgen
        // tab en zou de roamer laten vasthangen). setTimeout(0) volstaat.
        setTimeout(function(){
          var out=ortho(home,HUB).concat(ortho(HUB,dest));
          w.walkPath(out,function(){
            if(opts.drag) roam.classList.add('draagt-'+opts.drag);
            if(opts.bend) roam.classList.add('aait');
            setTimeout(function(){
              roam.classList.remove('aait');
              var back=ortho(dest,HUB).concat(ortho(HUB,home));
              w.walkPath(back,function(){
                roam.classList.remove('links','draagt-koffie','draagt-papier','draagt-gieter');
                roam.style.display='none';
                if(seat) seat.style.visibility='';
                busy=false; actief=false; plan();
              });
            }, opts.wacht||1700);
          });
        }, 20);
      }
      function stretch(){ if(seat){ seat.classList.add('rekt'); setTimeout(function(){ seat.classList.remove('rekt'); plan(); },2300); } else plan(); }
      function overleg(){ var andere=['gsc','ga4','ads','anton'].filter(function(x){ return x!==key; });
        var o=HOMES[andere[Math.floor(Math.random()*andere.length)]]; trip({ i:o.i+0.9, j:o.j }, { wacht:2600 }); }
      function petDog(){ trip(DOGTILE, { wacht:1900, bend:true }); }
      function act(){
        var r=Math.random();
        if(r<0.22){ stretch(); return; }                // rekken in-place (geen lock)
        if(busy||actief){ plan(); return; }             // max 1 loper
        if(r<0.34){ overleg(); return; }
        if(key!=='ads' && r<0.52){ petDog(); return; }  // hond aaien (niet Ilona)
        // rest = zichtbare kantooractie met item: koffie/printer (of planten water = Ilona)
        var s=spots[Math.floor(Math.random()*spots.length)];
        if(s) trip(s, { drag:s.drag, bend:s.bend, wacht:1900 }); else stretch();
      }
      function plan(){ setTimeout(act, 8000+Math.random()*9000); }
      plan();
    }
    ['gsc','ga4','ads','anton'].forEach(maakRoamer);

    // Kantoorhond (DIR-53 #2): kleiner + netjes orthogonaal pad via de hub, rust
    // in de mand, respecteert de back-to-front (mover in dezelfde depth-laag).
    (function(){
      var dog=document.getElementById('iso-dog'); if(!dog) return;
      var BED={i:${(ISO_MAND.i0 + 0.6).toFixed(2)},j:${(ISO_MAND.j0 + 0.5).toFixed(2)}};
      var SPOTS=[{i:4.4,j:3.7},{i:6.4,j:3.2},{i:3.2,j:6.2},{i:5.6,j:6.2}];
      var w=walker(dog);
      w.jumpTo(BED.i,BED.j);
      function inBed(){ dog.style.transform='translate('+sx(BED.i,BED.j).toFixed(1)+'px,'+(sy(BED.i,BED.j)-5).toFixed(1)+'px)'; w.setDepth(14.45); }
      inBed();
      if(reduce){ dog.classList.add('ligt'); return; }
      function rust(cb){ dog.classList.add('zit');
        setTimeout(function(){ dog.classList.remove('zit'); dog.classList.add('ligt');
          setTimeout(function(){ dog.classList.remove('ligt'); cb(); }, 6000); }, 3000); }
      // inBed(): zichtbaar IN de mand — iets omhoog (op het kussen, boven de
      // bodem) + hogere data-k dan de mand (14.1) zodat de hond ná de mand tekent.
      function loop(){
        if(Math.random()<0.55){ var p=w.pos(); w.walkPath(ortho(p,HUB).concat(ortho(HUB,BED)),function(){ inBed(); rust(function(){ setTimeout(loop,2500); }); }); }
        else { var g=SPOTS[Math.floor(Math.random()*SPOTS.length)]; var q=w.pos(); w.walkPath(ortho(q,HUB).concat(ortho(HUB,g)),function(){ setTimeout(loop,2200+Math.random()*3000); }); }
      }
      setTimeout(loop,1500);
    })();
  })();

  // Bij (her)laden: al gekoppeld? Eén koppeling dekt beide agents. Open de agent die
  // de koppeling startte (in sessionStorage bewaard bij connect), default Albert/GSC.
  fetch('/api/gsc/sites').then(function(r){ if(r.ok){ setConnected(true);
      var k='gsc'; try{ k=sessionStorage.getItem('dd_agent')||'gsc'; }catch(e){}
      openAgent(AGENTS[k]?k:'gsc'); }
    else{ setConnected(false); } }).catch(function(){ setConnected(false); });
})();

</script>
</body></html>`;

// Admin-beheer klanten (DIR-30): simpele, functionele pagina achter ADMIN_PASSWORD.
// NB: geen ${}/backticks/backslash-escapes in de inline JS (template-literal-veiligheid).
const ADMIN_HTML = `<!doctype html>
<html lang="nl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dirk Digitaal — klantbeheer</title>
<style>
  body{ font-family:'Segoe UI',system-ui,Arial,sans-serif; max-width:760px; margin:2rem auto; padding:0 1rem; color:#171717; background:#f4f0e6; }
  h1{ font-size:1.3rem; } h2{ font-size:1rem; margin-top:1.5rem; }
  input,button{ font:inherit; padding:.5rem; margin:.2rem 0; }
  input[type=text],input[type=password]{ width:100%; box-sizing:border-box; border:1px solid #999; }
  button{ background:#015092; color:#fff; border:0; cursor:pointer; border-radius:3px; }
  button.rood{ background:#b3402f; }
  .rij{ border:1px solid #ccc; background:#fff; padding:.6rem; margin:.4rem 0; border-radius:4px; }
  .rij b{ display:block; } .muted{ color:#666; font-size:.85rem; }
  .link{ width:100%; box-sizing:border-box; }
  #fout{ color:#b3402f; } .verborgen{ display:none; }
</style></head><body>
  <h1>Dirk Digitaal — klantbeheer (Meta)</h1>
  <p class="muted">Voeg per klant een naam + Meta ad-account-id toe. Je krijgt een unieke link die je de klant stuurt; die link toont alleen zijn eigen Meta-data.</p>
  <div id="login">
    <h2>Inloggen</h2>
    <input id="pw" type="password" placeholder="Admin-wachtwoord" autocomplete="current-password">
    <button id="loginBtn">Inloggen</button>
  </div>
  <div id="beheer" class="verborgen">
    <h2>Je Meta-accounts</h2>
    <p class="muted">Automatisch opgehaald via het system-token. Klik "Magic-link maken" bij een account om de klant te koppelen.</p>
    <div id="accounts"></div>
    <h2>Gekoppelde klanten</h2>
    <div id="lijst"></div>
    <h2>Handmatig toevoegen (optioneel)</h2>
    <input id="naam" type="text" placeholder="Naam (bijv. Bas van Genderen)">
    <input id="acct" type="text" placeholder="Meta ad-account-id (bijv. act_1234567890 of 1234567890)">
    <button id="addBtn">Toevoegen + link maken</button>
  </div>
  <p id="fout"></p>
<script>
  var fout=document.getElementById('fout');
  function toon(el,v){ el.className = v ? '' : 'verborgen'; }
  function meld(t){ fout.textContent = t || ''; }
  function api(method, path, data){
    var opt={ method:method, headers:{'Content-Type':'application/json'} };
    if(data) opt.body=JSON.stringify(data);
    return fetch(path, opt).then(function(r){ return r.json().then(function(j){ return {ok:r.ok, j:j}; }); });
  }
  function render(clients){
    var lijst=document.getElementById('lijst'); lijst.textContent='';
    if(!clients || !clients.length){ var p=document.createElement('p'); p.className='muted'; p.textContent='Nog geen klanten.'; lijst.appendChild(p); return; }
    clients.forEach(function(c){
      var d=document.createElement('div'); d.className='rij';
      var b=document.createElement('b'); b.textContent=c.naam+'  ('+c.adAccountId+')'; d.appendChild(b);
      var inp=document.createElement('input'); inp.className='link'; inp.type='text'; inp.readOnly=true;
      inp.value=location.origin+'/?k='+c.key; inp.addEventListener('focus',function(){ inp.select(); });
      d.appendChild(inp);
      var del=document.createElement('button'); del.className='rood'; del.textContent='Verwijderen';
      del.addEventListener('click',function(){ api('DELETE','/api/admin/clients?key='+encodeURIComponent(c.key)).then(laad); });
      d.appendChild(del);
      lijst.appendChild(d);
    });
  }
  function renderAccounts(accounts, clients){
    var box=document.getElementById('accounts'); box.textContent='';
    var gekoppeld={}; (clients||[]).forEach(function(c){ gekoppeld[c.adAccountId]=true; });
    if(!accounts || !accounts.length){ var p=document.createElement('p'); p.className='muted'; p.textContent='Geen Meta-accounts gevonden (of nog niet geconfigureerd).'; box.appendChild(p); return; }
    accounts.forEach(function(a){
      var d=document.createElement('div'); d.className='rij';
      var b=document.createElement('b'); b.textContent=a.name+'  ('+a.act+')'; d.appendChild(b);
      if(gekoppeld[a.act]){ var s=document.createElement('span'); s.className='muted'; s.textContent='Al gekoppeld'; d.appendChild(s); }
      else {
        var mk=document.createElement('button'); mk.textContent='Magic-link maken';
        mk.addEventListener('click',function(){ meld(''); api('POST','/api/admin/clients',{ naam:a.name, adAccountId:a.act }).then(function(res){ if(!res.ok){ meld(res.j.error||'Koppelen mislukt.'); return; } laad(); }); });
        d.appendChild(mk);
      }
      box.appendChild(d);
    });
  }
  function laadAccounts(clients){
    var box=document.getElementById('accounts'); box.textContent='Meta-accounts laden...';
    api('GET','/api/admin/meta-accounts').then(function(res){
      if(!res.ok){ box.textContent=(res.j&&res.j.error)||'Kon Meta-accounts niet ophalen.'; return; }
      renderAccounts(res.j.accounts||[], clients);
    });
  }
  function laad(){
    api('GET','/api/admin/clients').then(function(res){
      if(!res.ok){ toon(document.getElementById('beheer'),false); toon(document.getElementById('login'),true); return; }
      toon(document.getElementById('login'),false); toon(document.getElementById('beheer'),true);
      var clients=res.j.clients||[]; render(clients); laadAccounts(clients);
    });
  }
  document.getElementById('loginBtn').addEventListener('click',function(){
    meld(''); api('POST','/api/admin/login',{ password:document.getElementById('pw').value }).then(function(res){
      if(!res.ok){ meld(res.j.error||'Inloggen mislukt.'); return; } laad();
    });
  });
  document.getElementById('addBtn').addEventListener('click',function(){
    meld(''); var naam=document.getElementById('naam').value, acct=document.getElementById('acct').value;
    api('POST','/api/admin/clients',{ naam:naam, adAccountId:acct }).then(function(res){
      if(!res.ok){ meld(res.j.error||'Toevoegen mislukt.'); return; }
      document.getElementById('naam').value=''; document.getElementById('acct').value=''; laad();
    });
  });
  laad();
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
      const resp = await callAnthropic(env, system, convo, [gscTool()]);
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

// GA4-property kiezen: overzicht laden + in de sessie zetten (ga4-historie schoon).
async function selectGa4Property(stub, token, property, alleProps) {
  const overview = await fetchGa4Overview(token, property);
  if (!overview) return null;
  const ga4 = { properties: alleProps, actief: property, ...overview };
  await stub.fetch("https://do/chat/select-ga4", { method: "POST", body: JSON.stringify({ ga4 }) });
  return ga4;
}

// Gertjan-chat (GA4). Zelfde vorm als handleChat, maar met GA4-state/tool/persona.
async function handleGa4Chat(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "De agent is nog niet geconfigureerd (API-sleutel ontbreekt)." }, 500);
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  const id = cookies[COOKIE];
  if (!id) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account." }, 401);

  const stub = sessionStub(env, id);
  const stateResp = await stub.fetch("https://do/chat/state-ga4");
  if (!stateResp.ok) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account." }, 401);
  let { token, messages: history, ga4 } = await stateResp.json();

  let body = {};
  try { body = await request.json(); } catch (e) { /* lege body toegestaan */ }
  const wantProp = (body && typeof body.property === "string") ? body.property.trim() : "";
  let userText = (body && typeof body.message === "string") ? body.message.trim() : "";

  let promptText;
  let storedUser = userText;

  if (wantProp) {
    const props = await fetchGa4Properties(token);
    if (!props || !props.length) return json({ error: "Geen GA4-properties gevonden in je account." }, 502);
    if (!props.some((p) => p.property === wantProp)) return json({ error: "Die property staat niet in je account." }, 400);
    ga4 = await selectGa4Property(stub, token, wantProp, props);
    if (!ga4) return json({ error: "Kon de GA4-cijfers van die property niet laden." }, 502);
    history = [];
    promptText = GA4_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + wantProp + "]";
  } else if (!ga4) {
    const props = await fetchGa4Properties(token);
    if (!props || !props.length) return json({ error: "Geen GA4-properties gevonden in je account." }, 502);
    if (props.length > 1) return json({ needProperty: true, properties: props });
    ga4 = await selectGa4Property(stub, token, props[0].property, props);
    if (!ga4) return json({ error: "Kon de GA4-cijfers van je property niet laden." }, 502);
    history = [];
    promptText = GA4_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + props[0].property + "]";
  } else {
    if (!userText) return json({ error: "Stel een vraag over je GA4-cijfers." }, 400);
    promptText = userText;
  }

  const system = buildGa4SystemPrompt(ga4);
  const property = ga4 && ga4.actief;
  const convo = buildAnthropicMessages(history, promptText);

  let finalText = "";
  try {
    for (let i = 0; i < 5; i++) {
      const resp = await callAnthropic(env, system, convo, [ga4Tool()]);
      if (!resp || !resp.content) {
        return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
      }
      const parsed = parseAssistant(resp.content);
      if (resp.stop_reason === "tool_use" && parsed.toolUses.length) {
        convo.push({ role: "assistant", content: resp.content });
        const resultaten = [];
        for (const tu of parsed.toolUses) {
          let out;
          try { out = await fetchGa4Query(token, property, tu.input); }
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
    stub.fetch("https://do/chat/append-ga4", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: storedUser }, { role: "assistant", content: finalText }] }),
    }).catch(() => {})
  );

  return sseResponse(finalText);
}

// Ads-account kiezen: overzicht laden + in de sessie zetten (ads-historie schoon).
async function selectAdsCustomer(stub, token, env, customer, alle, loginCid) {
  const overview = await fetchAdsOverview(token, env, customer, loginCid);
  if (!overview) return null;
  const ads = { accounts: alle, actief: customer, ...overview, loginCid: loginCid || adsCustomerId(customer) };
  await stub.fetch("https://do/chat/select-ads", { method: "POST", body: JSON.stringify({ ads }) });
  return ads;
}

// Ilona-chat (Google Ads). Zelfde vorm als handleChat/handleGa4Chat.
async function handleAdsChat(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "De agent is nog niet geconfigureerd (API-sleutel ontbreekt)." }, 500);
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  const id = cookies[COOKIE];
  if (!id) return json({ error: "Niet gekoppeld. Koppel Google Ads, of open je persoonlijke Meta-link." }, 401);

  // Klant-scoping (DIR-30): de magic-link-sleutel bepaalt (via KV) welk Meta-account.
  const klant = await kvGetClient(env, cookies[KLANT_COOKIE]);
  const metaOn = !!(klant && metaConfigured(env));
  const metaacct = klant ? klant.adAccountId : "";

  const stub = sessionStub(env, id);
  const stateResp = await stub.fetch("https://do/chat/state-ilona");
  if (!stateResp.ok) return json({ error: "Je sessie is verlopen. Herlaad de pagina." }, 401);
  let { token, messages: history, ads } = await stateResp.json();

  const googleAds = !!(token && env.GOOGLE_ADS_DEVELOPER_TOKEN);
  if (!googleAds && !metaOn) {
    return json({ error: "Nog geen advertentie-bron. Koppel Google Ads, of open je persoonlijke Meta-link." }, 401);
  }

  let body = {};
  try { body = await request.json(); } catch (e) { /* lege body toegestaan */ }
  const wantCustomer = (body && typeof body.customer === "string") ? body.customer.trim() : "";
  let userText = (body && typeof body.message === "string") ? body.message.trim() : "";

  let promptText;
  let storedUser = userText;

  if (googleAds && wantCustomer) {
    const res = await fetchAdsCustomers(token, env);
    if (res.error) return json({ error: res.error }, 502);
    const acct = res.accounts.find((a) => a.customer === wantCustomer);
    if (!acct) return json({ error: "Dat account staat niet in je koppeling." }, 400);
    ads = await selectAdsCustomer(stub, token, env, acct.customer, res.accounts, acct.loginCid);
    if (!ads) return json({ error: "Kon de Google Ads-cijfers van dat account niet laden." }, 502);
    history = [];
    promptText = ADS_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + (acct.naam || acct.customer) + "]";
  } else if (googleAds && !ads && !userText) {
    const res = await fetchAdsCustomers(token, env);
    if (res.error) return json({ error: res.error }, 502);
    const accounts = res.accounts;
    if (accounts.length > 1) return json({ needAccount: true, accounts });
    ads = await selectAdsCustomer(stub, token, env, accounts[0].customer, accounts, accounts[0].loginCid);
    if (!ads) return json({ error: "Kon de Google Ads-cijfers van je account niet laden." }, 502);
    history = [];
    promptText = ADS_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + (accounts[0].naam || accounts[0].customer) + "]";
  } else if (userText) {
    promptText = userText;
  } else if (metaOn) {
    promptText = "Geef een kort overzicht van de Meta-advertentieprestaties. Gebruik de meta_report-tool voor live cijfers en benoem duidelijk dat het om Meta gaat.";
    storedUser = "[Meta-overzicht]";
  } else {
    return json({ error: "Stel een vraag over je advertentiecijfers." }, 400);
  }

  let system = buildAdsSystemPrompt(ads);
  const tools = [];
  if (googleAds) tools.push(adsTool());
  if (metaOn) {
    tools.push(metaTool());
    system += "\n\nMeta Ads is beschikbaar voor deze klant" + (klant.naam ? " (" + klant.naam + ")" : "") +
      " — gebruik de meta_report-tool voor live Meta-cijfers en benoem duidelijk dat het om Meta gaat.";
  }
  if (!googleAds) system += "\n\nGoogle Ads is voor deze bezoeker niet gekoppeld; als daarnaar gevraagd wordt, zeg dat vriendelijk.";

  const customer = ads && ads.actief;
  const loginCid = ads && ads.loginCid;   // MCC-id als login-customer-id voor subaccounts (AC-2)
  const convo = buildAnthropicMessages(history, promptText);

  let finalText = "";
  try {
    for (let i = 0; i < 5; i++) {
      const resp = await callAnthropic(env, system, convo, tools);
      if (!resp || !resp.content) {
        return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
      }
      const parsed = parseAssistant(resp.content);
      if (resp.stop_reason === "tool_use" && parsed.toolUses.length) {
        convo.push({ role: "assistant", content: resp.content });
        const resultaten = [];
        for (const tu of parsed.toolUses) {
          let out;
          try {
            if (tu.name === "meta_report") out = metaOn ? await fetchMetaInsights(env, metaacct, tu.input) : { error: "Meta niet beschikbaar in deze sessie." };
            else out = await fetchAdsReport(token, env, customer, tu.input, loginCid);
          } catch (e) { out = { error: "kon deze data niet ophalen" }; }
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
    stub.fetch("https://do/chat/append-ads", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: storedUser }, { role: "assistant", content: finalText }] }),
    }).catch(() => {})
  );

  return sseResponse(finalText);
}

// Anton (content/tekst): pure Claude-agent, geen databron/koppeling (DIR-39).
async function handleContentChat(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "De agent is nog niet geconfigureerd (API-sleutel ontbreekt)." }, 500);
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  let id = cookies[COOKIE];
  let setCookie = null;
  if (!id) { id = crypto.randomUUID(); setCookie = sessionCookie(id, Math.floor(SESSION_TTL_MS / 1000)); }
  const stub = sessionStub(env, id);
  await stub.fetch("https://do/touch", { method: "POST" }).catch(() => {});
  let history = [];
  try { const r = await stub.fetch("https://do/chat/state-content"); if (r.ok) history = (await r.json()).messages || []; } catch (e) { /* stateless fallback */ }

  let body = {};
  try { body = await request.json(); } catch (e) { /* leeg */ }
  const userText = (body && typeof body.message === "string") ? body.message.trim() : "";
  if (!userText) return json({ error: "Plak een tekst of stel een vraag." }, 400);

  const system = buildContentSystemPrompt();
  const convo = buildAnthropicMessages(history, userText);

  let finalText = "";
  try {
    const resp = await callAnthropic(env, system, convo, []);
    if (!resp || !resp.content) return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
    finalText = parseAssistant(resp.content).text;
  } catch (e) {
    return json({ error: "Kon de AI-agent niet bereiken. Probeer het zo opnieuw." }, 502);
  }
  if (!finalText) finalText = "Ik kon je vraag nu niet beantwoorden. Probeer het iets anders te formuleren.";

  ctx.waitUntil(
    stub.fetch("https://do/chat/append-content", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: userText }, { role: "assistant", content: finalText }] }),
    }).catch(() => {})
  );

  return sseResponse(finalText, setCookie ? { "Set-Cookie": setCookie } : undefined);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const origin = url.origin;
    const redirectUri = origin + "/oauth/callback";

    // Startpagina: het 2D retro-kantoor (DIR-14). Met ?k=<sleutel> = klant-magic-link
    // (DIR-30): valideer de sleutel in KV, scope de sessie tot dat account, veeg de URL schoon.
    if (path === "/" && request.method === "GET") {
      const k = url.searchParams.get("k");
      if (k) {
        const klant = await kvGetClient(env, k);
        if (klant) {
          let sid = parseCookies(request.headers.get("Cookie"))[COOKIE];
          const setC = [];
          if (!sid) { sid = crypto.randomUUID(); setC.push(sessionCookie(sid, Math.floor(SESSION_TTL_MS / 1000))); }
          await sessionStub(env, sid).fetch("https://do/touch", { method: "POST" });
          setC.push(`${KLANT_COOKIE}=${encodeURIComponent(k)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
          const headers = new Headers({ Location: origin + "/" });
          for (const c of setC) headers.append("Set-Cookie", c);
          return new Response(null, { status: 302, headers });
        }
        // Onbekende/ongeldige sleutel → gewoon het kantoor, zonder Meta-scoping (AC-6).
      }
      return new Response(OFFICE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Iso-scène preview (DIR-49, WIP): alias van de echte scène `/` zodat de
    // critics de geïntegreerde iso-scène (agents + hond + chat) zien.
    if (path === "/iso" && request.method === "GET") {
      return new Response(OFFICE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    // Admin-beheer klanten (DIR-30) — achter ADMIN_PASSWORD.
    if (path === "/admin" && request.method === "GET") {
      return new Response(ADMIN_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    if (path === "/api/admin/login" && request.method === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "Admin niet geconfigureerd (ADMIN_PASSWORD ontbreekt)." }, 500);
      let b = {}; try { b = await request.json(); } catch (e) { /* leeg */ }
      if (!b || !veiligGelijk(String(b.password || ""), env.ADMIN_PASSWORD)) return json({ error: "Onjuist wachtwoord." }, 401);
      const val = await adminCookieValue(env);
      return json({ ok: true }, 200, { "Set-Cookie": `${ADMIN_COOKIE}=${val}; Path=/; HttpOnly; Secure; SameSite=Lax` });
    }
    if (path === "/api/admin/logout" && request.method === "POST") {
      return json({ ok: true }, 200, { "Set-Cookie": `${ADMIN_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }
    // DIR-40 — admin: Meta ad-accounts automatisch oplijsten via het system-token.
    if (path === "/api/admin/meta-accounts" && request.method === "GET") {
      if (!(await isAdmin(request, env))) return json({ error: "Alleen voor admin. Log eerst in." }, 401);
      if (!metaConfigured(env)) return json({ error: "Meta is nog niet geconfigureerd (system-token/app-secret ontbreekt)." }, 500);
      const accounts = await fetchMetaAdAccounts(env);
      if (accounts === null) return json({ error: "Kon je Meta ad-accounts niet ophalen bij Facebook." }, 502);
      return json({ accounts });
    }
    if (path === "/api/admin/clients") {
      if (!(await isAdmin(request, env))) return json({ error: "Alleen voor admin. Log eerst in." }, 401);
      if (!env.CLIENTS) return json({ error: "KV (CLIENTS) is nog niet geconfigureerd." }, 500);
      if (request.method === "GET") return json({ clients: await kvListClients(env) });
      if (request.method === "POST") {
        let b = {}; try { b = await request.json(); } catch (e) { /* leeg */ }
        const naam = (b && b.naam || "").trim();
        const acct = (b && b.adAccountId || "").trim();
        if (!naam || !acct) return json({ error: "Naam en ad-account-id zijn verplicht." }, 400);
        const rec = await kvAddClient(env, naam, acct);
        return json({ client: rec, link: origin + "/?k=" + rec.key });
      }
      if (request.method === "DELETE") {
        const key = url.searchParams.get("key");
        if (!key) return json({ error: "Geef ?key=<sleutel>." }, 400);
        await kvDeleteClient(env, key);
        return json({ ok: true });
      }
      return json({ error: "Methode niet toegestaan." }, 405);
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

    // DIR-28 — GA4/Gertjan: properties oplijsten (AC-2).
    if (path === "/api/ga4/properties") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account via /oauth/start." }, 401);
      const props = await fetchGa4Properties(token);
      if (!props) return json({ error: "Kon je GA4-properties niet ophalen bij Google." }, 502);
      return json({ properties: props });
    }

    // DIR-28 — GA4-rapport draaien voor een property (AC-3).
    if (path === "/api/ga4/report") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account via /oauth/start." }, 401);
      const property = url.searchParams.get("property");
      if (!property) return json({ error: "Geef een property op via ?property=properties/<id>." }, 400);
      const out = await fetchGa4Query(token, property, {
        metric: url.searchParams.get("metric"),
        dimension: url.searchParams.get("dimension"),
        days: url.searchParams.get("days"),
        filter_value: url.searchParams.get("filter_value"),
        row_limit: url.searchParams.get("row_limit"),
      });
      if (out && out.error) return json(out, 502);
      return json(out);
    }

    // DIR-28 — Gertjan-agent (GA4): streaming chat met live tool-use (AC-4/AC-5).
    if (path === "/api/ga4/chat" && request.method === "POST") {
      return handleGa4Chat(request, env, ctx);
    }

    // DIR-30 — Google Ads/Ilona: toegankelijke accounts (AC-2).
    if (path === "/api/ads/customers") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account via /oauth/start." }, 401);
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) return json({ error: "Google Ads is nog niet geconfigureerd (developer-token ontbreekt)." }, 500);
      const res = await fetchAdsCustomers(token, env);
      if (res.error) return json({ error: res.error }, 502);
      return json({ accounts: res.accounts });
    }

    // DIR-30 — Google Ads-rapport voor een account (AC-3).
    if (path === "/api/ads/report") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account via /oauth/start." }, 401);
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) return json({ error: "Google Ads is nog niet geconfigureerd (developer-token ontbreekt)." }, 500);
      const customer = url.searchParams.get("customer");
      if (!customer) return json({ error: "Geef een account op via ?customer=customers/<id>." }, 400);
      const loginCustomer = url.searchParams.get("login_customer") || customer;   // MCC-id voor subaccounts (AC-2)
      const out = await fetchAdsReport(token, env, customer, {
        report: url.searchParams.get("report"),
        days: url.searchParams.get("days"),
        row_limit: url.searchParams.get("row_limit"),
      }, loginCustomer);
      if (out && out.error) return json(out, 502);
      return json(out);
    }

    // DIR-30 — Ilona-agent (Google Ads): streaming chat met live tool-use (AC-4/AC-5).
    if (path === "/api/ads/chat" && request.method === "POST") {
      return handleAdsChat(request, env, ctx);
    }

    // DIR-42 — of deze sessie een klant-magic-link-context met Meta heeft (voor de Meta-knop).
    if (path === "/api/meta/status" && request.method === "GET") {
      const cookies = parseCookies(request.headers.get("Cookie"));
      const klant = await kvGetClient(env, cookies[KLANT_COOKIE]);
      return json({ available: !!(klant && metaConfigured(env)), naam: klant ? klant.naam : null });
    }

    // DIR-39 — Anton (content/tekst): pure Claude-agent, geen koppeling.
    if (path === "/api/content/chat" && request.method === "POST") {
      return handleContentChat(request, env, ctx);
    }

    return json({ error: "Onbekende route." }, 404);
  },
};
