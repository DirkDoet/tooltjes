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
| `GET /` | Placeholder-startpagina met "Koppel Search Console"-knop (vervangen in DIR-14). |
| `GET /oauth/start` | Stuurt door naar Google's toestemmingsscherm (scope `webmasters.readonly`). |
| `GET /oauth/callback` | Wisselt de code om voor een access token, maakt de sessie, zet een `httpOnly`-cookie. |
| `GET /api/gsc/sites` | JSON met je GSC-sites. |
| `GET /api/gsc/performance?site=<url>&days=<n>` | Top zoekwoorden + top pagina's met clicks/impressies/CTR/positie. |
| `GET /api/disconnect` | Revoket het token bij Google én vernietigt de sessie. |

Niet-gekoppeld → de `/api/gsc/*`-routes geven een nette JSON-fout (HTTP 401).

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

`GOOGLE_CLIENT_ID` en `GOOGLE_CLIENT_SECRET` staan **alleen** in Worker-secrets,
nooit in de code of in `wrangler.toml`.
