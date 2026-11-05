-- Fil de messages sur un incident ou une demande de matériel.
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY,
 thread_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 user_name TEXT NOT NULL,
 role TEXT NOT NULL,
 text TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id, created_at);

-- Demandes de matériel : besoin (ouvrier) -> demande (chef / gestionnaire) -> commande (direction)
-- -> livré sur le chantier -> reçu par la personne qui l'a demandé.
CREATE TABLE IF NOT EXISTS material_requests (
 id TEXT PRIMARY KEY,
 project_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 user_name TEXT NOT NULL,
 items TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL CHECK(status IN ('besoin','demande','commande','livre','recu','refuse')),
 order_data TEXT,
 order_number TEXT,
 order_applied_at TEXT,
 delivery_applied_at TEXT,
 apply_error TEXT,
 reason TEXT,
 history TEXT NOT NULL DEFAULT '[]',
 created_at TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS requests_status ON material_requests(status, updated_at);
CREATE INDEX IF NOT EXISTS requests_project ON material_requests(project_id, created_at);
