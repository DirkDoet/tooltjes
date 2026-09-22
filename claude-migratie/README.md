# Claude-migratie: export naar archief

1. Zet `conversations-000.zip`, `projects-000.zip`, `memories-000.zip` en `chat-project-koppeling.json` samen in één map.
2. Draai `python claude-migratie/archief.py <die map> C:\Claude-archief` (Python 3, niets te installeren, werkt offline).
3. Resultaat: `chats/<project>/` met één markdownbestand per chat, `index.csv` (nieuwste eerst), `projecten/` en `geheugen/`.
4. Opnieuw draaien overschrijft hetzelfde archief; er ontstaan geen dubbele bestanden.
5. Tests: `python -m unittest discover -s claude-migratie` (verzonnen voorbeelddata, geen echte export nodig).
