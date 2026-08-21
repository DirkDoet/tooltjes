# AI-ready check — Worker

Cloudflare Worker die een opgegeven website ophaalt, vier AI-ready
check-categorieën uitvoert, een score berekent (0–100), de lead in D1 opslaat
en alles als JSON teruggeeft. De frontend (aparte issue, DIR-10) bouwt hierop.

## API

```
GET /?url=<website>
```

- Geldige site → JSON met `totalScore` en vier categorieën (`vindbaarheid`,
  `data`, `agent`, `techniek`), elk met een `score` en losse `checks`
  (`id`, `label`, `passed`, `tip`).
- Ongeldige of onbereikbare URL → `{ "error": "<nette NL-melding>" }` (HTTP 200).
- `Access-Control-Allow-Origin: *`, dus aanroepbaar vanaf de tooltjes-frontend.

Voorbeeldrespons:

```json
{
  "url": "https://voorbeeld.nl/",
  "checkedAt": "2026-08-21T12:00:00.000Z",
  "totalScore": 72,
  "categories": {
    "vindbaarheid": { "score": 80, "checks": [ { "id": "robots_ai", "label": "AI-crawlers toegestaan in robots.txt", "passed": true, "tip": "..." } ] },
    "data":         { "score": 50, "checks": [] },
    "agent":        { "score": 75, "checks": [] },
    "techniek":     { "score": 100, "checks": [] }
  }
}
```

## Wat wordt gecheckt

- **Vindbaarheid** — robots.txt blokkeert geen AI-crawlers (GPTBot, ClaudeBot,
  PerplexityBot, Google-Extended, CCBot); `llms.txt` aanwezig; sitemap aanwezig;
  `<title>` gevuld; meta-description gevuld.
- **Gestructureerde data** — JSON-LD aanwezig; Open Graph (`og:title`/`og:description`).
- **Agent-bruikbaarheid** — precies één `<h1>`; `<main>` + een van
  `<nav>`/`<header>`/`<footer>`; machine-leesbare contactgegevens
  (`mailto:`/`tel:` of schema `ContactPoint`); formuliervelden hebben labels;
  echte tekst in de initiële HTML.
- **Snelheid/techniek** — HTTPS werkt; viewport-meta; indicatieve responstijd;
  compressie (`Content-Encoding` gzip/br).

Score per categorie = geslaagde checks ÷ totaal × 100. Totaalscore = gemiddelde
van de vier categorie-scores (gelijk gewogen), afgerond.

> De checks zijn heuristisch (regex op de initiële HTML + headers), bewust géén
> headless-browser/Lighthouse. Ruim opgezet en makkelijk bij te stellen in
> `src/index.js`.

## Lokaal draaien

```bash
cd ai-ready-check-worker
npm install          # alleen nodig voor wrangler als devDependency; globale wrangler kan ook
npx wrangler dev
# in een andere terminal:
curl "http://localhost:8787/?url=https://example.com"
```

Unit-tests van de check-logica (geen Cloudflare nodig):

```bash
npm test
```

## D1 opzetten + deployen

1. Maak de database:
   ```bash
   npx wrangler d1 create ai-ready-leads
   ```
   Plak het teruggegeven `database_id` in `wrangler.toml` (veld `database_id`).

2. Voer de migratie uit (lokaal en/of remote):
   ```bash
   npx wrangler d1 migrations apply ai-ready-leads --local
   npx wrangler d1 migrations apply ai-ready-leads --remote
   ```

3. Deploy de Worker:
   ```bash
   npx wrangler deploy
   ```
   Wrangler geeft de Worker-URL terug; die gebruikt de frontend-issue (DIR-10).

4. Controleer de opgeslagen leads:
   ```bash
   npx wrangler d1 execute ai-ready-leads --remote --command "select * from leads"
   ```

## Leads-tabel

| kolom        | type    | inhoud                         |
|--------------|---------|--------------------------------|
| `id`         | INTEGER | autoincrement                  |
| `url`        | TEXT    | gecheckte (eind-)URL           |
| `checked_at` | TEXT    | ISO-tijd van de check          |
| `total_score`| INTEGER | totaalscore 0–100              |

Er wordt één rij geschreven per geslaagde check-run (geldige, bereikbare URL).
