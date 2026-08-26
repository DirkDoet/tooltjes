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
const GADS_VERSION = "v18";
const GADS_BASE = "https://googleads.googleapis.com/" + GADS_VERSION;

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
  // ---- Ilona — Google Ads (Meta volgt later) ----
  ilona: {
    persona: [
      "Je bent Ilona, de advertentie-specialist van Dirk Digitaal (Google Ads; Meta volgt later).",
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

// Toegankelijke Google Ads-accounts → [{customer, id}].
async function fetchAdsCustomers(token, env) {
  const resp = await fetch(GADS_BASE + "/customers:listAccessibleCustomers", { headers: adsHeaders(token, env) });
  if (!resp.ok) return null;
  const data = await resp.json();
  return (data.resourceNames || []).map((rn) => ({ customer: rn, id: adsCustomerId(rn) }));
}

// Eén GAQL-query uitvoeren (googleAds:search) → JSON of null.
async function runAdsSearch(token, env, customer, query) {
  const cid = adsCustomerId(customer);
  if (!cid) return null;
  const resp = await fetch(GADS_BASE + "/customers/" + cid + "/googleAds:search", {
    method: "POST",
    headers: adsHeaders(token, env, customer),
    body: JSON.stringify({ query }),
  });
  if (!resp.ok) return null;
  return resp.json();
}

// Tool-call: een rapport live ophalen voor het gekozen account.
async function fetchAdsReport(token, env, customer, args) {
  if (!customer) return { error: "Geen account gekozen." };
  const q = buildAdsQuery(args, Date.now());
  const data = await runAdsSearch(token, env, customer, q.query);
  if (!data) return { error: "Kon deze Google Ads-data niet ophalen bij Google." };
  return { periode: { van: q.startDate, tot: q.endDate }, rapport: q.report, rijen: shapeAdsRows(data.results, q.jsonPath) };
}

// Eerste-analyse-data: campagne-totalen + top campagnes van de laatste 28 dagen (AC-5).
async function fetchAdsOverview(token, env, customer) {
  const q = buildAdsQuery({ report: "campaigns", days: 28, row_limit: 15 }, Date.now());
  const data = await runAdsSearch(token, env, customer, q.query);
  if (!data) return null;
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
  /* Hond (DIR-32): JS-gedreven, orthogonaal, zit/ligt bij de mand. */
  .dog{ position:absolute; bottom:6%; left:6%; width:9%; pointer-events:none;
    transition:left .6s linear, bottom .6s linear; }
  .dog.links{ transform:scaleX(-1); }
  .dog.loopt .dogleg-a{ animation:dd-legA .34s steps(1) infinite; }
  .dog.loopt .dogleg-b{ animation:dd-legB .34s steps(1) infinite; }
  .dog .dogbody{ transform-origin:bottom center; transition:transform .4s ease; }
  .dog.zit .dogbody{ transform:translateY(4px) scaleY(.82); }
  .dog.ligt .dogbody{ transform:translateY(9px) scaleY(.48); }
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
  @keyframes dd-walkbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-2px)}}
  @keyframes dd-stretch{0%,100%{transform:translateY(0) scaleY(1)}45%{transform:translateY(-3px) scaleY(1.06)}}
  #agent-desk.away #albert-body, #agent-desk.away .albert-hand{ opacity:0; }
  #agent-desk.rekt #albert-body{ animation:dd-stretch 2.2s ease-in-out; }
  #gertjan-desk.away #gertjan-body, #gertjan-desk.away .gertjan-hand{ opacity:0; }
  #gertjan-desk.rekt #gertjan-body{ animation:dd-stretch 2.2s ease-in-out; }
  #ilona-desk.away #ilona-body, #ilona-desk.away .ilona-hand{ opacity:0; }
  #ilona-desk.rekt #ilona-body{ animation:dd-stretch 2.2s ease-in-out; }
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
      <!-- Gertjan (GA4-agent), actief + klikbaar (DIR-29) -->
      <!-- Gertjan: links-van-midden, ACHTER (DIR-37) -->
      <g id="gertjan-desk" role="button" tabindex="0" aria-label="Open de GA4-agent Gertjan">
        <rect x="286" y="204" width="104" height="114" fill="#000" opacity="0"/>
        <g id="gertjan-body" style="transform-origin:332px 288px;animation:dd-albert-idle 6s ease-in-out infinite">
          <use href="#gertjan" x="308" y="234" width="48" height="58"/>
        </g>
        <use href="#deskEmpty" x="286" y="232" width="104" height="83"/>
        <g class="gertjan-hand" style="transform-origin:322px 292px;animation:dd-type-l .5s steps(2) infinite">
          <rect x="319" y="284" width="5" height="8" fill="#c7ccd2"/>
          <rect x="318" y="291" width="8" height="5" fill="#e8b98a"/>
        </g>
        <g class="gertjan-hand" style="transform-origin:338px 292px;animation:dd-type-r .5s steps(2) infinite">
          <rect x="335" y="284" width="5" height="8" fill="#c7ccd2"/>
          <rect x="333" y="291" width="8" height="5" fill="#e8b98a"/>
        </g>
        <rect x="290" y="206" width="100" height="24" fill="#0b1219"/>
        <rect x="290" y="206" width="100" height="24" fill="none" stroke="#3fd06a" stroke-width="1.5"/>
        <circle cx="300" cy="214" r="3.5" fill="#3fd06a" style="animation:dd-blink 2s steps(1) infinite"/>
        <text x="340" y="216" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="700" font-size="9" fill="#f4f0e6">Gertjan</text>
        <text x="340" y="225" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="600" font-size="6.5" fill="#c2ccd4">GA4-data-specialist</text>
      </g>
      <!-- Leeg: rechts-van-midden, ACHTER -->
      <!-- Ilona (Ads-agent), actief + klikbaar (DIR-36) -->
      <g id="ilona-desk" role="button" tabindex="0" aria-label="Open de Ads-agent Ilona">
        <rect x="410" y="204" width="104" height="114" fill="#000" opacity="0"/>
        <g id="ilona-body" style="transform-origin:448px 288px;animation:dd-albert-idle 6.5s ease-in-out infinite">
          <use href="#ilona" x="424" y="234" width="48" height="58"/>
        </g>
        <use href="#deskEmpty" x="410" y="232" width="104" height="83"/>
        <g class="ilona-hand" style="transform-origin:446px 292px;animation:dd-type-l .5s steps(2) infinite">
          <rect x="443" y="284" width="5" height="8" fill="#2f7f6e"/>
          <rect x="442" y="291" width="8" height="5" fill="#f0c79a"/>
        </g>
        <g class="ilona-hand" style="transform-origin:462px 292px;animation:dd-type-r .5s steps(2) infinite">
          <rect x="459" y="284" width="5" height="8" fill="#2f7f6e"/>
          <rect x="457" y="291" width="8" height="5" fill="#f0c79a"/>
        </g>
        <rect x="414" y="206" width="100" height="24" fill="#0b1219"/>
        <rect x="414" y="206" width="100" height="24" fill="none" stroke="#e58fa8" stroke-width="1.5"/>
        <circle cx="424" cy="214" r="3.5" fill="#e58fa8" style="animation:dd-blink 2s steps(1) infinite"/>
        <text x="464" y="216" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="700" font-size="9" fill="#f4f0e6">Ilona</text>
        <text x="464" y="225" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="600" font-size="6.5" fill="#c2ccd4">Google Ads-specialist</text>
      </g>
      <!-- Leeg: rechts-VOOR, op één lijn met Albert -->
      <use href="#deskEmpty" x="458" y="250" width="120" height="96"/>
      <!-- koffieautomaat (DIR-26) -->
      <g>
        <rect x="40" y="250" width="30" height="52" fill="#2b2f36"/>
        <rect x="40" y="250" width="30" height="6" fill="#3a3f47"/>
        <rect x="44" y="258" width="22" height="14" fill="#0e1216"/>
        <rect x="46" y="261" width="10" height="3" fill="#F18E02"/>
        <rect x="46" y="266" width="14" height="2" fill="#3fd06a"/>
        <rect x="48" y="278" width="14" height="10" fill="#1a1e24"/>
        <rect x="52" y="282" width="6" height="6" fill="#e8e2d8"/>
        <rect x="40" y="298" width="30" height="4" fill="#15181d"/>
      </g>
      <!-- printer (DIR-26) -->
      <g>
        <rect x="574" y="262" width="28" height="6" fill="#f4f0e6"/>
        <rect x="572" y="266" width="32" height="6" fill="#2b2f36"/>
        <rect x="566" y="270" width="44" height="26" fill="#3a3f47"/>
        <rect x="566" y="270" width="44" height="6" fill="#4a505a"/>
        <rect x="570" y="280" width="10" height="3" fill="#3fd06a"/>
        <rect x="584" y="280" width="4" height="3" fill="#F18E02"/>
        <rect x="566" y="296" width="44" height="4" fill="#20242a"/>
      </g>
      <g id="agent-desk" role="button" tabindex="0" aria-label="Open de GSC-agent">
        <rect x="146" y="220" width="150" height="126" fill="#000" opacity="0"/>
        <rect x="196" y="256" width="42" height="46" fill="#111"/>
        <rect x="200" y="260" width="34" height="30" fill="#1c1c1c"/>
        <g id="albert-body" style="transform-origin:218px 300px;animation:dd-albert-idle 5.5s ease-in-out infinite">
          <use href="#albert" x="186" y="238" width="64" height="77"/>
        </g>
        <rect x="180" y="304" width="104" height="10" fill="#2b2b2b"/>
        <rect x="180" y="314" width="104" height="34" fill="#141414"/>
        <rect x="186" y="314" width="5" height="34" fill="#0c0c0c"/>
        <rect x="273" y="314" width="5" height="34" fill="#0c0c0c"/>
        <rect x="252" y="298" width="8" height="8" fill="#0c0c0c"/>
        <rect x="246" y="278" width="36" height="24" fill="#0a0a0a"/>
        <rect x="250" y="282" width="28" height="16" fill="#3a2400"/>
        <rect x="252" y="284" width="14" height="2" fill="#F18E02"/>
        <rect x="252" y="288" width="20" height="2" fill="#c97400"/>
        <rect x="252" y="292" width="10" height="2" fill="#F18E02"/>
        <rect x="196" y="306" width="34" height="7" fill="#3a3f47"/>
        <rect x="198" y="307" width="30" height="2" fill="#20242a"/>
        <rect x="198" y="310" width="30" height="2" fill="#20242a"/>
        <!-- typende handen/armen (DIR-25) -->
        <g class="albert-hand" style="transform-origin:210px 303px;animation:dd-type-l .5s steps(2) infinite">
          <rect x="205" y="293" width="6" height="9" fill="#e58fa8"/>
          <rect x="204" y="300" width="9" height="6" fill="#e8b98a"/>
        </g>
        <g class="albert-hand" style="transform-origin:227px 303px;animation:dd-type-r .5s steps(2) infinite">
          <rect x="226" y="293" width="6" height="9" fill="#e58fa8"/>
          <rect x="223" y="300" width="9" height="6" fill="#e8b98a"/>
        </g>
        <rect x="170" y="206" width="96" height="24" fill="#0b1219"/>
        <rect x="170" y="206" width="96" height="24" fill="none" stroke="#F18E02" stroke-width="1.5"/>
        <circle cx="180" cy="214" r="3.5" fill="#3fd06a" style="animation:dd-blink 2s steps(1) infinite"/>
        <text x="221" y="216" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="700" font-size="9" fill="#f4f0e6">Albert</text>
        <text x="218" y="225" text-anchor="middle" font-family="'Segoe UI',system-ui,Arial,sans-serif" font-weight="600" font-size="6.5" fill="#c2ccd4">GSC / SEO-specialist</text>
      </g>
      <ellipse cx="86" cy="336" rx="46" ry="12" fill="#2a2f34"/>
      <ellipse cx="86" cy="334" rx="38" ry="9" fill="#6d3b8f" opacity="0.55"/>
      <ellipse cx="86" cy="333" rx="30" ry="6" fill="#824aa8" opacity="0.5"/>
      <polygon points="0,300 640,300 640,360 0,360" fill="#000" opacity="0.10"/>
    </svg>

    <div class="dog" aria-hidden="true">
      <svg class="dogbody" viewBox="0 0 60 40" width="100%" shape-rendering="crispEdges" style="image-rendering:pixelated;display:block;">
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
        <g class="dogleg dogleg-a">
          <rect x="12" y="26" width="5" height="9" fill="#b8842f"/>
          <rect x="34" y="26" width="5" height="9" fill="#b8842f"/>
        </g>
        <g class="dogleg dogleg-b">
          <rect x="20" y="26" width="5" height="9" fill="#c99a4e"/>
          <rect x="42" y="26" width="5" height="9" fill="#c99a4e"/>
        </g>
      </svg>
    </div>

    <!-- Rondlopende agents (DIR-32): verborgen tot een kantooractie; klik opent chat. -->
    <div class="roam" id="albert-roam" role="button" tabindex="0" aria-label="Open de GSC-agent (Albert)">
      <div class="roam-fig">
        <svg viewBox="0 0 40 56" width="100%" shape-rendering="crispEdges" style="image-rendering:pixelated;display:block;">
          <use href="#albert" x="0" y="0" width="40" height="48"/>
          <g class="poot poot-a"><rect x="14" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="poot poot-b"><rect x="21" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="draag draag-koffie"><rect x="30" y="30" width="7" height="8" fill="#e8e2d8"/><rect x="30" y="30" width="7" height="2" fill="#c9c2b4"/><rect x="37" y="32" width="2" height="3" fill="#e8e2d8"/></g>
          <g class="draag draag-papier"><rect x="30" y="28" width="8" height="11" fill="#f4f0e6"/><rect x="32" y="31" width="4" height="1" fill="#9aa2aa"/><rect x="32" y="34" width="4" height="1" fill="#9aa2aa"/></g>
        </svg>
      </div>
    </div>
    <div class="roam" id="gertjan-roam" role="button" tabindex="0" aria-label="Open de GA4-agent (Gertjan)">
      <div class="roam-fig">
        <svg viewBox="0 0 40 56" width="100%" shape-rendering="crispEdges" style="image-rendering:pixelated;display:block;">
          <use href="#gertjan" x="0" y="0" width="40" height="48"/>
          <g class="poot poot-a"><rect x="14" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="poot poot-b"><rect x="21" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="draag draag-koffie"><rect x="30" y="30" width="7" height="8" fill="#e8e2d8"/><rect x="30" y="30" width="7" height="2" fill="#c9c2b4"/><rect x="37" y="32" width="2" height="3" fill="#e8e2d8"/></g>
          <g class="draag draag-papier"><rect x="30" y="28" width="8" height="11" fill="#f4f0e6"/><rect x="32" y="31" width="4" height="1" fill="#9aa2aa"/><rect x="32" y="34" width="4" height="1" fill="#9aa2aa"/></g>
        </svg>
      </div>
    </div>
    <div class="roam" id="ilona-roam" role="button" tabindex="0" aria-label="Open de Ads-agent (Ilona)">
      <div class="roam-fig">
        <svg viewBox="0 0 40 56" width="100%" shape-rendering="crispEdges" style="image-rendering:pixelated;display:block;">
          <use href="#ilona" x="0" y="0" width="40" height="48"/>
          <g class="poot poot-a"><rect x="14" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="poot poot-b"><rect x="21" y="47" width="5" height="9" fill="#2a3138"/></g>
          <g class="draag draag-koffie"><rect x="30" y="30" width="7" height="8" fill="#e8e2d8"/><rect x="30" y="30" width="7" height="2" fill="#c9c2b4"/><rect x="37" y="32" width="2" height="3" fill="#e8e2d8"/></g>
          <g class="draag draag-papier"><rect x="30" y="28" width="8" height="11" fill="#f4f0e6"/><rect x="32" y="31" width="4" height="1" fill="#9aa2aa"/><rect x="32" y="34" width="4" height="1" fill="#9aa2aa"/></g>
        </svg>
      </div>
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
    <header><b id="chat-title">GSC-agent</b><button class="x" id="chat-close" aria-label="Sluiten">X</button></header>
    <div class="chatrow">
      <div class="portret" aria-hidden="true">
        <div class="avatar" id="chat-avatar"><svg viewBox="0 0 40 48" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true"><use href="#albert"/></svg></div>
        <div class="pnaam" id="chat-pnaam">&#9679; Albert</div>
      </div>
      <div class="chatmain">
        <div class="msgs" id="chat-msgs">
          <div class="bubble agent">Hoi! Ik ben Albert, je GSC-agent. Koppel je Google-account, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.</div>
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
  var gertjanDesk=document.getElementById('gertjan-desk');
  var ilonaDesk=document.getElementById('ilona-desk');
  var notice=document.getElementById('privacy-notice');
  var titleEl=document.getElementById('chat-title');
  var avatarEl=document.getElementById('chat-avatar');
  var pnaamEl=document.getElementById('chat-pnaam');
  var connected=false, busy=false, started=false;

  // Agent-config: welke agent je aanklikt bepaalt portret, persona en endpoints (DIR-29).
  var AGENTS={
    gsc:{ key:'gsc', naam:'Albert', titel:'GSC-agent', sym:'albert', chat:'/api/chat', bron:'/api/gsc/sites',
      needKey:'needSite', listKey:'sites', selKey:'site', switchLabel:'Andere site',
      vraag:'Welke website wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je zoekcijfers...',
      intro:'Hoi! Ik ben Albert, je GSC-agent. Koppel je Google-account, dan geef ik je meteen een analyse van je zoekprestaties en kun je me alles vragen.',
      itemValue:function(x){return x;}, itemLabel:function(x){return x;} },
    ga4:{ key:'ga4', naam:'Gertjan', titel:'GA4-agent (Gertjan)', sym:'gertjan', chat:'/api/ga4/chat', bron:'/api/ga4/properties',
      needKey:'needProperty', listKey:'properties', selKey:'property', switchLabel:'Andere property',
      vraag:'Welke GA4-property wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je GA4-cijfers...',
      intro:'Hoi! Ik ben Gertjan, je GA4-data-specialist. Koppel je Google-account, dan geef ik je meteen een overzicht van je verkeer en kun je me alles vragen.',
      itemValue:function(x){return x&&x.property;}, itemLabel:function(x){return (x&&(x.displayName||x.property))||'';} },
    ads:{ key:'ads', naam:'Ilona', titel:'Ads-agent (Ilona)', sym:'ilona', chat:'/api/ads/chat', bron:'/api/ads/customers',
      needKey:'needAccount', listKey:'accounts', selKey:'customer', switchLabel:'Ander account',
      vraag:'Welk Google Ads-account wil je analyseren?', prefix:'Analyseer ', ph:'Stel een vraag over je advertentiecijfers...',
      intro:'Hoi! Ik ben Ilona, je Google Ads-specialist. Koppel je Google-account, dan geef ik je meteen een overzicht van je campagnes en kun je me alles vragen.',
      itemValue:function(x){return x&&x.customer;}, itemLabel:function(x){return (x&&(x.id||x.customer))||'';} } };
  var cur=AGENTS.gsc;

  function openChat(key){ if(key) useAgent(key); overlay.style.display='flex'; }
  function closeChat(){ overlay.style.display='none'; }
  function useAgent(key){
    if(cur.key===key) return;              // zelfde agent → gesprek behouden
    cur=AGENTS[key];
    titleEl.textContent=cur.titel;
    avatarEl.innerHTML='<svg viewBox="0 0 40 48" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true"><use href="#'+cur.sym+'"/></svg>';
    pnaamEl.innerHTML='&#9679; '+cur.naam;
    input.placeholder=cur.ph; switchBtn.textContent=cur.switchLabel;
    started=false; setActive(false); msgs.innerHTML=''; addBubble('agent', cur.intro);
    if(notice){ notice.style.display=connected?'none':'block'; notice.classList.remove('flash'); }
  }
  function setConnected(v){ connected=v; connectBtn.style.display=v?'none':'inline-block';
    if(notice) notice.style.display=v?'none':'block'; }
  function setActive(v){ composer.style.display=v?'flex':'none'; switchBtn.style.display=v?'inline-block':'none'; }
  function addBubble(who,text){ var b=document.createElement('div'); b.className='bubble '+who;
    b.textContent=text; msgs.appendChild(b); msgs.scrollTop=msgs.scrollHeight; return b; }
  function setTyping(b){ b.innerHTML='<span class="typing" role="status" aria-label="Agent is aan het typen"><i></i><i></i><i></i></span>'; }
  function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

  function connect(){ try{ sessionStorage.setItem('dd_agent', cur.key); }catch(e){} window.location.href='/oauth/start'; }

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

  async function streamChat(payload, dashboard){
    if(busy) return; busy=true; sendBtn.disabled=true;
    var bubble=addBubble('agent',''); setTyping(bubble); var got='';
    try{
      var r=await fetch(cur.chat,{ method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify(payload||{}) });
      var ct=r.headers.get('Content-Type')||'';
      if(!r.ok||ct.indexOf('application/json')!==-1){
        var j={}; try{ j=await r.json(); }catch(e){}
        if(j&&j[cur.needKey]){ bubble.remove(); renderPicker(j[cur.listKey]); busy=false; sendBtn.disabled=false; return; }
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
  document.getElementById('chat-close').addEventListener('click',closeChat);
  connectBtn.addEventListener('click',connect);
  switchBtn.addEventListener('click',switchBron);
  document.getElementById('chat-disconnect').addEventListener('click',disconnect);
  sendBtn.addEventListener('click',send);
  input.addEventListener('keydown',function(e){ if(e.key==='Enter') send(); });

  // Kantooracties (DIR-32): elke bezette agent typt, verlaat af en toe zijn plek,
  // loopt ORTHOGONAAL (eerst horizontaal, dan verticaal) naar een actie en terug —
  // benen zichtbaar, en draagt iets terug (koffie/papier). Klik op de agent = chat.
  (function(){
    var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var SPOTS=[{l:9,b:16,drag:'koffie'},{l:86,b:16,drag:'papier'},{l:15,b:13,drag:null},{l:47,b:7,drag:null},null];
    function maakRoamer(desk, roam, home, key){
      if(!desk||!roam) return;
      roam.addEventListener('click',function(){ openAgent(key); });
      roam.addEventListener('keydown',function(e){ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openAgent(key); } });
      if(reduce) return;
      var pos={l:home.l,b:home.b}, busy=false;
      function face(d){ if(d<0) roam.classList.add('links'); else if(d>0) roam.classList.remove('links'); }
      function leg(axis, to, cb){
        var dist=Math.abs((axis==='left'?pos.l:pos.b)-to);
        var t=Math.max(0.5, dist*0.06);
        roam.style.transition=axis+' '+t+'s linear';
        if(axis==='left'){ roam.style.left=to+'%'; pos.l=to; } else { roam.style.bottom=to+'%'; pos.b=to; }
        setTimeout(cb, t*1000+30);
      }
      function walk(to, cb){ roam.classList.add('loopt'); face(to.l-pos.l);
        leg('left', to.l, function(){ leg('bottom', to.b, function(){ roam.classList.remove('loopt'); cb(); }); }); }
      function stretch(){ desk.classList.add('rekt'); setTimeout(function(){ desk.classList.remove('rekt'); plan(); }, 2300); }
      function go(spot){
        busy=true; desk.classList.add('away');
        roam.style.transition='none'; roam.style.left=home.l+'%'; roam.style.bottom=home.b+'%'; pos={l:home.l,b:home.b};
        roam.classList.add('zichtbaar');
        requestAnimationFrame(function(){
          walk(spot, function(){
            setTimeout(function(){
              if(spot.drag) roam.classList.add('draagt-'+spot.drag);
              walk(home, function(){
                roam.classList.remove('zichtbaar','links','draagt-koffie','draagt-papier');
                desk.classList.remove('away'); busy=false; plan();
              });
            }, 1700);
          });
        });
      }
      function act(){ if(busy){ plan(); return; } var s=SPOTS[Math.floor(Math.random()*SPOTS.length)]; if(s) go(s); else stretch(); }
      function plan(){ setTimeout(act, 12000+Math.random()*13000); }
      plan();
    }
    maakRoamer(agent, document.getElementById('albert-roam'), {l:24,b:12}, 'gsc');
    maakRoamer(gertjanDesk, document.getElementById('gertjan-roam'), {l:46,b:19}, 'ga4');
    maakRoamer(ilonaDesk, document.getElementById('ilona-roam'), {l:64,b:19}, 'ads');
  })();

  // Bij (her)laden: al gekoppeld? Eén koppeling dekt beide agents. Open de agent die
  // de koppeling startte (in sessionStorage bewaard bij connect), default Albert/GSC.
  fetch('/api/gsc/sites').then(function(r){ if(r.ok){ setConnected(true);
      var k='gsc'; try{ k=sessionStorage.getItem('dd_agent')||'gsc'; }catch(e){}
      openAgent(AGENTS[k]?k:'gsc'); }
    else{ setConnected(false); } }).catch(function(){ setConnected(false); });
})();

// Kantoorhond (DIR-32): loopt ORTHOGONAAL over de vloer en gaat zichtbaar zitten én
// liggen bij de mand, daarna weer verder. prefers-reduced-motion → stil in de mand.
(function(){
  var dog=document.querySelector('.dog'); if(!dog) return;
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var BED={l:72,b:9};
  var SPOTS=[{l:8,b:8},{l:40,b:8},{l:40,b:17},{l:20,b:15},{l:60,b:9}];
  var pos={l:6,b:6};
  dog.style.left=pos.l+'%'; dog.style.bottom=pos.b+'%';
  if(reduce){ dog.style.left=BED.l+'%'; dog.style.bottom=BED.b+'%'; dog.classList.add('ligt'); return; }
  function face(d){ if(d<0) dog.classList.add('links'); else if(d>0) dog.classList.remove('links'); }
  function leg(axis,to,cb){
    var dist=Math.abs((axis==='left'?pos.l:pos.b)-to);
    var t=Math.max(0.4, dist*0.05); dog.style.transition=axis+' '+t+'s linear';
    if(axis==='left'){ dog.style.left=to+'%'; pos.l=to; } else { dog.style.bottom=to+'%'; pos.b=to; }
    setTimeout(cb, t*1000+30);
  }
  function walk(to,cb){ dog.classList.add('loopt'); face(to.l-pos.l);
    leg('left',to.l,function(){ leg('bottom',to.b,function(){ dog.classList.remove('loopt'); cb(); }); }); }
  function rust(cb){ dog.classList.add('zit');
    setTimeout(function(){ dog.classList.remove('zit'); dog.classList.add('ligt');
      setTimeout(function(){ dog.classList.remove('ligt'); cb(); }, 3400); }, 2000); }
  function loop(){
    if(Math.random()<0.5){ walk(BED,function(){ rust(function(){ setTimeout(loop,700); }); }); }
    else { var g=SPOTS[Math.floor(Math.random()*SPOTS.length)]; walk(g,function(){ setTimeout(loop,900+Math.random()*2200); }); }
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
async function selectAdsCustomer(stub, token, env, customer, alle) {
  const overview = await fetchAdsOverview(token, env, customer);
  if (!overview) return null;
  const ads = { accounts: alle, actief: customer, ...overview };
  await stub.fetch("https://do/chat/select-ads", { method: "POST", body: JSON.stringify({ ads }) });
  return ads;
}

// Ilona-chat (Google Ads). Zelfde vorm als handleChat/handleGa4Chat.
async function handleAdsChat(request, env, ctx) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: "De agent is nog niet geconfigureerd (API-sleutel ontbreekt)." }, 500);
  }
  if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
    return json({ error: "Google Ads is nog niet geconfigureerd (developer-token ontbreekt)." }, 500);
  }
  const cookies = parseCookies(request.headers.get("Cookie"));
  const id = cookies[COOKIE];
  if (!id) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account." }, 401);

  const stub = sessionStub(env, id);
  const stateResp = await stub.fetch("https://do/chat/state-ads");
  if (!stateResp.ok) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account." }, 401);
  let { token, messages: history, ads } = await stateResp.json();

  let body = {};
  try { body = await request.json(); } catch (e) { /* lege body toegestaan */ }
  const wantCustomer = (body && typeof body.customer === "string") ? body.customer.trim() : "";
  let userText = (body && typeof body.message === "string") ? body.message.trim() : "";

  let promptText;
  let storedUser = userText;

  if (wantCustomer) {
    const accounts = await fetchAdsCustomers(token, env);
    if (!accounts || !accounts.length) return json({ error: "Geen Google Ads-accounts gevonden in je koppeling." }, 502);
    if (!accounts.some((a) => a.customer === wantCustomer)) return json({ error: "Dat account staat niet in je koppeling." }, 400);
    ads = await selectAdsCustomer(stub, token, env, wantCustomer, accounts);
    if (!ads) return json({ error: "Kon de Google Ads-cijfers van dat account niet laden." }, 502);
    history = [];
    promptText = ADS_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + wantCustomer + "]";
  } else if (!ads) {
    const accounts = await fetchAdsCustomers(token, env);
    if (!accounts || !accounts.length) return json({ error: "Geen Google Ads-accounts gevonden in je koppeling." }, 502);
    if (accounts.length > 1) return json({ needAccount: true, accounts });
    ads = await selectAdsCustomer(stub, token, env, accounts[0].customer, accounts);
    if (!ads) return json({ error: "Kon de Google Ads-cijfers van je account niet laden." }, 502);
    history = [];
    promptText = ADS_ANALYSIS_PROMPT;
    storedUser = "[Analyse van " + accounts[0].customer + "]";
  } else {
    if (!userText) return json({ error: "Stel een vraag over je advertentiecijfers." }, 400);
    promptText = userText;
  }

  const system = buildAdsSystemPrompt(ads);
  const customer = ads && ads.actief;
  const convo = buildAnthropicMessages(history, promptText);

  let finalText = "";
  try {
    for (let i = 0; i < 5; i++) {
      const resp = await callAnthropic(env, system, convo, [adsTool()]);
      if (!resp || !resp.content) {
        return json({ error: "De AI-agent gaf een fout terug. Probeer het zo opnieuw." }, 502);
      }
      const parsed = parseAssistant(resp.content);
      if (resp.stop_reason === "tool_use" && parsed.toolUses.length) {
        convo.push({ role: "assistant", content: resp.content });
        const resultaten = [];
        for (const tu of parsed.toolUses) {
          let out;
          try { out = await fetchAdsReport(token, env, customer, tu.input); }
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
    stub.fetch("https://do/chat/append-ads", {
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
      const accounts = await fetchAdsCustomers(token, env);
      if (!accounts) return json({ error: "Kon je Google Ads-accounts niet ophalen bij Google." }, 502);
      return json({ accounts });
    }

    // DIR-30 — Google Ads-rapport voor een account (AC-3).
    if (path === "/api/ads/report") {
      const token = await huidigeToken(request, env);
      if (!token) return json({ error: "Niet gekoppeld. Koppel eerst je Google-account via /oauth/start." }, 401);
      if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) return json({ error: "Google Ads is nog niet geconfigureerd (developer-token ontbreekt)." }, 500);
      const customer = url.searchParams.get("customer");
      if (!customer) return json({ error: "Geef een account op via ?customer=customers/<id>." }, 400);
      const out = await fetchAdsReport(token, env, customer, {
        report: url.searchParams.get("report"),
        days: url.searchParams.get("days"),
        row_limit: url.searchParams.get("row_limit"),
      });
      if (out && out.error) return json(out, 502);
      return json(out);
    }

    // DIR-30 — Ilona-agent (Google Ads): streaming chat met live tool-use (AC-4/AC-5).
    if (path === "/api/ads/chat" && request.method === "POST") {
      return handleAdsChat(request, env, ctx);
    }

    return json({ error: "Onbekende route." }, 404);
  },
};
