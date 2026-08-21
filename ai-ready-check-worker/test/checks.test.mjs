import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  parseRobots,
  botIsBlocked,
  checkFormLabels,
  analyze,
} from "../src/index.js";

test("normalizeUrl accepteert en forceert https", () => {
  assert.equal(normalizeUrl("voorbeeld.nl"), "https://voorbeeld.nl/");
  assert.equal(normalizeUrl("http://voorbeeld.nl"), "https://voorbeeld.nl/");
  assert.equal(normalizeUrl("https://a.b/pad?x=1"), "https://a.b/pad?x=1");
});

test("normalizeUrl weigert onzin", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("geen-domein"), null);
  assert.equal(normalizeUrl("ftp://a.b"), null);
});

test("robots: AI-bot geblokkeerd via eigen groep", () => {
  const g = parseRobots("User-agent: GPTBot\nDisallow: /");
  assert.equal(botIsBlocked(g, "GPTBot"), true);
  assert.equal(botIsBlocked(g, "ClaudeBot"), false);
});

test("robots: wildcard Disallow / blokkeert alle bots", () => {
  const g = parseRobots("User-agent: *\nDisallow: /");
  assert.equal(botIsBlocked(g, "CCBot"), true);
});

test("robots: specifieke Allow-groep wint van wildcard", () => {
  const g = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: GPTBot\nDisallow:");
  assert.equal(botIsBlocked(g, "GPTBot"), false); // eigen groep, geen Disallow: /
  assert.equal(botIsBlocked(g, "CCBot"), true);   // valt onder wildcard
});

test("checkFormLabels: geen velden = geslaagd", () => {
  assert.equal(checkFormLabels([]), true);
});

test("checkFormLabels: input met label geslaagd, zonder label gefaald", () => {
  assert.equal(checkFormLabels(['<form><label>Naam</label><input type="text"></form>']), true);
  assert.equal(checkFormLabels(['<form><input type="text"></form>']), false);
  assert.equal(checkFormLabels(['<form><input type="text" aria-label="Naam"></form>']), true);
});

const GOEDE_HTML = `<!doctype html><html><head>
<title>Voorbeeld</title>
<meta name="description" content="Een nette beschrijving van de pagina">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:title" content="Voorbeeld">
<script type="application/ld+json">{"@context":"https://schema.org"}</script>
</head><body>
<header>kop</header><nav>menu</nav>
<main><h1>Welkom</h1><p>${"Veel echte tekst ".repeat(30)}</p>
<a href="mailto:info@voorbeeld.nl">mail</a></main>
<footer>voet</footer></body></html>`;

test("analyze: goede pagina scoort hoog", () => {
  const cats = analyze(GOEDE_HTML, {
    robotsTxt: "User-agent: *\nDisallow:\nSitemap: https://voorbeeld.nl/sitemap.xml",
    llmsPresent: true,
    sitemapPresent: true,
    isHttps: true,
    responseMs: 300,
    contentEncoding: "br",
  });
  assert.equal(cats.vindbaarheid.score, 100);
  assert.equal(cats.data.score, 100);
  assert.equal(cats.agent.score, 100);
  assert.equal(cats.techniek.score, 100);
  // check-contract: id/label/passed/tip aanwezig
  const c = cats.vindbaarheid.checks[0];
  assert.ok(c.id && c.label && typeof c.passed === "boolean" && typeof c.tip === "string");
});

test("analyze: kale pagina met geblokkeerde bots scoort laag", () => {
  const cats = analyze("<html><head></head><body>korte tekst</body></html>", {
    robotsTxt: "User-agent: GPTBot\nDisallow: /",
    llmsPresent: false,
    sitemapPresent: false,
    isHttps: false,
    responseMs: 5000,
    contentEncoding: "",
  });
  const robotsCheck = cats.vindbaarheid.checks.find((c) => c.id === "robots_ai");
  assert.equal(robotsCheck.passed, false);
  assert.equal(cats.techniek.checks.find((c) => c.id === "https").passed, false);
  assert.ok(cats.vindbaarheid.score < 50);
});
