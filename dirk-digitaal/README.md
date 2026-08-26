# Dirk Digitaal — GSC-koppeling + sessie (backend)

Cloudflare Worker die een klant via Google OAuth (alleen-lezen Search Console)
koppelt en zijn GSC-data teruggeeft. **Niets permanents:** geen database, geen
refresh-token. De sessie leeft in een Durable Object en wist zichzelf na 30 min
inactiviteit.

Onderdeel van **Dirk Digitaal**; de AI-agent (DIR-13) en het kantoor (DIR-14)
bouwen op deze endpoints.

## Endpoints

| Route | Doel |
|-------|------|
| `GET /` | Het 2D retro-kantoor: 4 bureaus (1 = GSC-agent), klik → chat in het midden (koppelen, analyse, vrij chatten). |
| `GET /oauth/start` | Stuurt door naar Google's toestemmingsscherm (scope `webmasters.readonly`). |
| `GET /oauth/callback` | Wisselt de code om voor een access token, maakt de sessie, zet een `httpOnly`-cookie. |
| `GET /api/gsc/sites` | JSON met je GSC-sites. |
| `GET /api/gsc/performance?site=<url>&days=<n>` | Top zoekwoorden + top pagina's met clicks/impressies/CTR/positie. |
| `POST /api/chat` | GSC-analist-agent (Claude, streaming SSE). Body: `{ "site": "<url>" }` kiest/wisselt de site en levert de SEO-analyse; `{ "message": "..." }` is een vervolgvraag. Lege body: bij meerdere sites → `{ "needSite": true, "sites": [...] }`, bij één site → automatische analyse. |
| `GET /api/disconnect` | Revoket het token bij Google én vernietigt de sessie. |

### GA4 / Gertjan (DIR-28)

Dezelfde Google-koppeling dekt nu ook Google Analytics 4 (agent **Gertjan**).

| Route | Doel |
|-------|------|
| `GET /api/ga4/properties` | JSON met je GA4-properties (Analytics Admin API). |
| `GET /api/ga4/report?property=properties/<id>&metric=<m>&dimension=<d>&days=<n>&filter_value=<v>&row_limit=<n>` | Eén GA4-rapport (Analytics Data API `runReport`). |
| `POST /api/ga4/chat` | GA4-analist-agent (Claude, streaming SSE, live tool-use). Body: `{ "property": "properties/<id>" }` kiest/wisselt de property en levert de analyse; `{ "message": "..." }` is een vervolgvraag. Lege body: meerdere → `{ "needProperty": true, "properties": [...] }`, één → automatische analyse. |

Metrics: `activeUsers`, `sessions`, `screenPageViews`, `conversions`. Dimensies: `pagePath`, `sessionDefaultChannelGroup`, `country`, `deviceCategory`, `date`. Sessie-only, zelfde ephemere aanpak als GSC.

**Google Cloud-setup (eenmalig, zelfde project + OAuth-client):** schakel **Google Analytics Data API** + **Google Analytics Admin API** in, en voeg scope `.../auth/analytics.readonly` toe aan het OAuth consent screen. Koppel daarna opnieuw (het toestemmingsscherm vraagt nu ook GA4).

### Google Ads / Ilona (DIR-30, backend)

Dezelfde Google-koppeling dekt nu ook Google Ads (agent **Ilona**). **Backend-slice**: alleen Google Ads (Meta + frontend volgen later).

| Route | Doel |
|-------|------|
| `GET /api/ads/customers` | JSON met je toegankelijke Google Ads-accounts. |
| `GET /api/ads/report?customer=customers/<id>&report=<r>&days=<n>&row_limit=<n>` | Eén Google Ads-rapport (GAQL via `googleAds:search`). |
| `POST /api/ads/chat` | Ads-agent Ilona (Claude, streaming SSE, live tool-use `ads_report`). Body: `{ "customer": "customers/<id>" }` kiest/wisselt het account + analyse; `{ "message": "..." }` is een vervolgvraag. Lege body: meerdere → `{ "needAccount": true, "accounts": [...] }`, één → automatische analyse. |

Rapporten: `campaigns`, `keywords`, `ad_groups`, `search_terms` (kosten in euro's, klikken, impressies, conversies). Sessie-only, zelfde ephemere aanpak.

**Prerequisites (Dirk, aanvragen kosten tijd):** in hetzelfde Cloud-project de **Google Ads API** (`googleads.googleapis.com`) inschakelen; scope `.../auth/adwords` op het consent screen; een **developer token** aanvragen (Google Ads Manager → API Center) met **Basic Access** (zonder Basic Access alléén eigen test-accounts). Zet het token als secret `GOOGLE_ADS_DEVELOPER_TOKEN`. Zonder dat secret geven de `/api/ads/*`-routes een nette fout.

### Meta Ads per klant — magic-link + System User-token (DIR-30)

Ilona kan óók **Meta Ads** tonen, **per klant**, zonder Facebook-login. Eén server-side **System User-token** (app "Dirk Doet Dashboard") leest de accounts; een **admin** koppelt per klant een ad-account en genereert een **magic-link**. De klant opent zijn link en Ilona toont alleen zíjn Meta-cijfers.

| Route | Doel |
|-------|------|
| `GET /admin` | Klantbeheer (achter `ADMIN_PASSWORD`): klant + Meta ad-account-id toevoegen → unieke magic-link; overzicht + verwijderen. |
| `POST /api/admin/login` | `{ "password": "..." }` → server-side check → httpOnly admin-cookie. |
| `GET/POST/DELETE /api/admin/clients` | Klant-CRUD (alleen admin). Config in KV `CLIENTS`: sleutel → `{ naam, adAccountId }`. |
| `GET /?k=<sleutel>` | Magic-link: scope de sessie tot dat ad-account (cookie), veeg de URL schoon. |

De Ilona-chat (`POST /api/ads/chat`) krijgt binnen een klant-sessie de tool **`meta_report`** (Graph API v21.0, server-to-server met `appsecret_proof`; `time_range[since]`/`[until]` als aparte params). Meta-cijfers: spend, impressies, klikken, bereik, CTR, CPC, resultaten (per campagne).

**Setup (Dirk):** `wrangler kv namespace create CLIENTS` → het id in `wrangler.toml` (`[[kv_namespaces]] binding="CLIENTS"`) plakken. Secrets: `wrangler secret put META_SYSTEM_TOKEN`, `META_APP_SECRET`, `ADMIN_PASSWORD`. Klant-ad-accounts aan de System User toewijzen in Business Manager. Zonder token/secret of geldige sleutel: geen Meta-toegang (nette NL-fout). Het system-token/secret komt **nooit** naar de client; klant A kan niet bij klant B (random sleutels). Google-flows (GSC/GA4/Google Ads) blijven per-user en ongemoeid.

Niet-gekoppeld → de `/api/gsc/*`-, `/api/ga4/*`-, `/api/ads/*`- en chat-routes geven een nette JSON-fout (HTTP 401).

De agent (`/api/chat`) is Nederlands + jij-vorm, gegrond in de GSC-data van de gekozen site (Claude, model `claude-sonnet-5`). De eerste analyse is een SEO-overzicht (samenvatting, sterke pagina's, kansen, trend t.o.v. de vorige 28 dagen) met vaste `## `-secties die de frontend als kaarten toont. Chatgeschiedenis + geladen data leven in de Durable Object en zijn session-only (weg bij disconnect of na 30 min inactiviteit).

## Ephemeer ontwerp

- Alleen een **access token** wordt bewaard (in de Durable Object), geen refresh-token
  (`access_type=online`).
- Elke API-call ververst de activiteit; na **30 min** zonder activiteit wist een
  Durable-Object-alarm het token en alle sessiedata.
- `/api/disconnect` revoket direct bij Google en gooit de sessie weg.

## 1. Google Cloud-setup (handwerk, eenmalig)

1. Maak (of kies) een project op <https://console.cloud.google.com>.
2. **APIs & Services → Enabled APIs** → schakel **Google Search Console API** in.
3. **OAuth consent screen**: User type *External*, vul app-naam + je e-mail in.
   - Voeg scope `.../auth/webmasters.readonly` toe.
   - Zet de app op **Testing** en voeg jezelf toe onder **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Web application**.
   - **Authorized redirect URI:** de gedeployde Worker-URL + `/oauth/callback`
     (dus eerst deployen voor de URL — zie stap 2 — daarna hier invullen).
   - Noteer **Client ID** en **Client secret**.

## 2. Deployen

```bash
cd dirk-digitaal
npx wrangler deploy            # geeft de Worker-URL terug (voor de redirect-URI)
npx wrangler secret put GOOGLE_CLIENT_ID       # plak je client-ID
npx wrangler secret put GOOGLE_CLIENT_SECRET   # plak je client-secret
npx wrangler secret put ANTHROPIC_API_KEY      # voor de agents (/api/chat, /api/ga4/chat, /api/ads/chat)
npx wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN   # optioneel: voor Ilona / Google Ads (/api/ads/*)
```

Vul de Worker-URL + `/oauth/callback` in als redirect-URI in Google (stap 1.4),
en deploy daarna nog één keer als je iets aan de code wijzigt.

## 3. Testen

1. Open `https://<worker-url>/oauth/start` → Google-toestemmingsscherm (alleen-lezen). Keur goed.
2. `https://<worker-url>/api/gsc/sites` → je sites.
3. `https://<worker-url>/api/gsc/performance?site=<jouw-site>&days=28` → zoekwoorden + pagina's.
4. `https://<worker-url>/api/disconnect` → koppeling weg; `/api/gsc/*` geeft daarna een nette fout.

## Lokaal + tests

```bash
npx wrangler dev     # lokale run (OAuth vereist de echte Google-setup)
npm test             # unit-tests van de pure helpers (geen Google nodig)
```

## Secrets

`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ANTHROPIC_API_KEY` en (optioneel) `GOOGLE_ADS_DEVELOPER_TOKEN` staan **alleen**
in Worker-secrets, nooit in de code of in `wrangler.toml`.
