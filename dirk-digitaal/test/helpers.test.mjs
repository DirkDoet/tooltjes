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
} from "../src/index.js";

test("buildGoogleAuthUrl: read-only scope + online (geen refresh-token)", () => {
  const u = new URL(buildGoogleAuthUrl({
    clientId: "abc.apps.googleusercontent.com",
    redirectUri: "https://dd.example.workers.dev/oauth/callback",
    state: "xyz",
  }));
  assert.equal(u.origin + u.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/webmasters.readonly");
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
