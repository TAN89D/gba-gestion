-- Pointage de l'équipe sur les chantiers (« Je suis arrivé »).
-- Nouvelle table : aucune table existante n'est modifiée.
CREATE TABLE IF NOT EXISTS presences (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 user_name TEXT NOT NULL,
 role TEXT NOT NULL,
 date TEXT NOT NULL,
 time TEXT NOT NULL,
 lat REAL,
 lng REAL,
 note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS presences_once ON presences(user_id, project_id, date);
CREATE INDEX IF NOT EXISTS presences_date ON presences(date, time);
