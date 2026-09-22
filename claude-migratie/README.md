# Claude-migratie naar Claude Teams

## Export naar archief (`archief.py`)

1. Zet `conversations-000.zip`, `projects-000.zip`, `memories-000.zip` en `chat-project-koppeling.json` samen in één map.
2. Draai `python claude-migratie/archief.py <die map> C:\Claude-archief` (Python 3, niets te installeren, werkt offline).
3. Resultaat: `chats/<project>/` met één markdownbestand per chat, `index.csv` (nieuwste eerst), `projecten/` en `geheugen/`.
4. Opnieuw draaien overschrijft hetzelfde archief; er ontstaan geen dubbele bestanden.

## Skills en checklist (`skills.py`)

1. Draai `python claude-migratie/skills.py C:\Claude-archief` op de pc waar de desktop-app de skills gesynct heeft.
2. Resultaat: `skills/<naam>.zip` voor elke eigen skill (skills van Anthropic worden overgeslagen) en `CHECKLIST.md`.
3. Werk `CHECKLIST.md` van boven naar beneden af; zeg het persoonlijke abonnement pas op als alles is afgevinkt.

Tests van beide scripts: `python -m unittest discover -s claude-migratie` (verzonnen voorbeelddata, geen echte export nodig).
