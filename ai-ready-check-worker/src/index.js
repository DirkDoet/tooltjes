/*
 * AI-ready check — Cloudflare Worker (DIR-9)
 *
 * GET /?url=<website> → JSON met een AI-ready score (0–100) verdeeld over 4
 * categorieën, elk met losse checks en een concrete NL fix-tip per gefaalde check.
 * Bij een geslaagde check-run wordt de lead (url + tijd + totaalscore) naar D1
 * weggeschreven. CORS staat open zodat de frontend (andere origin) hem mag aanroepen.
 *
 * Bewust géén headless-browser/Lighthouse (NG-3): alle checks zijn heuristisch op
 * de initiële HTML + response-headers + robots/llms/sitemap. De HTML wordt met
 * regexes onderzocht (een Worker heeft geen DOM); de heuristieken zijn ruim en
 * gedocumenteerd, zodat ze makkelijk bij te stellen zijn.
 *
 * De pure analyse-functies worden geëxporteerd voor unit-tests (test/checks.test.mjs).
 */

const AI_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"];
const FETCH_TIMEOUT_MS = 10000;
const TRAAG_MS = 2000; // drempel voor de indicatieve snelheidscheck

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

// --- URL normaliseren + valideren ---------------------------------------
export function normalizeUrl(raw) {
  if (!raw || !raw.trim()) return null;
  let s = raw.trim();
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname || !u.hostname.includes(".")) return null;
  // Forceer https voor de check (AC-2: redirect naar https indien nodig).
  u.protocol = "https:";
  return u.toString();
}

async function safeFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const start = Date.now();
  try {
    const resp = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": "AI-ready-check/1.0 (+https://github.com/DirkDoet/tooltjes)" },
    });
    const text = await resp.text();
    return {
      ok: resp.ok,
      status: resp.status,
      text,
      headers: resp.headers,
      finalUrl: resp.url || url,
      timeMs: Date.now() - start,
    };
  } catch (e) {
    return { ok: false, status: 0, text: "", headers: null, finalUrl: url, timeMs: Date.now() - start, error: String(e) };
  } finally {
    clearTimeout(timer);
  }
}

// --- robots.txt parsing --------------------------------------------------
export function parseRobots(txt) {
  const groups = [];
  let current = null;
  for (const raw of (txt || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const val = m[2].trim();
    if (field === "user-agent") {
      // Nieuwe user-agent na regels → nieuwe groep; opeenvolgende UA's delen een groep.
      if (current && current.hasRules) current = null;
      if (!current) {
        current = { agents: [], disallows: [], hasRules: false };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
    } else if (field === "disallow") {
      if (current) {
        current.disallows.push(val);
        current.hasRules = true;
      }
    } else if (field === "allow") {
      if (current) current.hasRules = true;
    }
  }
  return groups;
}

// llms.txt geldt als aanwezig zodra één van de opgehaalde locaties (root of
// /.well-known/) 200 OK gaf met niet-lege tekst.
export function llmsAanwezig(...resultaten) {
  return resultaten.some((r) => r && r.ok && !!(r.text || "").trim());
}

export function botIsBlocked(groups, bot) {
  const b = bot.toLowerCase();
  const specific = groups.filter((g) => g.agents.includes(b));
  const wildcard = groups.filter((g) => g.agents.includes("*"));
  const chosen = specific.length ? specific : wildcard;
  for (const g of chosen) {
    if (g.disallows.some((d) => d.trim() === "/")) return true;
  }
  return false;
}

// --- HTML-heuristieken ---------------------------------------------------
function has(re, html) {
  return re.test(html);
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function chk(id, label, passed, tip) {
  return { id, label, passed, tip };
}

/*
 * Kernanalyse. Puur (geen netwerk/Worker-API's) zodat het unit-testbaar is.
 * Params:
 *   html            initiële HTML van de hoofdpagina
 *   ctx = { robotsTxt, llmsPresent, sitemapPresent, isHttps, viewportMs, contentEncoding }
 * Geeft het `categories`-object terug volgens het JSON-contract (AC-5).
 */
export function analyze(html, ctx) {
  const h = html || "";
  const robotsGroups = parseRobots(ctx.robotsTxt || "");
  const blockedBots = AI_BOTS.filter((b) => botIsBlocked(robotsGroups, b));

  // Vindbaarheid
  const titleMatch = h.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleOk = !!(titleMatch && titleMatch[1].trim());
  const metaDescOk = /<meta[^>]+name=["']description["'][^>]+content=["'][^"']*\S[^"']*["']/i.test(h)
    || /<meta[^>]+content=["'][^"']*\S[^"']*["'][^>]+name=["']description["']/i.test(h);

  const vindbaarheid = [
    chk("robots_ai", "AI-crawlers toegestaan in robots.txt", blockedBots.length === 0,
      blockedBots.length === 0
        ? "AI-crawlers worden niet geblokkeerd."
        : `robots.txt blokkeert: ${blockedBots.join(", ")}. Haal de Disallow: / voor deze bots weg zodat AI-zoekmachines je site mogen lezen.`),
    chk("llms_txt", "llms.txt aanwezig", !!ctx.llmsPresent,
      "Voeg een /llms.txt (of /.well-known/llms.txt) toe met een korte, platte-tekst samenvatting van je site voor AI-modellen."),
    chk("sitemap", "Sitemap aanwezig", !!ctx.sitemapPresent,
      "Publiceer een /sitemap.xml (of verwijs ernaar in robots.txt) zodat crawlers al je pagina's vinden."),
    chk("title", "Paginatitel gevuld", titleOk,
      "Geef de pagina een duidelijke, unieke <title>."),
    chk("meta_description", "Meta-description gevuld", metaDescOk,
      "Voeg een <meta name=\"description\"> toe die kort beschrijft waar de pagina over gaat."),
  ];

  // Gestructureerde data
  const jsonLdOk = /<script[^>]+type=["']application\/ld\+json["'][^>]*>/i.test(h);
  const ogOk = /<meta[^>]+property=["']og:(title|description)["']/i.test(h);
  const data = [
    chk("json_ld", "JSON-LD gestructureerde data aanwezig", jsonLdOk,
      "Voeg schema.org JSON-LD toe (<script type=\"application/ld+json\">) zodat AI je content gestructureerd begrijpt."),
    chk("open_graph", "Open Graph-tags aanwezig", ogOk,
      "Voeg og:title en og:description toe voor betere weergave en begrip door AI en social."),
  ];

  // Agent-bruikbaarheid
  const h1Count = (h.match(/<h1[\s>]/gi) || []).length;
  const hasMain = /<main[\s>]/i.test(h);
  const hasOtherLandmark = /<(nav|header|footer)[\s>]/i.test(h);
  const contactOk = /(mailto:|tel:)/i.test(h) || /"@type"\s*:\s*"ContactPoint"/i.test(h);
  const forms = h.match(/<form[\s\S]*?<\/form>/gi) || [];
  const formLabelsOk = checkFormLabels(forms);
  const textLen = stripTags(h).length;
  const contentOk = textLen >= 200;

  const agent = [
    chk("single_h1", "Precies één <h1>", h1Count === 1,
      h1Count === 1 ? "Goede kop-structuur." : `Er zijn ${h1Count} <h1>-koppen; gebruik er precies één als hoofdkop.`),
    chk("landmarks", "Semantische landmarks", hasMain && hasOtherLandmark,
      "Gebruik <main> plus <nav>/<header>/<footer> zodat agents de paginastructuur herkennen."),
    chk("contact", "Machine-leesbare contactgegevens", contactOk,
      "Voeg een mailto:- of tel:-link toe (of schema.org ContactPoint) zodat AI je contactgegevens kan lezen."),
    chk("form_labels", "Formuliervelden hebben labels", formLabelsOk,
      "Koppel elk invoerveld aan een <label> (of aria-label) zodat het doel machine-leesbaar is."),
    chk("content_text", "Tekst in de initiële HTML", contentOk,
      "Zorg dat de belangrijkste tekst in de server-HTML staat, niet pas na JavaScript; anders zien crawlers een lege pagina."),
  ];

  // Snelheid / techniek
  const enc = (ctx.contentEncoding || "").toLowerCase();
  const compressionOk = enc.includes("gzip") || enc.includes("br");
  const viewportOk = /<meta[^>]+name=["']viewport["']/i.test(h);
  const fast = typeof ctx.responseMs === "number" && ctx.responseMs < TRAAG_MS;

  const techniek = [
    chk("https", "HTTPS werkt", !!ctx.isHttps,
      "Serveer de site over HTTPS met een geldig certificaat."),
    chk("viewport", "Viewport-meta aanwezig", viewportOk,
      "Voeg <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> toe voor mobiel."),
    chk("response_time", "Snelle respons", fast,
      `Responstijd was ${ctx.responseMs} ms${fast ? "" : ` (streef naar < ${TRAAG_MS} ms; overweeg caching/CDN)`}.`),
    chk("compression", "Compressie (gzip/br)", compressionOk,
      "Zet gzip- of brotli-compressie aan op de server (Content-Encoding) om de pagina sneller te laden."),
  ];

  return {
    vindbaarheid: buildCategory(vindbaarheid),
    data: buildCategory(data),
    agent: buildCategory(agent),
    techniek: buildCategory(techniek),
  };
}

// Formulier-labelcheck (heuristisch): geslaagd als er geen labelbare velden zijn,
// of als er minstens evenveel labels/aria-labels als labelbare inputs zijn.
export function checkFormLabels(forms) {
  let labelable = 0;
  let labelled = 0;
  for (const form of forms) {
    const inputs = form.match(/<(input|select|textarea)\b[^>]*>/gi) || [];
    for (const el of inputs) {
      if (/type=["'](hidden|submit|button|image|reset)["']/i.test(el)) continue;
      labelable++;
      if (/aria-label(ledby)?=/i.test(el)) labelled++;
    }
    const labels = (form.match(/<label\b/gi) || []).length;
    labelled += labels;
  }
  if (labelable === 0) return true;
  return labelled >= labelable;
}

function buildCategory(checks) {
  const passed = checks.filter((c) => c.passed).length;
  const score = Math.round((passed / checks.length) * 100);
  return { score, checks };
}

function computeTotal(categories) {
  const scores = Object.values(categories).map((c) => c.score);
  return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const reqUrl = new URL(request.url);
    const raw = reqUrl.searchParams.get("url");
    const target = normalizeUrl(raw);
    if (!target) {
      return jsonResponse({ error: "Geef een geldige website-URL op via ?url=, bijvoorbeeld ?url=https://voorbeeld.nl" });
    }

    const main = await safeFetch(target);
    if (!main.ok) {
      return jsonResponse({
        error: `De site kon niet worden opgehaald (${main.status || "geen verbinding"}). Controleer of de URL klopt en bereikbaar is.`,
      });
    }

    const finalUrl = main.finalUrl;
    let origin;
    try {
      origin = new URL(finalUrl).origin;
    } catch (e) {
      origin = new URL(target).origin;
    }

    // Aanvullende bestanden best-effort ophalen (afwezig ≠ fout). llms.txt mag
    // op de root of op de erkende /.well-known/-locatie staan.
    const [robots, llms, llmsWellKnown, sitemap] = await Promise.all([
      safeFetch(origin + "/robots.txt"),
      safeFetch(origin + "/llms.txt"),
      safeFetch(origin + "/.well-known/llms.txt"),
      safeFetch(origin + "/sitemap.xml"),
    ]);

    const robotsTxt = robots.ok ? robots.text : "";
    const sitemapPresent = sitemap.ok || /(^|\n)\s*sitemap\s*:/i.test(robotsTxt);
    const llmsPresent = llmsAanwezig(llms, llmsWellKnown);

    const categories = analyze(main.text, {
      robotsTxt,
      llmsPresent,
      sitemapPresent,
      isHttps: finalUrl.startsWith("https://"),
      responseMs: main.timeMs,
      contentEncoding: main.headers ? main.headers.get("content-encoding") || "" : "",
    });

    const totalScore = computeTotal(categories);
    const checkedAt = new Date().toISOString();

    // Lead wegschrijven (AC-6): één rij per geslaagde check-run. Faalt dit,
    // dan blokkeert het de response niet.
    if (env && env.DB) {
      try {
        await env.DB.prepare(
          "INSERT INTO leads (url, checked_at, total_score) VALUES (?, ?, ?)"
        ).bind(finalUrl, checkedAt, totalScore).run();
      } catch (e) {
        console.error("D1-insert mislukt:", e);
      }
    }

    return jsonResponse({ url: finalUrl, checkedAt, totalScore, categories });
  },
};
