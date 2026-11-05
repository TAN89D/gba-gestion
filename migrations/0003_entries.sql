CREATE TABLE IF NOT EXISTS entries (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('expense','teamPayment','incident','photo')),
 project_id TEXT NOT NULL,
 user_id TEXT NOT NULL REFERENCES users(id),
 user_name TEXT NOT NULL,
 data TEXT NOT NULL,
 photo TEXT,
 status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','open','resolved','info')),
 account_id TEXT,
 reason TEXT,
 created_at TEXT NOT NULL,
 decided_at TEXT,
 applied_at TEXT,
 apply_error TEXT
);
CREATE INDEX IF NOT EXISTS entries_project ON entries(project_id, created_at);
CREATE INDEX IF NOT EXISTS entries_status ON entries(status, applied_at);
