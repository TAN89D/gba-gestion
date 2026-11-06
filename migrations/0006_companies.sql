-- Plusieurs entreprises sur un même site (SoBara).
-- L'entreprise d'origine s'appelle « main » : ses données restent dans la table workspace (id=1)
-- et toutes les lignes existantes lui sont rattachées par la valeur par défaut. Rien n'est effacé.
CREATE TABLE IF NOT EXISTS companies (
 id TEXT PRIMARY KEY,
 name TEXT NOT NULL,
 phone TEXT NOT NULL DEFAULT '',
 active INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspaces (
 company_id TEXT PRIMARY KEY REFERENCES companies(id),
 revision INTEGER NOT NULL,
 payload TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN company_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE entries ADD COLUMN company_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE entries ADD COLUMN audio TEXT;
ALTER TABLE material_requests ADD COLUMN company_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE messages ADD COLUMN company_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE presences ADD COLUMN company_id TEXT NOT NULL DEFAULT 'main';
CREATE INDEX IF NOT EXISTS users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS entries_company ON entries(company_id, created_at);
CREATE INDEX IF NOT EXISTS requests_company ON material_requests(company_id, updated_at);
CREATE INDEX IF NOT EXISTS presences_company ON presences(company_id, date);
