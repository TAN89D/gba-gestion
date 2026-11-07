-- Téléphones abonnés aux notifications « push ». Nouvelle table : rien d'existant n'est modifié.
CREATE TABLE IF NOT EXISTS push_subscriptions (
 endpoint TEXT PRIMARY KEY,
 user_id TEXT NOT NULL REFERENCES users(id),
 company_id TEXT NOT NULL DEFAULT 'main',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_user ON push_subscriptions(user_id);
