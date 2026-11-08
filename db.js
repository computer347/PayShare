import { DatabaseSync } from "node:sqlite";

// shortcut: one SQLite file; on Render's free tier it resets on redeploy, fine for a demo
export const db = new DatabaseSync(process.env.DB_PATH ?? "payshare.db");
db.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    organiser TEXT NOT NULL,          -- the person who paid the bill
    payee_email TEXT NOT NULL,        -- their PayPal email; shares are paid straight to them
    total_cents INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    name TEXT NOT NULL,
    cents INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS claims (
    item_id INTEGER NOT NULL REFERENCES items(id),
    person TEXT NOT NULL,
    PRIMARY KEY (item_id, person)
  );
  -- status: open -> confirming (capture call returned) -> paid (PayPal webhook confirmed)
  CREATE TABLE IF NOT EXISTS shares (
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    person TEXT NOT NULL,
    cents INTEGER NOT NULL,
    order_id TEXT UNIQUE,
    capture_id TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (tab_id, person)
  );
`);
