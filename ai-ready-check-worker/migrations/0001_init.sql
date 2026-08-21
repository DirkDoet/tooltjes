-- D1-migratie: leads-tabel voor de AI-ready check (DIR-9).
-- Eén rij per geslaagde check-run: url + tijdstip + totaalscore.
CREATE TABLE IF NOT EXISTS leads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  url         TEXT    NOT NULL,
  checked_at  TEXT    NOT NULL,
  total_score INTEGER NOT NULL
);
