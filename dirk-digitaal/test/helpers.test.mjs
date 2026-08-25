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

test("firstAnalysisPrompt vraagt om eerste analyse + inzoom-vraag", () => {
  assert.match(firstAnalysisPrompt(), /eerste analyse/i);
  assert.match(firstAnalysisPrompt(), /inzoomen/i);
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
