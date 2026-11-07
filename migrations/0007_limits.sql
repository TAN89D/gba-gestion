-- Limites : inscriptions par connexion, et remise à zéro de la démonstration.
-- Ajouts uniquement : rien n'est modifié ni effacé dans les tables existantes.
ALTER TABLE companies ADD COLUMN ip TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS companies_created ON companies(created_at);
CREATE TABLE IF NOT EXISTS meta (
 key TEXT PRIMARY KEY,
 value TEXT NOT NULL
);
