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
  schoonKlantRecord,
  normaliseerEmail,
  agentStandaard,
  modelPrijs,
  tokenKosten,
  kostenNaarCredits,
  nieuweMeter,
  meetAanroep,
  meterCredits,
  magChattenMetSaldo,
  schoneCreditsConfig,
  boekSleutel,
  hoortBijGebruiker,
  modelVoorKlant,
  klantModelKeuzes,
  geldigKlantModel,
  nieuwSaldoRecord,
  klantRegel,
  boekIndexPrefix,
  boekIndexSleutel,
  snoeiGrensSleutel,
  overschot,
  reserveringPrefix,
  reserveringSchatting,
  beschikbaarSaldo,
  reserveringVerlopen,
  verrekenActie,
  saldoEvent,
  metGeduld,
  samenAgent,
  leesBijlagen,
  bijlageBlokken,
  bijlageNotitie,
  schoneBestandsnaam,
  base64Bytes,
  magChatten,
  isAdmin,
  maakSessie,
  leesSessie,
  klantOpEmail,
  emailUitUserinfo,
  pkceVerifier,
  pkceChallenge,
  gebruikSleutel,
  magLoggen,
  snoeiGebruik,
  telOnbekendVandaag,
  dagSleutel,
  gebruikerSleutel,
  geldigSessieId,
  klantBron,
  bronToegestaan,
  bronOfNiets,
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
  assert.match(scope, /(^|\s)openid(\s|$)/);      // DIR-86: identiteit erbij
  assert.match(scope, /(^|\s)email(\s|$)/);
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

test("firstAnalysisPrompt: kort eerste beeld, geen dashboard (DIR-90)", () => {
  const p = firstAnalysisPrompt();
  assert.match(p, /KORT/);
  assert.match(p, /maximaal vijf/i);
  assert.match(p, /Wat wil je weten\?/);
  assert.match(p, /jij-vorm/);
  // De uitgebreide analyse komt pas op verzoek: geen vaste secties meer.
  assert.equal(/## /.test(p), false);
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

test("ga4FirstAnalysisPrompt: kort eerste beeld, geen dashboard (DIR-90)", () => {
  const p = ga4FirstAnalysisPrompt();
  assert.match(p, /KORT/);
  assert.match(p, /Wat wil je weten\?/);
  assert.match(p, /jij-vorm/);
  assert.equal(/## /.test(p), false);
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

test("adsFirstAnalysisPrompt: kort eerste beeld, geen dashboard (DIR-90)", () => {
  const p = adsFirstAnalysisPrompt();
  assert.match(p, /KORT/);
  assert.match(p, /Wat wil je weten\?/);
  assert.match(p, /jij-vorm/);
  assert.equal(/## /.test(p), false);
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

// DIR-78: het admin-antwoord mag nooit het wachtwoord-materiaal bevatten.
test("schoonKlantRecord: geeft koppelingen + Google-adres, nooit een oud login-blok", () => {
  const c = schoonKlantRecord("abc", {
    naam: "Klant", adAccountId: "act_1", gscSite: "sc-domain:k.nl",
    ga4Property: "properties/7", adsCustomerId: "123", adsLoginCustomerId: "456",
    googleEmail: "baas@k.nl",
    // Een record van vóór DIR-86 kan nog een wachtwoord-hash bevatten; die mag de
    // beheer-UI nooit zien.
    login: { gebruikersnaam: "klant", salt: "S4LTS4LT", hash: "H4SHH4SH", rondes: 210000 },
  });
  assert.equal(c.googleEmail, "baas@k.nl");
  assert.equal(JSON.stringify(c).includes("S4LTS4LT"), false);
  assert.equal(JSON.stringify(c).includes("H4SHH4SH"), false);
  assert.equal("login" in c, false);
  assert.equal("gebruikersnaam" in c, false);
  assert.equal("heeftWachtwoord" in c, false);
});

test("schoonKlantRecord: klant zonder Google-adres kan niet inloggen", () => {
  const c = schoonKlantRecord("abc", { naam: "Klant" });
  assert.equal(c.googleEmail, "");
  assert.equal(c.gscSite, "");
});

test("agentStandaard: vaste sleutel + databron, teksten uit de code", () => {
  const a = agentStandaard("gsc");
  assert.equal(a.key, "gsc");
  assert.equal(a.naam, "Albert");
  assert.match(a.bron, /Search Console/);
  assert.ok(a.persona.length > 200);
  assert.ok(a.analyse.length > 100);
  assert.equal(agentStandaard("bestaatniet"), null);
});

test("samenAgent: leeg of blanco override laat de code-tekst staan", () => {
  const st = agentStandaard("ga4");
  assert.equal(samenAgent(st, null).naam, "Gertjan");
  assert.equal(samenAgent(st, {}).persona, st.persona);
  assert.equal(samenAgent(st, { naam: "   " }).naam, "Gertjan");
  assert.deepEqual(samenAgent(st, {}).aangepast, {});
});

test("samenAgent: ingevulde velden winnen en worden gemarkeerd als aangepast", () => {
  const st = agentStandaard("ads");
  const uit = samenAgent(st, { naam: "Ilse", persona: "Wees kort." });
  assert.equal(uit.naam, "Ilse");
  assert.equal(uit.persona, "Wees kort.");
  assert.equal(uit.rol, st.rol);                    // niet meegegeven → standaard
  assert.deepEqual(uit.aangepast, { naam: true, persona: true });
  assert.equal(uit.key, "ads");                     // sleutel blijft vast
  assert.equal(uit.bron, st.bron);
});

test("samenAgent: een override wordt afgekapt op de maximale lengte", () => {
  const st = agentStandaard("anton");
  const uit = samenAgent(st, { persona: "x".repeat(9000) });
  assert.equal(uit.persona.length, 8000);
});

// DIR-81: bijlagen zijn data. De bestandsnaam komt in de prompt en in de chat, dus
// die mag geen regeleindes of stuurtekens bevatten.
test("schoneBestandsnaam: geen regeleindes, stuurtekens of eindeloze lengte", () => {
  assert.equal(schoneBestandsnaam("kwaad\ninjectie.txt"), "kwaad injectie.txt");
  assert.equal(schoneBestandsnaam("   "), "bestand");
  assert.equal(schoneBestandsnaam(null), "bestand");
  assert.equal(schoneBestandsnaam("x".repeat(200)).length, 120);
});

test("base64Bytes: telt de bytes achter de base64 zonder te decoderen", () => {
  assert.equal(base64Bytes("aGkK"), 3);
  assert.equal(base64Bytes("QQ=="), 1);
  assert.equal(base64Bytes(""), 0);
});

test("leesBijlagen: goede bijlage komt door, met opgeschoonde naam", () => {
  const r = leesBijlagen([{ naam: "shot\n.png", type: "IMAGE/PNG", data: "aGkK" }]);
  assert.equal(r.error, undefined);
  assert.equal(r.lijst.length, 1);
  assert.equal(r.lijst[0].naam, "shot .png");
  assert.equal(r.lijst[0].soort, "afbeelding");
});

test("leesBijlagen: weigert onbekend type, te veel bestanden en rommel-data", () => {
  assert.match(leesBijlagen([{ naam: "v.exe", type: "application/x-msdownload", data: "aGkK" }]).error, /kan ik niet lezen/);
  const zes = Array.from({ length: 6 }, () => ({ naam: "a.txt", type: "text/plain", data: "aGkK" }));
  assert.match(leesBijlagen(zes).error, /Maximaal 5/);
  assert.match(leesBijlagen([{ naam: "a.png", type: "image/png", data: "geen base64!" }]).error, /niet lezen/);
  assert.match(leesBijlagen("nietvaneenlijst").error, /Ongeldige bijlagen/);
  assert.deepEqual(leesBijlagen(undefined), { lijst: [] });
});

test("leesBijlagen: weigert een bestand boven de maximale grootte", () => {
  const groot = { naam: "groot.png", type: "image/png", data: "A".repeat(7 * 1024 * 1024) };
  assert.match(leesBijlagen([groot]).error, /te groot/);
});

test("bijlageBlokken: elke bijlage staat tussen een duidelijke afbakening", () => {
  const blok = bijlageBlokken([{ naam: "shot.png", type: "image/png", soort: "afbeelding", data: "aGkK" }]);
  assert.equal(blok.length, 3);
  assert.match(blok[0].text, /begin bijlage: shot\.png/);
  assert.match(blok[0].text, /geen opdracht/);
  assert.equal(blok[1].type, "image");
  assert.equal(blok[1].source.media_type, "image/png");
  assert.match(blok[2].text, /einde bijlage/);
  const pdf = bijlageBlokken([{ naam: "a.pdf", type: "application/pdf", soort: "document", data: "aGkK" }]);
  assert.equal(pdf[1].type, "document");
});

test("bijlageNotitie: alleen namen in de historie, nooit de inhoud", () => {
  const n = bijlageNotitie([{ naam: "a.png", data: "GEHEIMEBASE64" }, { naam: "b.pdf", data: "OOK" }]);
  assert.match(n, /a\.png, b\.pdf/);
  assert.equal(n.includes("GEHEIMEBASE64"), false);
  assert.equal(bijlageNotitie([]), "");
});

test("buildAnthropicMessages: bijlagen komen voor de vraag in een gebruikersbericht", () => {
  const blok = bijlageBlokken([{ naam: "a.txt", type: "text/plain", soort: "tekst", data: "aGkK" }]);
  const m = buildAnthropicMessages([], "Wat staat hierin?", blok);
  assert.equal(m.length, 1);
  assert.equal(Array.isArray(m[0].content), true);
  assert.equal(m[0].content[m[0].content.length - 1].text, "Wat staat hierin?");
  assert.equal(buildAnthropicMessages([], "hoi")[0].content, "hoi");
});

// ---- DIR-83: de chat-poort ----
// Eén centrale check "mag deze bezoeker chatten?". Alle chat- en data-endpoints
// hangen hieraan, dus dit is het stuk dat moet kloppen.
function verzoekMetCookie(cookie) {
  return new Request("https://dd.test/api/chat", cookie ? { headers: { Cookie: cookie } } : {});
}
function adminCookie(wachtwoord) {
  return "dd_admin=" + createHmac("sha256", wachtwoord).update("dd-admin-v1").digest("hex");
}

test("magChatten: zonder cookie mag je niet chatten", async () => {
  assert.equal(await magChatten(verzoekMetCookie(null), { ADMIN_PASSWORD: "geheim" }), false);
});

test("magChatten: een verzonnen cookie geeft geen toegang", async () => {
  const req = verzoekMetCookie("dd_admin=" + "a".repeat(64));
  assert.equal(await magChatten(req, { ADMIN_PASSWORD: "geheim" }), false);
  const anderWachtwoord = verzoekMetCookie(adminCookie("ander"));
  assert.equal(await magChatten(anderWachtwoord, { ADMIN_PASSWORD: "geheim" }), false);
});

test("magChatten: een geldige admin-sessie mag chatten", async () => {
  const req = verzoekMetCookie(adminCookie("geheim"));
  assert.equal(await magChatten(req, { ADMIN_PASSWORD: "geheim" }), true);
});

test("magChatten: zonder ingesteld admin-wachtwoord gaat de poort niet open", async () => {
  const req = verzoekMetCookie(adminCookie(""));
  assert.equal(await magChatten(req, {}), false);
});

// ---- DIR-82: klant-login en klant-sessie ----
const KLANT_A = "a".repeat(36);            // klantsleutels zijn 36 hex-tekens
const KLANT_B = "b".repeat(36);
function nepKv(store) {
  return {
    get: async (k) => (k in store ? store[k] : null),
    put: async (k, v) => { store[k] = v; },
    delete: async (k) => { delete store[k]; },
    list: async () => ({ keys: Object.keys(store).map((name) => ({ name })) }),
  };
}
async function nepEnv(extra) {
  const store = {
    [KLANT_A]: JSON.stringify({ naam: "Klant A", googleEmail: "baas@klant-a.nl" }),
    [KLANT_B]: JSON.stringify({ naam: "Klant B" }),                  // nog geen adres → kan niet inloggen
    "config:model": "claude-opus-5",                                 // geen klantrecord
  };
  return { ADMIN_PASSWORD: "geheim", CLIENTS: nepKv(store), ...(extra || {}) };
}

test("sessie: heen en terug geeft hetzelfde adres en dezelfde klantsleutel", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie(env, "Baas@Klant-A.nl", KLANT_A);
  assert.deepEqual(await leesSessie(env, waarde), { email: "baas@klant-a.nl", key: KLANT_A });
});

test("sessie: mag ook zonder klantrecord (DIR-88: iedereen komt binnen)", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie(env, "vreemde@ergens.nl", "");
  assert.deepEqual(await leesSessie(env, waarde), { email: "vreemde@ergens.nl", key: "" });
});

test("sessie: geknoeide onderdelen worden geweigerd", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie(env, "baas@klant-a.nl", KLANT_A);
  const [emailB64, key, exp, sig] = waarde.split(".");
  // Een ander adres achter dezelfde handtekening plakken.
  const anderAdres = Buffer.from("baas@klant-b.nl").toString("base64url");
  assert.equal(await leesSessie(env, [anderAdres, key, exp, sig].join(".")), null);
  // Een andere klantsleutel (= andere voorkeursbron) erin schuiven.
  assert.equal(await leesSessie(env, [emailB64, KLANT_B, exp, sig].join(".")), null);
  // De verlooptijd oprekken.
  assert.equal(await leesSessie(env, [emailB64, key, String(Number(exp) + 60000), sig].join(".")), null);
  assert.equal(await leesSessie(env, [emailB64, key, exp, "0".repeat(64)].join(".")), null);
  assert.equal(await leesSessie(env, "rommel"), null);
  assert.equal(await leesSessie(env, [emailB64, "geen-geldige-sleutel", exp, sig].join(".")), null);
});

test("sessie: verlopen sessie geldt niet meer", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie(env, "baas@klant-a.nl", KLANT_A, 0);
  assert.deepEqual(await leesSessie(env, waarde, 0), { email: "baas@klant-a.nl", key: KLANT_A });
  assert.equal(await leesSessie(env, waarde, 9 * 60 * 60 * 1000), null);
});

test("sessie: ondertekend met een ander wachtwoord telt niet", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie({ ADMIN_PASSWORD: "ander" }, "baas@klant-a.nl", KLANT_A);
  assert.equal(await leesSessie(env, waarde), null);
});

test("sessie: opent de chat-poort, ook zonder klantrecord, maar NOOIT admin", async () => {
  const env = await nepEnv();
  const metRecord = new Request("https://dd.test/api/chat", {
    headers: { Cookie: "dd_klant_sessie=" + await maakSessie(env, "baas@klant-a.nl", KLANT_A) },
  });
  const zonderRecord = new Request("https://dd.test/api/chat", {
    headers: { Cookie: "dd_klant_sessie=" + await maakSessie(env, "vreemde@ergens.nl", "") },
  });
  assert.equal(await magChatten(metRecord, env), true);
  assert.equal(await magChatten(zonderRecord, env), true);      // DIR-88: geen allowlist meer
  assert.equal(await isAdmin(metRecord, env), false);
  assert.equal(await isAdmin(zonderRecord, env), false);
});

test("sessie: een verwijderd klantrecord kost je de toegang NIET (alleen de voorkeur)", async () => {
  const env = await nepEnv();
  const waarde = await maakSessie(env, "baas@klant-a.nl", KLANT_A);
  await env.CLIENTS.delete(KLANT_A);
  const req = new Request("https://dd.test/api/chat", { headers: { Cookie: "dd_klant_sessie=" + waarde } });
  // Je draait op je eigen Google-koppeling; het record was alleen de voorkeursbron.
  assert.equal(await magChatten(req, env), true);
});

test("klantOpEmail: hoofdletterongevoelig, en alleen klanten met een adres", async () => {
  const env = await nepEnv();
  const gevonden = await klantOpEmail(env, "  BAAS@Klant-A.nl ");
  assert.equal(gevonden.key, KLANT_A);
  assert.equal(gevonden.rec.naam, "Klant A");
  // Klant B heeft geen adres: die is niet bereikbaar via login, ook niet met "".
  assert.equal(await klantOpEmail(env, ""), null);
  assert.equal(await klantOpEmail(env, "iemand@anders.nl"), null);
});

test("emailUitUserinfo: alleen een BEVESTIGD adres telt", () => {
  assert.equal(emailUitUserinfo({ email: "Baas@Klant-A.nl", email_verified: true }), "baas@klant-a.nl");
  assert.equal(emailUitUserinfo({ email: "baas@klant-a.nl", email_verified: "true" }), "baas@klant-a.nl");
  assert.equal(emailUitUserinfo({ email: "baas@klant-a.nl", email_verified: false }), null);
  assert.equal(emailUitUserinfo({ email: "baas@klant-a.nl" }), null);     // vlag ontbreekt
  assert.equal(emailUitUserinfo({ email_verified: true }), null);          // geen adres
  assert.equal(emailUitUserinfo(null), null);
});

test("normaliseerEmail: alleen kleine letters en spaties trimmen, verder niets", () => {
  assert.equal(normaliseerEmail("  Baas@Klant-A.NL "), "baas@klant-a.nl");
  // Punten en +tag NIET strippen: bij Google zijn dit verschillende accounts, en
  // samenvoegen zou iemand op andermans klantrecord kunnen laten landen.
  assert.equal(normaliseerEmail("b.a.a.s@gmail.com"), "b.a.a.s@gmail.com");
  assert.equal(normaliseerEmail("baas+test@gmail.com"), "baas+test@gmail.com");
  assert.notEqual(normaliseerEmail("b.a.a.s@gmail.com"), normaliseerEmail("baas@gmail.com"));
});

// ---- DIR-84: klant-afscherming (allowlist) ----
// Het agency-account kan bij alle klanten; deze functies zijn het enige dat klant A
// van klant B scheidt. Klant A heeft alles vastgelegd, klant B is de buurman.
const REC_A = {
  naam: "Klant A",
  gscSite: "sc-domain:klant-a.nl",
  ga4Property: "properties/111",
  adsCustomerId: "customers/1112223334",
  adsLoginCustomerId: "customers/9998887776",
  adAccountId: "act_111",
};
const REC_B = {
  naam: "Klant B",
  gscSite: "sc-domain:klant-b.nl",
  ga4Property: "properties/222",
  adsCustomerId: "customers/4445556667",
  adAccountId: "act_222",
};

test("klantBron: leest precies de vastgelegde bronnen, en niets anders", () => {
  assert.equal(klantBron(REC_A, "gsc"), "sc-domain:klant-a.nl");
  assert.equal(klantBron(REC_A, "ga4"), "properties/111");
  assert.equal(klantBron(REC_A, "ads"), "customers/1112223334");
  assert.equal(klantBron(REC_A, "adsLogin"), "customers/9998887776");
  assert.equal(klantBron(REC_A, "meta"), "act_111");
  assert.equal(klantBron(REC_B, "adsLogin"), "");        // niet ingesteld
  assert.equal(klantBron({}, "gsc"), "");
  assert.equal(klantBron(null, "ga4"), "");
});

test("bronToegestaan: eigen bron mag, die van de buurman niet", () => {
  for (const soort of ["gsc", "ga4", "ads", "meta"]) {
    assert.equal(bronToegestaan(REC_A, soort, klantBron(REC_A, soort)), true, soort + " eigen");
    assert.equal(bronToegestaan(REC_A, soort, klantBron(REC_B, soort)), false, soort + " van B");
  }
});

test("bronToegestaan: niets meegegeven betekent 'mijn eigen bron'", () => {
  assert.equal(bronToegestaan(REC_A, "gsc", ""), true);
  assert.equal(bronToegestaan(REC_A, "gsc", null), true);
  assert.equal(bronOfNiets(REC_A, "gsc", undefined), "sc-domain:klant-a.nl");
});

test("bronToegestaan: zonder vastgelegde bron kiest de klant zelf (DIR-86)", () => {
  // Sinds DIR-86 draait een klant op zijn EIGEN Google-koppeling. Een leeg veld is
  // dus geen hek meer maar 'geen voorkeur': alles wat hij kan opvragen is van hem.
  assert.equal(bronToegestaan(REC_B, "adsLogin", "customers/9998887776"), true);
  assert.equal(bronToegestaan({}, "gsc", "sc-domain:van-mezelf.nl"), true);
  assert.equal(bronToegestaan({}, "gsc", ""), true);
  assert.equal(bronOfNiets({}, "ga4", ""), "");                    // nog niets gekozen
  assert.equal(bronOfNiets({}, "ga4", "properties/999"), "properties/999");
  // Maar staat er WEL een voorkeur, dan is dat de enige die telt.
  assert.equal(bronOfNiets(REC_A, "ga4", ""), "properties/111");
  assert.equal(bronOfNiets(REC_A, "ga4", "properties/222"), null);
});

test("bronToegestaan: een andere schrijfwijze komt er niet langs", () => {
  // Genormaliseerd vergelijken, zodat 111 en properties/111 hetzelfde zijn...
  assert.equal(bronToegestaan(REC_A, "ga4", "111"), true);
  assert.equal(bronToegestaan(REC_A, "ads", "1112223334"), true);
  assert.equal(bronToegestaan(REC_A, "ads", "111-222-3334"), true);
  assert.equal(bronToegestaan(REC_A, "meta", "111"), true);
  // ...maar de property van de buurman blijft in elke schrijfwijze verboden.
  assert.equal(bronToegestaan(REC_A, "ga4", "222"), false);
  assert.equal(bronToegestaan(REC_A, "ads", "444-555-6667"), false);
  assert.equal(bronToegestaan(REC_A, "meta", "act_222"), false);
  // En een site die alleen maar lijkt op de eigen site telt niet.
  assert.equal(bronToegestaan(REC_A, "gsc", "sc-domain:klant-a.nl.kwaad.nl"), false);
  assert.equal(bronToegestaan(REC_A, "gsc", "https://klant-a.nl/"), false);
});

test("bronOfNiets: geeft de eigen bron of niets — nooit die van een ander", () => {
  assert.equal(bronOfNiets(REC_A, "ga4", "properties/111"), "properties/111");
  assert.equal(bronOfNiets(REC_A, "ga4", "properties/222"), null);
  assert.equal(bronOfNiets(REC_A, "gsc", "sc-domain:klant-b.nl"), null);
});


test("buildGoogleAuthUrl: PKCE alleen als er een challenge is (DIR-86)", () => {
  const zonder = new URL(buildGoogleAuthUrl({ clientId: "a", redirectUri: "https://x/cb", state: "s" }));
  assert.equal(zonder.searchParams.get("code_challenge"), null);
  const met = new URL(buildGoogleAuthUrl({ clientId: "a", redirectUri: "https://x/cb", state: "s", codeChallenge: "CH" }));
  assert.equal(met.searchParams.get("code_challenge"), "CH");
  assert.equal(met.searchParams.get("code_challenge_method"), "S256");
});

test("pkce: verifier is niet te raden en de challenge is de S256 ervan", async () => {
  const a = pkceVerifier(), b = pkceVerifier();
  assert.equal(a.length >= 43, true);          // ruim boven de RFC-ondergrens
  assert.notEqual(a, b);                        // elke poging een nieuwe
  const ch = await pkceChallenge(a);
  assert.equal(/^[A-Za-z0-9_-]+$/.test(ch), true);   // base64url, geen opvulling
  assert.equal(ch, await pkceChallenge(a));          // stabiel voor dezelfde verifier
  assert.notEqual(ch, await pkceChallenge(b));
});


// ---- DIR-87: gebruiksregistratie ----
const UUR = 60 * 60 * 1000;
const DAG = 24 * UUR;

test("gebruikSleutel: sorteert chronologisch, ook over cijferlengtes heen", () => {
  const vroeg = gebruikSleutel(1000, "aa");
  const laat = gebruikSleutel(1787946000000, "bb");
  assert.equal(vroeg < laat, true);                 // vaste breedte, dus tekstsortering = tijd
  assert.match(gebruikSleutel(5, "x"), /^g:0{13}5-x$/);
});

test("magLoggen: dezelfde agent binnen het venster levert geen tweede regel op", () => {
  const nu = 1_000_000_000;
  assert.equal(magLoggen(0, nu, 30 * 60 * 1000), true);          // nog niets gezien
  assert.equal(magLoggen(nu - 5 * 60 * 1000, nu, 30 * 60 * 1000), false);
  assert.equal(magLoggen(nu - 31 * 60 * 1000, nu, 30 * 60 * 1000), true);
});

test("snoeiGebruik: gooit te oude regels weg en houdt de bovengrens aan", () => {
  const nu = 1_000_000_000_000;
  const regels = [
    { sleutel: "a", tijd: nu - 100 * DAG },      // ouder dan 90 dagen
    { sleutel: "b", tijd: nu - 10 * DAG },
    { sleutel: "c", tijd: nu - 1 * DAG },
    { sleutel: "d", tijd: nu },
  ];
  const weg = snoeiGebruik(regels, nu, { maxAantal: 100, maxLeeftijdMs: 90 * DAG });
  assert.deepEqual(weg, ["a"]);
  // Bovengrens: oudste eerst weg, nieuwste blijven staan.
  const weg2 = snoeiGebruik(regels, nu, { maxAantal: 2, maxLeeftijdMs: 90 * DAG });
  assert.deepEqual(weg2, ["a", "b"]);
  assert.deepEqual(snoeiGebruik([], nu, {}), []);
});

test("telOnbekendVandaag: telt alleen weigeringen van vandaag, en niets persoonlijks", () => {
  const nu = new Date(2026, 7, 28, 14, 0, 0).getTime();
  const regels = [
    { wat: "onbekend", tijd: nu - UUR },
    { wat: "onbekend", tijd: nu - 2 * UUR },
    { wat: "onbekend", tijd: nu - 20 * UUR },              // gisteren
    { wat: "login", tijd: nu - UUR, email: "baas@klant-a.nl" },
  ];
  assert.equal(telOnbekendVandaag(regels, nu), 2);
  // Een onbekende poging bevat geen adres: dat is de hele afspraak.
  assert.equal(regels.filter((r) => r.wat === "onbekend").every((r) => !r.email), true);
});

test("dagSleutel: 'vandaag' is Dirks dag, niet die van de server (UTC)", () => {
  // 28 augustus 00:30 Nederlandse tijd = 27 augustus 22:30 UTC. In UTC zou dit
  // gisteren zijn; voor Dirk is het vandaag.
  const nachtNL = Date.parse("2026-08-27T22:30:00Z");
  assert.equal(dagSleutel(nachtNL, "Europe/Amsterdam"), "2026-08-28");
  assert.equal(dagSleutel(nachtNL, "UTC"), "2026-08-27");
  // En de teller volgt die dag: een poging van 00:30 NL telt bij 10:00 NL mee.
  const ochtendNL = Date.parse("2026-08-28T08:00:00Z");
  const regels = [{ wat: "onbekend", tijd: nachtNL }];
  assert.equal(telOnbekendVandaag(regels, ochtendNL, "Europe/Amsterdam"), 1);
  assert.equal(telOnbekendVandaag(regels, ochtendNL, "UTC"), 0);
});

test("gebruikerSleutel: twee klanten zonder e-mailadres vallen niet samen", () => {
  const a = { email: "", naam: "Klant A" };
  const b = { email: "", naam: "Klant B" };
  assert.notEqual(gebruikerSleutel(a), gebruikerSleutel(b));
  // Zelfde persoon blijft dezelfde sleutel, ook als de naam ontbreekt.
  assert.equal(gebruikerSleutel({ email: "x@y.nl" }), gebruikerSleutel({ email: "x@y.nl", naam: "" }));
  assert.notEqual(gebruikerSleutel({ email: "x@y.nl" }), gebruikerSleutel({ email: "z@y.nl" }));
});

test("geldigSessieId: alleen een UUID telt als sessie-id", () => {
  assert.equal(geldigSessieId("3f2504e0-4f89-41d3-9a0c-0305e82c3301"), true);
  // Dit is de aanval die het gebruikslog wiste: een verzonnen naam in het cookie.
  assert.equal(geldigSessieId("gebruik-log"), false);
  assert.equal(geldigSessieId("log:gebruik"), false);
  assert.equal(geldigSessieId(""), false);
  assert.equal(geldigSessieId(null), false);
  assert.equal(geldigSessieId("3f2504e0-4f89-41d3-9a0c-0305e82c3301x"), false);
});


test("agentStandaard: elke data-agent heeft een korte opening, bewerkbaar (DIR-90)", () => {
  for (const key of ["gsc", "ga4", "ads"]) {
    const a = agentStandaard(key);
    assert.equal(typeof a.opening, "string");
    assert.equal(a.opening.length > 0, true, key + " mist een opening");
    assert.match(a.opening, /momentje/i);
  }
  // Anton haalt geen data op; die heeft niets om even naar te kijken.
  assert.equal(agentStandaard("anton").opening, "");
  // En de opening is via /admin te overschrijven, net als de andere velden.
  const eigen = samenAgent(agentStandaard("gsc"), { opening: "Eventjes kijken hoor." });
  assert.equal(eigen.opening, "Eventjes kijken hoor.");
  assert.equal(eigen.aangepast.opening, true);
});


// ── DIR-92 · credits ────────────────────────────────────────────────────────
// De prijzen staan in de code (AC-10); deze tests pinnen de REKENSOM vast, zodat een
// gewijzigd tarief straks een bewuste aanpassing is en geen stille verschuiving.

test("tokenKosten: Sonnet rekent $2 in en $10 uit per miljoen tokens", () => {
  // 1.000.000 invoer + 1.000.000 uitvoer = $2 + $10.
  const usd = tokenKosten("claude-sonnet-5", { input_tokens: 1000000, output_tokens: 1000000 });
  assert.equal(usd, 12);
  // Opus is duurder: $5 + $25.
  assert.equal(tokenKosten("claude-opus-5", { input_tokens: 1000000, output_tokens: 1000000 }), 30);
  assert.equal(tokenKosten("claude-opus-4-8", { input_tokens: 1000000, output_tokens: 1000000 }), 30);
});

test("tokenKosten: cache-tokens tellen goedkoper mee dan gewone invoer", () => {
  const gewoon = tokenKosten("claude-sonnet-5", { input_tokens: 1000000 });
  const gelezen = tokenKosten("claude-sonnet-5", { cache_read_input_tokens: 1000000 });
  const geschreven = tokenKosten("claude-sonnet-5", { cache_creation_input_tokens: 1000000 });
  assert.equal(gelezen, gewoon * 0.1);          // uit de cache lezen: 0,1x
  assert.equal(geschreven, gewoon * 1.25);      // cache wegschrijven: 1,25x
  assert.equal(gelezen < gewoon, true);
});

test("modelPrijs: een onbekend model kost het Opus-tarief, nooit niets", () => {
  assert.deepEqual(modelPrijs("iets-nieuws"), { invoer: 5, uitvoer: 25 });
  assert.deepEqual(modelPrijs(""), { invoer: 5, uitvoer: 25 });
  assert.deepEqual(modelPrijs("claude-sonnet-5"), { invoer: 2, uitvoer: 10 });
});

test("kostenNaarCredits: koers en marge erbij, naar boven afgerond", () => {
  // $12 * 0,92 * 2 * 100 = 2208 credits, precies.
  assert.equal(kostenNaarCredits(12, 0.92, 2), 2208);
  // Afronden gaat omhoog: $0,001 * 0,92 * 2 * 100 = 0,184 → 1 credit.
  assert.equal(kostenNaarCredits(0.001, 0.92, 2), 1);
  // En het minimum is 1, ook bij een verwaarloosbaar bedrag.
  assert.equal(kostenNaarCredits(0.0000001, 0.92, 2), 1);
  // Een andere koers of marge verandert de uitkomst, niet de vorm.
  assert.equal(kostenNaarCredits(1, 1, 1), 100);
  assert.equal(kostenNaarCredits(1, 0.5, 3), 150);
});

test("meter: alle aanroepen van EEN antwoord worden bij elkaar opgeteld (AC-3)", () => {
  const meter = nieuweMeter();
  // Zo verloopt een antwoord van Albert: eerst data ophalen, dan pas antwoorden.
  meetAanroep(meter, "claude-sonnet-5", { input_tokens: 400000, output_tokens: 100000 });
  meetAanroep(meter, "claude-sonnet-5", { input_tokens: 600000, output_tokens: 900000 });
  assert.equal(meter.aanroepen, 2);
  assert.equal(meter.invoer, 1000000);
  assert.equal(meter.uitvoer, 1000000);
  // Samen $12 — precies alsof het een aanroep was, dus geen dubbele afronding.
  assert.equal(meter.kostenUSD, 12);
  assert.equal(meterCredits(meter, 0.92, 2), 2208);
  assert.equal(meterCredits(meter, 0.92, 2), kostenNaarCredits(12, 0.92, 2));
});

test("meter: twee kleine aanroepen kosten samen 1 credit, niet 2", () => {
  const meter = nieuweMeter();
  meetAanroep(meter, "claude-sonnet-5", { input_tokens: 10, output_tokens: 10 });
  meetAanroep(meter, "claude-sonnet-5", { input_tokens: 10, output_tokens: 10 });
  assert.equal(meterCredits(meter, 0.92, 2), 1);
  // Zonder aanroepen valt er niets af te boeken.
  assert.equal(meterCredits(nieuweMeter(), 0.92, 2), 0);
});

test("meter: een modelwissel halverwege wordt per aanroep afgerekend", () => {
  const meter = nieuweMeter();
  meetAanroep(meter, "claude-sonnet-5", { input_tokens: 1000000 });   // $2
  meetAanroep(meter, "claude-opus-5", { input_tokens: 1000000 });     // $5
  assert.equal(meter.kostenUSD, 7);
});

test("magChattenMetSaldo: op nul gaat de deur dicht (AC-6/AC-7)", () => {
  assert.equal(magChattenMetSaldo(1), true);
  assert.equal(magChattenMetSaldo(0), false);
  assert.equal(magChattenMetSaldo(-25), false);      // doorgeschoten door het laatste antwoord
  // Onbekend saldo (grootboek onbereikbaar) sluit niemand buiten.
  assert.equal(magChattenMetSaldo(null), true);
  assert.equal(magChattenMetSaldo(undefined), true);
});

test("schoneCreditsConfig: onzin uit het formulier wordt een bruikbare instelling", () => {
  // DIR-100 heeft hier maxRegels en bewaardagen bij gezet; de rest is ongewijzigd.
  assert.deepEqual(schoneCreditsConfig({}),
    { startsaldo: 200, koers: 0.92, marge: 2, maxRegels: 500, bewaardagen: 365 });
  assert.deepEqual(schoneCreditsConfig({ startsaldo: 50, koers: 0.9, marge: 3 }),
    { startsaldo: 50, koers: 0.9, marge: 3, maxRegels: 500, bewaardagen: 365 });
  // Geen halve credits, geen negatief startsaldo, geen marge onder 1 (dat zou
  // betekenen dat Dirk onder de kostprijs verkoopt).
  assert.equal(schoneCreditsConfig({ startsaldo: 12.7 }).startsaldo, 13);
  assert.equal(schoneCreditsConfig({ startsaldo: -5 }).startsaldo, 0);
  assert.equal(schoneCreditsConfig({ marge: 0 }).marge, 1);
  assert.equal(schoneCreditsConfig({ koers: "geen getal" }).koers, 0.92);
});

test("boekSleutel: sorteert chronologisch, ook over cijferlengtes heen", () => {
  const vroeg = boekSleutel(9, "a");
  const laat = boekSleutel(1000, "b");
  assert.equal(vroeg < laat, true);
  assert.match(vroeg, /^b:0{13}9-a$/);
});


// ── DIR-93 · klantdashboard ─────────────────────────────────────────────────

test("hoortBijGebruiker: je ziet je eigen regels, en alleen die (AC-9)", () => {
  const mijn = { email: "ik@voorbeeld.nl", credits: 12 };
  const buurman = { email: "buurman@voorbeeld.nl", credits: 999 };
  assert.equal(hoortBijGebruiker(mijn, "ik@voorbeeld.nl"), true);
  assert.equal(hoortBijGebruiker(buurman, "ik@voorbeeld.nl"), false);
  // Hoofdletters en spaties zijn hetzelfde adres, verder is het exact.
  assert.equal(hoortBijGebruiker(mijn, "  IK@Voorbeeld.NL "), true);
  assert.equal(hoortBijGebruiker({ email: "ik@voorbeeld.nl.x" }, "ik@voorbeeld.nl"), false);
});

test("hoortBijGebruiker: zonder adres zie je NIETS, niet alles", () => {
  // Dit is de kern van AC-9: valt de sessie weg, dan mag de filter niet omslaan
  // in 'laat maar alles zien'.
  const regel = { email: "ik@voorbeeld.nl" };
  assert.equal(hoortBijGebruiker(regel, ""), false);
  assert.equal(hoortBijGebruiker(regel, null), false);
  assert.equal(hoortBijGebruiker(regel, undefined), false);
  // En een regel zonder adres hoort bij niemand.
  assert.equal(hoortBijGebruiker({}, "ik@voorbeeld.nl"), false);
  assert.equal(hoortBijGebruiker(null, "ik@voorbeeld.nl"), false);
});

test("hoortBijGebruiker: een meegestuurd adres verandert niets aan het filter", () => {
  // De Worker geeft alleen het adres uit de ondertekende sessie door. Wat een
  // bezoeker ook in zijn verzoek zet, het filter draait op dát adres — dus met de
  // sessie van 'ik' komen de regels van de buurman er nooit doorheen.
  const boek = [
    { email: "ik@voorbeeld.nl", credits: 3 },
    { email: "buurman@voorbeeld.nl", credits: 4 },
    { email: "ik@voorbeeld.nl", credits: 5 },
  ];
  const sessieAdres = "ik@voorbeeld.nl";
  const meegestuurd = "buurman@voorbeeld.nl";        // wat de aanvaller graag wil zien
  const zichtbaar = boek.filter((r) => hoortBijGebruiker(r, sessieAdres));
  assert.equal(zichtbaar.length, 2);
  assert.deepEqual(zichtbaar.map((r) => r.credits), [3, 5]);
  assert.equal(zichtbaar.some((r) => r.email === meegestuurd), false);
});

test("modelVoorKlant: de keuze van de klant wint van /admin (AC-6)", () => {
  assert.equal(modelVoorKlant("claude-opus-5", "claude-sonnet-5"), "claude-opus-5");
  assert.equal(modelVoorKlant("claude-sonnet-5", "claude-opus-5"), "claude-sonnet-5");
});

test("modelVoorKlant: zonder eigen keuze geldt de instelling in /admin", () => {
  assert.equal(modelVoorKlant("", "claude-opus-4-8"), "claude-opus-4-8");
  assert.equal(modelVoorKlant(null, "claude-opus-5"), "claude-opus-5");
  // Staat er in /admin ook niets bruikbaars, dan de standaard.
  assert.equal(modelVoorKlant("", ""), "claude-sonnet-5");
});

test("modelVoorKlant: een verzonnen model komt er nooit doorheen", () => {
  // Anders zou een geknoeide of verouderde waarde alsnog naar de API gaan, en
  // rekent de afboeking uit DIR-92 op een model dat niet bestaat.
  assert.equal(modelVoorKlant("gpt-4", "claude-opus-5"), "claude-opus-5");
  assert.equal(modelVoorKlant("claude-opus-5-super", "claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(modelVoorKlant("gpt-4", "ook-verzonnen"), "claude-sonnet-5");
});

test("klantmodellen: twee keuzes in gewone taal, Sonnet als standaard (AC-5)", () => {
  const keuzes = klantModelKeuzes();
  assert.equal(keuzes.length, 2);
  assert.equal(keuzes[0].id, "claude-sonnet-5");
  assert.match(keuzes[0].label, /standaard/i);
  // Geen modelnamen of jargon in wat de klant leest.
  for (const k of keuzes) {
    assert.equal(k.label.length > 0, true);
    assert.equal(k.uitleg.length > 0, true);
    assert.doesNotMatch(k.label + " " + k.uitleg, /claude|sonnet|opus|token/i);
  }
  // De duurdere keuze legt uit dat hij meer kost.
  assert.match(keuzes[1].uitleg, /credits/i);
});

test("geldigKlantModel: alleen wat de klant echt mag kiezen", () => {
  assert.equal(geldigKlantModel("claude-sonnet-5"), "claude-sonnet-5");
  assert.equal(geldigKlantModel("claude-opus-5"), "claude-opus-5");
  // Niet aangeboden of verzonnen: geen keuze, dus valt hij terug op /admin.
  assert.equal(geldigKlantModel("claude-opus-4-8"), "");
  assert.equal(geldigKlantModel("gpt-4"), "");
  assert.equal(geldigKlantModel(""), "");
  assert.equal(geldigKlantModel(null), "");
});

test("de duurdere keuze kost aantoonbaar meer credits (AC-7)", () => {
  // Dezelfde vraag, hetzelfde tokenverbruik, maar op het model dat de klant koos.
  const usage = { input_tokens: 200000, output_tokens: 50000 };
  const zuinig = nieuweMeter();
  meetAanroep(zuinig, modelVoorKlant("claude-sonnet-5", "claude-sonnet-5"), usage);
  const grondig = nieuweMeter();
  meetAanroep(grondig, modelVoorKlant("claude-opus-5", "claude-sonnet-5"), usage);
  const a = meterCredits(zuinig, 0.92, 2);
  const b = meterCredits(grondig, 0.92, 2);
  assert.equal(b > a, true, "de grondige keuze hoort meer te kosten");
  assert.equal(b, a * 2.5);        // precies de prijsverhouding uit de tabel
});


// ── DIR-93 · review-fixes op #67 ────────────────────────────────────────────

test("nieuwSaldoRecord: een nieuw record krijgt het startsaldo, nooit 0", () => {
  const vers = nieuwSaldoRecord(null, 200, 1000);
  assert.equal(vers.saldo, 200);
  assert.equal(vers.gemaakt, 1000);
  // Ook als de aanleiding iets anders is dan inloggen (bijvoorbeeld een modelkeuze).
  assert.equal(nieuwSaldoRecord(undefined, 50, 1).saldo, 50);
  // Onzin blijft binnen de rails.
  assert.equal(nieuwSaldoRecord(null, -5, 1).saldo, 0);
  assert.equal(nieuwSaldoRecord(null, 12.7, 1).saldo, 13);
  assert.equal(nieuwSaldoRecord(null, "geen getal", 1).saldo, 0);
});

test("nieuwSaldoRecord: een bestaand record wordt NOOIT overschreven", () => {
  // Dit is de kant die geld zou kosten: een tweede uitgifte op een lopend saldo.
  const bestaand = { saldo: 137, gemaakt: 5, model: "claude-opus-5" };
  assert.equal(nieuwSaldoRecord(bestaand, 200, 9), bestaand);
  assert.equal(nieuwSaldoRecord(bestaand, 200, 9).saldo, 137);
  // Een saldo van 0 is een bestaand record, geen ontbrekend record: wie zijn
  // credits opmaakte hoort er geen nieuwe cadeau te krijgen.
  const leeg = { saldo: 0, gemaakt: 5 };
  assert.equal(nieuwSaldoRecord(leeg, 200, 9).saldo, 0);
});

test("modelkeuze vóór de eerste saldo-uitgifte kost het startsaldo niet", () => {
  // De volgorde die misging: eerst een modelkeuze bewaren, daarna pas inloggen.
  // Schreef dat een record met saldo 0 weg, dan deelde /credits/start daarna nooit
  // meer uit - want die kijkt alleen of er al iets staat.
  const STARTSALDO = 200;
  let opslag = null;                                  // nog nooit een saldo gehad

  // 1. /credits/model op een leeg adres
  const naKeuze = nieuwSaldoRecord(opslag, STARTSALDO, 1);
  naKeuze.model = "claude-opus-5";
  opslag = naKeuze;
  assert.equal(opslag.saldo, STARTSALDO, "de keuze mag het startsaldo niet wegnemen");

  // 2. daarna /credits/start bij het inloggen: vindt een record en laat het staan
  const naLogin = nieuwSaldoRecord(opslag, STARTSALDO, 2);
  assert.equal(naLogin.saldo, STARTSALDO);
  assert.equal(naLogin.model, "claude-opus-5", "en de keuze blijft ook bewaard");
});

test("klantRegel: de interne notitie van Dirk gaat niet mee naar de klant", () => {
  const uitHetGrootboek = {
    tijd: 123, soort: "correctie", email: "ik@voorbeeld.nl",
    agent: "", model: "", invoer: 0, uitvoer: 0, cacheLees: 0, cacheSchrijf: 0,
    credits: -100, saldoNa: 300, reden: "coulance na klacht over Dirk",
  };
  const naarDeKlant = klantRegel(uitHetGrootboek);
  // Niet verbergen in de UI maar echt weglaten: anders staat het alsnog in de
  // netwerk-inspectie van de browser.
  assert.equal("reden" in naarDeKlant, false);
  assert.equal(Object.keys(naarDeKlant).indexOf("reden"), -1);
  assert.equal(JSON.stringify(naarDeKlant).includes("coulance"), false);
  // Het adres hoeft er ook niet in: het is per definitie je eigen regel.
  assert.equal("email" in naarDeKlant, false);
  // Wat de klant wél moet zien blijft staan.
  assert.equal(naarDeKlant.soort, "correctie");
  assert.equal(naarDeKlant.credits, -100);
  assert.equal(naarDeKlant.saldoNa, 300);
  assert.equal(naarDeKlant.tijd, 123);
});

test("klantRegel: een verbruiksregel houdt alles wat de klant nodig heeft", () => {
  const regel = klantRegel({
    tijd: 9, soort: "verbruik", email: "ik@voorbeeld.nl", agent: "gsc",
    model: "claude-opus-5", invoer: 120, uitvoer: 30, cacheLees: 5, cacheSchrijf: 7,
    credits: 14, saldoNa: 186, reden: "",
  });
  assert.deepEqual(regel, {
    tijd: 9, soort: "verbruik", agent: "gsc", model: "claude-opus-5",
    invoer: 120, uitvoer: 30, cacheLees: 5, cacheSchrijf: 7,
    credits: 14, saldoNa: 186,
  });
  // Een onbekende soort telt als verbruik, niet als correctie.
  assert.equal(klantRegel({ soort: "iets anders" }).soort, "verbruik");
  assert.equal(klantRegel(null).credits, 0);
});


// ── DIR-100 · snoeien per klant en reserveren ───────────────────────────────

test("snoeien per klant: de index van A en die van B raken elkaar nooit (AC-1)", () => {
  const a = boekIndexPrefix("aap@voorbeeld.nl");
  const b = boekIndexPrefix("noot@voorbeeld.nl");
  assert.notEqual(a, b);
  // Honderd regels van A vallen allemaal onder de prefix van A en onder geen enkele
  // andere. Snoeien met list({prefix: a}) kan dus nooit een regel van B raken - dat
  // is precies wat de globale variant wél deed.
  const vanA = [];
  for (let i = 0; i < 100; i++) vanA.push(boekIndexSleutel("aap@voorbeeld.nl", 1000 + i, "x" + i));
  assert.equal(vanA.every((k) => k.startsWith(a)), true);
  assert.equal(vanA.some((k) => k.startsWith(b)), false);
  // Hoofdletters en spaties zijn hetzelfde adres, dus dezelfde bak.
  assert.equal(boekIndexPrefix("  AAP@Voorbeeld.NL "), a);
});

test("de indexprefix van de een kan niet in die van de ander vallen", () => {
  // Zonder encoderen zou een adres met een dubbele punt in de prefix van een ander
  // adres kunnen vallen, en dan snoeit de een de historie van de ander weg.
  const gewoon = boekIndexPrefix("aap@voorbeeld.nl");
  const gemeen = boekIndexPrefix("aap@voorbeeld.nl:noot@voorbeeld.nl");
  assert.equal(gemeen.startsWith(gewoon), false);
  assert.equal(gewoon.startsWith(gemeen), false);
  // Zelfde bescherming voor de reserveringen.
  assert.equal(reserveringPrefix("aap@voorbeeld.nl:x").startsWith(reserveringPrefix("aap@voorbeeld.nl")), false);
});

test("indexsleutels sorteren chronologisch, ook over cijferlengtes heen", () => {
  const vroeg = boekIndexSleutel("ik@voorbeeld.nl", 9, "a");
  const laat = boekIndexSleutel("ik@voorbeeld.nl", 1000, "b");
  assert.equal(vroeg < laat, true);
});

test("overschot: alleen wat er echt te veel is (AC-3)", () => {
  assert.equal(overschot(6, 5), 1);
  assert.equal(overschot(5, 5), 0);
  assert.equal(overschot(2, 5), 0);       // nooit negatief
  assert.equal(overschot(0, 5), 0);
  // Dit getal is de limiet van de list() bij het snoeien: er worden dus nooit meer
  // sleutels gelezen dan er weg moeten. Geen scan over het hele boek.
  assert.equal(overschot(5000, 500), 4500);
  // Geen maximum meegegeven betekent niets snoeien. Zou dit 5000 teruggeven, dan
  // wist een ontbrekende instelling de hele historie van een klant.
  assert.equal(overschot(5000, undefined), 0);
  assert.equal(overschot(5000, 0), 0);
  assert.equal(overschot(5000, null), 0);
  assert.equal(overschot(5000, "geen getal"), 0);
});

test("snoeiGrensSleutel: de bewaartermijn wordt een bovengrens voor list() (AC-2)", () => {
  const nu = 100 * 24 * 60 * 60 * 1000;                 // dag 100
  const grens = snoeiGrensSleutel("ik@voorbeeld.nl", nu, 30);
  const prefix = boekIndexPrefix("ik@voorbeeld.nl");
  assert.equal(grens.startsWith(prefix), true);
  // Een regel van dag 60 valt vóór de grens (dus weg), een van dag 80 erna (blijft).
  const dag = 24 * 60 * 60 * 1000;
  assert.equal(boekIndexSleutel("ik@voorbeeld.nl", 60 * dag, "a") < grens, true);
  assert.equal(boekIndexSleutel("ik@voorbeeld.nl", 80 * dag, "a") < grens, false);
  // Zonder bewaartermijn ligt de grens op het begin der tijden: er valt niets weg.
  assert.equal(snoeiGrensSleutel("ik@voorbeeld.nl", nu, 0), prefix + "0".repeat(14));
});

test("snoeien raakt alleen de historie, nooit het geld (AC-4)", () => {
  // Alles wat het snoeien aanwijst zit onder de index- of grootboekprefix. Het
  // saldorecord staat onder "s:" en komt in geen enkele van die lijsten voor, dus
  // een gesnoeide regel kan het saldo niet veranderen.
  const prefix = boekIndexPrefix("ik@voorbeeld.nl");
  assert.equal(prefix.startsWith("s:"), false);
  assert.equal(prefix.startsWith("i:"), true);
  assert.equal(boekIndexSleutel("ik@voorbeeld.nl", 1, "a").indexOf("s:"), -1);
  // En de grens voor de bewaartermijn blijft ook binnen de index van deze klant.
  assert.equal(snoeiGrensSleutel("ik@voorbeeld.nl", 999, 1).startsWith(prefix), true);
});

test("reserveringSchatting: een grondiger model reserveert meer (AC-5)", () => {
  const zuinig = reserveringSchatting("claude-sonnet-5", 0.92, 2);
  const grondig = reserveringSchatting("claude-opus-5", 0.92, 2);
  assert.equal(zuinig > 0, true);
  assert.equal(grondig > zuinig, true);
  // Ongeveer de prijsverhouding uit de tabel. Niet exact 2,5x: er wordt naar boven
  // afgerond nadat de verhouding is toegepast, niet erna.
  assert.equal(Math.abs(grondig / zuinig - 2.5) < 0.1, true, zuinig + ' -> ' + grondig);
});

test("twee gelijktijdige reserveringen slagen niet allebei (AC-5)", () => {
  const nu = 1000;
  const saldo = 20;
  // Vraag 1 komt binnen: er is ruimte, dus hij mag en legt zijn schatting vast.
  const eerste = { bedrag: reserveringSchatting("claude-sonnet-5", 0.92, 2), tijd: nu };
  assert.equal(beschikbaarSaldo(saldo, [], nu) > 0, true);
  // Vraag 2 komt binnen terwijl vraag 1 nog loopt: die ziet de reservering staan.
  const naEerste = beschikbaarSaldo(saldo, [eerste], nu);
  assert.equal(naEerste < saldo, true, "de reservering hoort ruimte in te nemen");
  const tweede = { bedrag: eerste.bedrag, tijd: nu };
  // Vraag 3 zou er zonder reserveringen gewoon doorheen zijn gekomen; nu niet meer.
  assert.equal(beschikbaarSaldo(saldo, [eerste, tweede], nu) <= 0, true);
  assert.equal(beschikbaarSaldo(saldo, [], nu) > 0, true, "zonder reserveringen mag het wel");
});

test("een reservering die blijft hangen blokkeert niet voor altijd (AC-7)", () => {
  const ttl = 10 * 60 * 1000;
  const oud = { bedrag: 15, tijd: 0 };
  // Binnen de looptijd telt hij mee: een lopend antwoord mag niet dubbel betaald.
  assert.equal(beschikbaarSaldo(20, [oud], 1000, ttl), 5);
  assert.equal(reserveringVerlopen(oud, 1000, ttl), false);
  // Daarna niet meer, anders zou een afgebroken verzoek een klant blijven blokkeren.
  assert.equal(beschikbaarSaldo(20, [oud], ttl + 1, ttl), 20);
  assert.equal(reserveringVerlopen(oud, ttl + 1, ttl), true);
});

test("beschikbaarSaldo: rare invoer telt als nul, niet als gratis saldo", () => {
  assert.equal(beschikbaarSaldo(100, [null, undefined, {}], 1), 100);
  assert.equal(beschikbaarSaldo(100, [{ bedrag: -50, tijd: 1 }], 1), 100);   // nooit erbij
  assert.equal(beschikbaarSaldo(0, [], 1), 0);
});

test("een mislukt antwoord geeft de reservering vrij (AC-6)", () => {
  // Geen enkele API-aanroep gedaan: er is niets verbruikt, dus de klant houdt alles.
  assert.equal(verrekenActie(nieuweMeter()), "vrijgeef");
  assert.equal(verrekenActie(null), "vrijgeef");
  assert.equal(verrekenActie(undefined), "vrijgeef");
  // Wel gebeld, maar het antwoord ging daarna mis: die tokens zijn echt verbruikt,
  // dus die worden geboekt. Anders zou een fout in de laatste stap gratis zijn.
  const gebruikt = nieuweMeter();
  meetAanroep(gebruikt, "claude-sonnet-5", { input_tokens: 10, output_tokens: 5 });
  assert.equal(verrekenActie(gebruikt), "boek");
});

test("credits-instellingen: maximum per klant en bewaartermijn zijn begrensd (AC-2)", () => {
  const standaard = schoneCreditsConfig({});
  assert.equal(standaard.maxRegels, 500);
  assert.equal(standaard.bewaardagen, 365);
  assert.equal(schoneCreditsConfig({ maxRegels: 5, bewaardagen: 0 }).maxRegels, 10);
  assert.equal(schoneCreditsConfig({ bewaardagen: 0 }).bewaardagen, 1);
  assert.equal(schoneCreditsConfig({ bewaardagen: 99999 }).bewaardagen, 3650);
  assert.equal(schoneCreditsConfig({ maxRegels: 12.6 }).maxRegels, 13);
  // De bestaande instellingen blijven werken zoals ze waren.
  assert.equal(standaard.startsaldo, 200);
  assert.equal(standaard.koers, 0.92);
  assert.equal(standaard.marge, 2);
});


// ── DIR-102 · saldo reist mee met het antwoord ──────────────────────────────

test("saldoEvent: het chat-antwoord stuurt het nieuwe saldo mee (AC-3/AC-4)", () => {
  const regel = saldoEvent({ saldo: 137 });
  assert.match(regel, /^data: /);
  assert.match(regel, /\n\n$/);
  const evt = JSON.parse(regel.slice(5).trim());
  assert.equal(evt.type, "dd_saldo");
  assert.equal(evt.saldo, 137);
  // Nul is een geldig saldo en moet juist wél verstuurd worden (AC-5).
  assert.equal(JSON.parse(saldoEvent({ saldo: 0 }).slice(5).trim()).saldo, 0);
  assert.equal(JSON.parse(saldoEvent({ saldo: -12 }).slice(5).trim()).saldo, -12);
});

test("saldoEvent: de nieuwe grootboekregel gaat mee voor het dashboard (AC-2)", () => {
  const evt = JSON.parse(saldoEvent({ saldo: 50, regel: { tijd: 9, soort: "verbruik", agent: "gsc", credits: 7 } }).slice(5).trim());
  assert.equal(evt.regel.agent, "gsc");
  assert.equal(evt.regel.credits, 7);
  // Zonder regel blijft het event gewoon een saldo, zonder leeg veld.
  assert.equal("regel" in JSON.parse(saldoEvent({ saldo: 50 }).slice(5).trim()), false);
});

test("saldoEvent: zonder zeker bedrag gaat er niets mee (AC-7)", () => {
  // Een mislukte of overgeslagen boeking mag geen bedrag in beeld zetten. Dan liever
  // niets sturen, zodat de pagina laat staan wat er stond.
  assert.equal(saldoEvent(null), "");
  assert.equal(saldoEvent(undefined), "");
  assert.equal(saldoEvent({}), "");
  assert.equal(saldoEvent({ saldo: null }), "");
  assert.equal(saldoEvent({ saldo: "137" }), "");
  assert.equal(saldoEvent({ regel: { agent: "gsc" } }), "");
});

test("saldoEvent: de bestaande SSE-lezer struikelt niet over het extra event", () => {
  // De tekstlezer kijkt alleen naar content_block_delta, dus een dd_saldo-event
  // ertussen verandert niets aan wat er in de bubbel komt.
  const sse = [
    'data: ' + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hallo " } }),
    'data: ' + JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "wereld" } }),
    saldoEvent({ saldo: 12 }).trim(),
    'data: [DONE]',
  ].join("\n");
  assert.equal(extractTextFromSSE(sse), "Hallo wereld");
});


// ── DIR-102 · een traag grootboek mag het antwoord niet ophouden ────────────
// Vóór DIR-102 stond de boeking in waitUntil, dus een hikkende Durable Object raakte
// de gebruiker niet. Nu wachten we er kort op om het saldo mee te kunnen sturen, en
// deze tests leggen vast dat dat wachten begrensd blijft.

test("metGeduld: een snel antwoord komt gewoon door", async () => {
  const uit = await metGeduld(Promise.resolve({ saldo: 42 }), 1000);
  assert.deepEqual(uit, { saldo: 42 });
  // Ook een waarde die al klaar is.
  assert.equal(await metGeduld(7, 1000), 7);
});

test("metGeduld: duurt de boeking te lang, dan gaat het antwoord zonder saldo", async () => {
  // Een belofte die nooit afkomt staat voor een Durable Object die blijft hangen.
  const nooit = new Promise(() => {});
  const begin = Date.now();
  const uit = await metGeduld(nooit, 20);
  assert.equal(uit, null, "geen saldo, dus straks ook geen saldo-event");
  assert.equal(Date.now() - begin < 1000, true, "en er wordt niet op gewacht");
  // saldoEvent maakt er dan niets van, dus de pagina laat het oude bedrag staan.
  assert.equal(saldoEvent(uit), "");
});

test("metGeduld: een mislukte boeking breekt het antwoord niet af", async () => {
  const stuk = Promise.reject(new Error("grootboek onbereikbaar"));
  const uit = await metGeduld(stuk, 1000);
  assert.equal(uit, null);
  assert.equal(saldoEvent(uit), "");
});

test("metGeduld: een onzinnige wachttijd valt terug op meteen opgeven", async () => {
  assert.equal(await metGeduld(new Promise(() => {}), 0), null);
  assert.equal(await metGeduld(new Promise(() => {}), -5), null);
  assert.equal(await metGeduld(new Promise(() => {}), "geen getal"), null);
});
