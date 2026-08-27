import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleAuthUrl,
  parseCookies,
  isExpired,
  shapePerformance,
  dateRange,
  buildSystemPrompt,
  buildAnthropicMessages,
  extractTextFromSSE,
  firstAnalysisPrompt,
  previousDateRange,
  computeTrend,
  parseDocMarker,
  docFilename,
  gscTool,
  buildGscQueryBody,
  parseAssistant,
  ga4PropertyId,
  buildGa4ReportBody,
  ga4Tool,
  shapeGa4Rows,
  shapeGa4Totals,
  computeGa4Trend,
  ga4FirstAnalysisPrompt,
  buildGa4SystemPrompt,
  adsCustomerId,
  buildAdsQuery,
  adsTool,
  shapeAdsRows,
  sumAdsRows,
  adsFirstAnalysisPrompt,
  buildAdsSystemPrompt,
  appsecretProof,
  metaActId,
  buildMetaInsightsParams,
  shapeMetaInsights,
  metaTool,
  randomKey,
  buildContentSystemPrompt,
  kiesModel,
} from "../src/index.js";
import { createHmac } from "node:crypto";

test("buildGoogleAuthUrl: read-only scopes (GSC + GA4) + online (geen refresh-token)", () => {
  const u = new URL(buildGoogleAuthUrl({
    clientId: "abc.apps.googleusercontent.com",
    redirectUri: "https://dd.example.workers.dev/oauth/callback",
    state: "xyz",
  }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  const scope = u.searchParams.get("scope");
  assert.match(scope, /webmasters\.readonly/);
  assert.match(scope, /analytics\.readonly/);   // DIR-28: GA4-scope erbij
  assert.match(scope, /auth\/adwords/);          // DIR-30: Google Ads-scope erbij
  assert.equal(u.searchParams.get("access_type"), "online");
  assert.equal(u.searchParams.get("response_type"), "code");
  assert.equal(u.searchParams.get("redirect_uri"), "https://dd.example.workers.dev/oauth/callback");
  assert.equal(u.searchParams.get("state"), "xyz");
});

test("parseCookies: meerdere cookies", () => {
  const c = parseCookies("dd_session=abc123; dd_oauth_state=st%20ate; other=1");
  assert.equal(c.dd_session, "abc123");
  assert.equal(c.dd_oauth_state, "st ate");
  assert.equal(c.other, "1");
  assert.deepEqual(parseCookies(""), {});
  assert.deepEqual(parseCookies(null), {});
});

test("isExpired: 30 min inactiviteit", () => {
  const now = 1_000_000_000_000;
  assert.equal(isExpired(now - 10 * 60 * 1000, now), false); // 10 min → geldig
  assert.equal(isExpired(now - 31 * 60 * 1000, now), true);  // 31 min → verlopen
  assert.equal(isExpired(undefined, now), true);             // geen sessie
});

test("shapePerformance: mapt en rondt af", () => {
  const q = [{ keys: ["schoenen kopen"], clicks: 12, impressions: 340, ctr: 0.0353, position: 4.27 }];
  const p = [{ keys: ["https://site.nl/schoenen"], clicks: 8, impressions: 210, ctr: 0.038, position: 6.5 }];
  const out = shapePerformance(q, p);
  assert.deepEqual(out.queries[0], { query: "schoenen kopen", clicks: 12, impressions: 340, ctr: 3.5, position: 4.3 });
  assert.deepEqual(out.pages[0], { page: "https://site.nl/schoenen", clicks: 8, impressions: 210, ctr: 3.8, position: 6.5 });
  assert.deepEqual(shapePerformance(undefined, undefined), { queries: [], pages: [] });
});

test("buildSystemPrompt: NL jij-vorm analist + data ingebed", () => {
  const gsc = { actief: "https://site.nl", prestaties: { queries: [{ query: "schoenen", clicks: 12 }] } };
  const s = buildSystemPrompt(gsc);
  assert.match(s, /GSC-analist/);
  assert.match(s, /jij-vorm/);
  assert.match(s, /schoenen/);          // data zit in de prompt
  assert.match(buildSystemPrompt(null), /nog geen data/);
});

test("buildAnthropicMessages: historie + nieuwe vraag", () => {
  const hist = [{ role: "user", content: "hoi" }, { role: "assistant", content: "hallo" }];
  const m = buildAnthropicMessages(hist, "welke pagina's zakken?");
  assert.equal(m.length, 3);
  assert.deepEqual(m[2], { role: "user", content: "welke pagina's zakken?" });
  // zonder nieuwe vraag → alleen historie
  assert.equal(buildAnthropicMessages(hist, "").length, 2);
  assert.equal(buildAnthropicMessages(null, "x").length, 1);
});

test("firstAnalysisPrompt: dashboard-secties + inzoom-vraag", () => {
  const p = firstAnalysisPrompt();
  assert.match(p, /## Samenvatting/);
  assert.match(p, /## Sterke pagina's/);
  assert.match(p, /## Kansen/);
  assert.match(p, /## Trend/);
  assert.match(p, /inzoomen/i);
});

test("previousDateRange: 28 dagen direct vóór de huidige periode", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const cur = dateRange(28, now);
  const prev = previousDateRange(28, now);
  assert.equal(cur.startDate, "2026-07-28");
  assert.equal(prev.endDate, "2026-07-28");   // vorige periode eindigt waar de huidige begint
  assert.equal(prev.startDate, "2026-06-30");
});

test("computeTrend: procentuele verandering, met nul-vorige", () => {
  assert.deepEqual(computeTrend({ clicks: 120, impressions: 2000 }, { clicks: 100, impressions: 2500 }),
    { clicksPct: 20, impressionsPct: -20 });
  assert.deepEqual(computeTrend({ clicks: 10, impressions: 0 }, { clicks: 0, impressions: 0 }),
    { clicksPct: 100, impressionsPct: 0 });
});

test("extractTextFromSSE: plakt content_block_delta tekst aan elkaar", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start"}',
    '',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hallo "}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Dirk"}}',
    'data: {"type":"message_stop"}',
    'data: [DONE]',
  ].join("\n");
  assert.equal(extractTextFromSSE(sse), "Hallo Dirk");
  assert.equal(extractTextFromSSE(""), "");
});

test("parseDocMarker: haalt slug + markdown uit een documentblok", () => {
  const t = "%%DOC gsc-actiepunten\n# Actiepunten\n- Doe X\n- Doe Y\n%%ENDDOC";
  const d = parseDocMarker(t);
  assert.equal(d.slug, "gsc-actiepunten");
  assert.match(d.markdown, /# Actiepunten/);
  assert.match(d.markdown, /- Doe X/);
  assert.equal(parseDocMarker("gewoon antwoord zonder blok"), null);
  assert.equal(parseDocMarker("%%DOC leeg\n\n%%ENDDOC"), null); // lege inhoud
});

test("docFilename: veilige, beschrijvende .md-naam met datum", () => {
  assert.equal(docFilename("GSC Actiepunten!", "2026-08-25"), "gsc-actiepunten-20260825.md");
  assert.equal(docFilename("blog/beste pagina", "20260825"), "blog-beste-pagina-20260825.md");
  assert.equal(docFilename("", ""), "document.md");
});

test("gscTool: heeft naam gsc_query + verplichte dimension", () => {
  const t = gscTool();
  assert.equal(t.name, "gsc_query");
  assert.deepEqual(t.input_schema.required, ["dimension"]);
  assert.deepEqual(t.input_schema.properties.dimension.enum, ["query", "page", "date"]);
});

test("buildGscQueryBody: dimensie/limieten/filter", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const b = buildGscQueryBody({ dimension: "page", days: 7, row_limit: 5, filter_type: "page", filter_value: "/diensten" }, now);
  assert.deepEqual(b.dimensions, ["page"]);
  assert.equal(b.startDate, "2026-08-18");
  assert.equal(b.endDate, "2026-08-25");
  assert.equal(b.rowLimit, 5);
  assert.equal(b.dimensionFilterGroups[0].filters[0].operator, "contains");
  assert.equal(b.dimensionFilterGroups[0].filters[0].expression, "/diensten");
  // defaults + clamps: onzin-dimensie → query, days default 28, rowLimit cap 25
  const d = buildGscQueryBody({ dimension: "onzin", row_limit: 999 }, now);
  assert.deepEqual(d.dimensions, ["query"]);
  assert.equal(d.rowLimit, 25);
  assert.equal(d.startDate, "2026-07-28");
  assert.equal(d.dimensionFilterGroups, undefined);
});

test("parseAssistant: splitst tekst en tool_use", () => {
  const content = [
    { type: "text", text: "Even kijken. " },
    { type: "tool_use", id: "tu_1", name: "gsc_query", input: { dimension: "page" } },
    { type: "text", text: "Klaar." },
  ];
  const p = parseAssistant(content);
  assert.equal(p.text, "Even kijken. Klaar.");
  assert.equal(p.toolUses.length, 1);
  assert.equal(p.toolUses[0].id, "tu_1");
  assert.deepEqual(parseAssistant([]), { text: "", toolUses: [] });
});

test("dateRange: dagen terug, geclampt", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const r = dateRange(7, now);
  assert.equal(r.endDate, "2026-08-25");
  assert.equal(r.startDate, "2026-08-18");
  // ongeldig → default 28
  assert.equal(dateRange("onzin", now).startDate, "2026-07-28");
  // clamp naar max 400
  assert.equal(dateRange(9999, now).startDate, dateRange(400, now).startDate);
});

// ------------------------------------------------------------ GA4 (DIR-28) ---

test("ga4PropertyId: normaliseert properties/<id> en <id>", () => {
  assert.equal(ga4PropertyId("properties/123456"), "123456");
  assert.equal(ga4PropertyId("123456"), "123456");
  assert.equal(ga4PropertyId(""), "");
});

test("buildGa4ReportBody: dimensie/metric/periode/limiet + filter", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const b = buildGa4ReportBody({ dimension: "pagePath", metric: "sessions", days: 7, row_limit: 5, filter_value: "/diensten" }, now);
  assert.deepEqual(b.dateRanges, [{ startDate: "2026-08-18", endDate: "2026-08-25" }]);
  assert.deepEqual(b.dimensions, [{ name: "pagePath" }]);
  assert.deepEqual(b.metrics, [{ name: "sessions" }]);
  assert.equal(b.limit, 5);
  assert.equal(b.dimensionFilter.filter.fieldName, "pagePath");
  assert.equal(b.dimensionFilter.filter.stringFilter.value, "/diensten");
  // defaults + clamps: onzin → pagePath/sessions, days default 28, limit cap 25, geen filter
  const d = buildGa4ReportBody({ dimension: "onzin", metric: "onzin", row_limit: 999 }, now);
  assert.deepEqual(d.dimensions, [{ name: "pagePath" }]);
  assert.deepEqual(d.metrics, [{ name: "sessions" }]);
  assert.equal(d.limit, 25);
  assert.equal(d.dateRanges[0].startDate, "2026-07-28");
  assert.equal(d.dimensionFilter, undefined);
});

test("ga4Tool: naam ga4_report + verplichte metric/dimension", () => {
  const t = ga4Tool();
  assert.equal(t.name, "ga4_report");
  assert.deepEqual(t.input_schema.required, ["metric", "dimension"]);
  assert.ok(t.input_schema.properties.metric.enum.includes("activeUsers"));
  assert.ok(t.input_schema.properties.dimension.enum.includes("sessionDefaultChannelGroup"));
});

test("shapeGa4Rows: dimensie + metric-waarde", () => {
  const rows = [{ dimensionValues: [{ value: "/prijzen" }], metricValues: [{ value: "42" }] }];
  assert.deepEqual(shapeGa4Rows(rows, "pagePath"), [{ pagePath: "/prijzen", waarde: 42 }]);
  assert.deepEqual(shapeGa4Rows(undefined, "x"), []);
});

test("shapeGa4Totals: metricHeaders → { naam: getal }", () => {
  const report = {
    metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }],
    rows: [{ metricValues: [{ value: "120" }, { value: "200" }] }],
  };
  assert.deepEqual(shapeGa4Totals(report), { activeUsers: 120, sessions: 200 });
  assert.deepEqual(shapeGa4Totals({}), {});
});

test("computeGa4Trend: procentuele verandering users/sessies", () => {
  assert.deepEqual(computeGa4Trend({ activeUsers: 120, sessions: 300 }, { activeUsers: 100, sessions: 300 }),
    { activeUsersPct: 20, sessionsPct: 0 });
  assert.deepEqual(computeGa4Trend({ activeUsers: 10, sessions: 0 }, { activeUsers: 0, sessions: 0 }),
    { activeUsersPct: 100, sessionsPct: 0 });
});

test("ga4FirstAnalysisPrompt: dashboard-secties + jij-vorm", () => {
  const p = ga4FirstAnalysisPrompt();
  assert.match(p, /## Samenvatting/);
  assert.match(p, /## Verkeer & trend/);
  assert.match(p, /## Top pagina's/);
  assert.match(p, /## Kanalen/);
  assert.match(p, /## Opvallend/);
  assert.match(p, /jij-vorm/);
});

test("buildGa4SystemPrompt: Gertjan, GA4, jij-vorm, data ingebed", () => {
  const ga4 = { actief: "properties/123", totalen: { sessions: 200 } };
  const s = buildGa4SystemPrompt(ga4);
  assert.match(s, /Gertjan/);
  assert.match(s, /GA4/);
  assert.match(s, /jij-vorm/);
  assert.match(s, /ga4_report/);
  assert.match(s, /properties\/123/);
  assert.match(buildGa4SystemPrompt(null), /nog geen data/);
});

// -------------------------------------------------- Google Ads (DIR-30) ---

test("adsCustomerId: normaliseert customers/<id> en <id>", () => {
  assert.equal(adsCustomerId("customers/1234567890"), "1234567890");
  assert.equal(adsCustomerId("1234567890"), "1234567890");
  assert.equal(adsCustomerId(""), "");
});

test("buildAdsQuery: GAQL met periode/limiet + rapport-default", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const b = buildAdsQuery({ report: "keywords", days: 7, row_limit: 5 }, now);
  assert.equal(b.report, "keywords");
  assert.match(b.query, /FROM keyword_view/);
  assert.match(b.query, /ad_group_criterion\.keyword\.text/);
  assert.match(b.query, /metrics\.cost_micros/);
  assert.match(b.query, /BETWEEN '2026-08-18' AND '2026-08-25'/);
  assert.match(b.query, /LIMIT 5/);
  assert.deepEqual(b.jsonPath, ["adGroupCriterion", "keyword", "text"]);
  // onzin-rapport → campaigns; days default 28; limit cap 50
  const d = buildAdsQuery({ report: "onzin", row_limit: 999 }, now);
  assert.equal(d.report, "campaigns");
  assert.match(d.query, /FROM campaign/);
  assert.match(d.query, /LIMIT 50/);
  assert.match(d.query, /BETWEEN '2026-07-28' AND '2026-08-25'/);
});

test("adsTool: naam ads_report + verplicht report", () => {
  const t = adsTool();
  assert.equal(t.name, "ads_report");
  assert.deepEqual(t.input_schema.required, ["report"]);
  assert.ok(t.input_schema.properties.report.enum.includes("campaigns"));
  assert.ok(t.input_schema.properties.report.enum.includes("search_terms"));
});

test("shapeAdsRows: label via jsonPath + cost_micros → euro's", () => {
  const results = [{
    campaign: { name: "Merk NL" },
    metrics: { costMicros: "12340000", clicks: "80", impressions: "2000", conversions: "3.5" },
  }];
  assert.deepEqual(shapeAdsRows(results, ["campaign", "name"]), [
    { label: "Merk NL", kosten: 12.34, clicks: 80, impressies: 2000, conversies: 3.5 },
  ]);
  assert.deepEqual(shapeAdsRows(undefined, ["campaign", "name"]), []);
});

test("sumAdsRows: totalen optellen", () => {
  const rows = [
    { kosten: 12.34, clicks: 80, impressies: 2000, conversies: 3.5 },
    { kosten: 7.66, clicks: 20, impressies: 500, conversies: 1.5 },
  ];
  assert.deepEqual(sumAdsRows(rows), { kosten: 20, clicks: 100, impressies: 2500, conversies: 5 });
  assert.deepEqual(sumAdsRows([]), { kosten: 0, clicks: 0, impressies: 0, conversies: 0 });
});

test("adsFirstAnalysisPrompt: dashboard-secties + jij-vorm", () => {
  const p = adsFirstAnalysisPrompt();
  assert.match(p, /## Samenvatting/);
  assert.match(p, /## Kosten & rendement/);
  assert.match(p, /## Top campagnes/);
  assert.match(p, /## Kansen/);
  assert.match(p, /jij-vorm/);
});

test("buildAdsSystemPrompt: Ilona, Google Ads, jij-vorm, data ingebed", () => {
  const ads = { actief: "customers/123", totalen: { kosten: 20 } };
  const s = buildAdsSystemPrompt(ads);
  assert.match(s, /Ilona/);
  assert.match(s, /Google Ads/);
  assert.match(s, /jij-vorm/);
  assert.match(s, /ads_report/);
  assert.match(s, /customers\/123/);
  assert.match(buildAdsSystemPrompt(null), /nog geen data/);
});

// ------------------------------------------------- Meta Ads (DIR-30) ---

test("appsecretProof: HMAC-SHA256(token, appSecret) hex", async () => {
  const proof = await appsecretProof("tok123", "sec456");
  const verwacht = createHmac("sha256", "sec456").update("tok123").digest("hex");
  assert.equal(proof, verwacht);
  assert.match(proof, /^[0-9a-f]{64}$/);
});

test("metaActId: normaliseert act_<id> en <id>", () => {
  assert.equal(metaActId("act_123"), "act_123");
  assert.equal(metaActId("123"), "act_123");
  assert.equal(metaActId(""), "");
});

test("buildMetaInsightsParams: time_range als APARTE params + limieten", () => {
  const now = Date.parse("2026-08-25T12:00:00Z");
  const p = buildMetaInsightsParams({ level: "campaign", days: 7, row_limit: 5 }, now);
  assert.equal(p.level, "campaign");
  assert.equal(p["time_range[since]"], "2026-08-18");
  assert.equal(p["time_range[until]"], "2026-08-25");
  assert.equal(p.limit, "5");
  assert.match(p.fields, /spend/);
  assert.match(p.fields, /reach/);
  assert.equal(p["time_range"], undefined);        // geen JSON-string
  // defaults/clamps: onzin-level -> campaign, days 28, limit cap 50
  const d = buildMetaInsightsParams({ level: "onzin", row_limit: 999 }, now);
  assert.equal(d.level, "campaign");
  assert.equal(d.limit, "50");
  assert.equal(d["time_range[since]"], "2026-07-28");
});

test("shapeMetaInsights: spend/clicks/bereik + actions -> resultaten", () => {
  const rows = [{
    campaign_name: "Zomer",
    spend: "12.345", impressions: "1000", clicks: "50", reach: "800", ctr: "5", cpc: "0.25",
    actions: [{ action_type: "lead", value: "3" }, { action_type: "purchase", value: "2" }],
  }];
  assert.deepEqual(shapeMetaInsights(rows), [
    { campagne: "Zomer", spend: 12.35, impressies: 1000, clicks: 50, bereik: 800, ctr: 5, cpc: 0.25, resultaten: 5 },
  ]);
  assert.deepEqual(shapeMetaInsights(undefined), []);
});

test("metaTool: naam meta_report", () => {
  const t = metaTool();
  assert.equal(t.name, "meta_report");
  assert.ok(t.input_schema.properties.level.enum.includes("campaign"));
});

test("randomKey: uniek, niet-raadbaar (36 hex)", () => {
  const a = randomKey(), b = randomKey();
  assert.match(a, /^[0-9a-f]{36}$/);
  assert.notEqual(a, b);
});

test("buildContentSystemPrompt: Anton content-agent, NL jij-vorm, %%DOC, geen databron", () => {
  const s = buildContentSystemPrompt();
  assert.match(s, /Anton/);
  assert.match(s, /jij-vorm/);
  assert.match(s, /vertalen/);
  assert.match(s, /SEO/);
  assert.match(s, /%%DOC/);
  assert.doesNotMatch(s, /nog geen data/);
});

// DIR-77: het model is de duurste knop in de tool, dus alleen exact bekende
// model-id's komen erdoor; al het andere valt terug op de standaard (Sonnet 5).
test("kiesModel: laat exact de drie toegestane modellen door", () => {
  assert.equal(kiesModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(kiesModel("claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(kiesModel("claude-opus-5"), "claude-opus-5");
});

test("kiesModel: alles wat niet in de lijst staat valt terug op Sonnet 5", () => {
  for (const rommel of [null, undefined, "", "claude-opus-6", "CLAUDE-OPUS-5", " claude-opus-5",
    "claude-sonnet-5\n", "gpt-4", "../../etc/passwd", 42, {}, ["claude-opus-5"]]) {
    assert.equal(kiesModel(rommel), "claude-sonnet-5");
  }
});
