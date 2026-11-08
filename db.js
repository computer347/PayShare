import { DatabaseSync } from "node:sqlite";

// shortcut: one SQLite file; on Render's free tier it resets on redeploy, fine for a demo.
// Schema changes are not migrated: delete payshare.db locally after pulling a schema change.
export const db = new DatabaseSync(process.env.DB_PATH ?? "payshare.db");
db.exec(`
  PRAGMA foreign_keys = ON;
  -- Money route: everyone pays (or holds money with) the app's PayPal account. Checkout: that account is the
  -- merchant, capturing is the payment. Receipt: PayShare forwards each share to the organiser with Payouts.
  CREATE TABLE IF NOT EXISTS tabs (
    id TEXT PRIMARY KEY,
    mode TEXT NOT NULL DEFAULT 'receipt',  -- 'receipt' (after the fact) | 'checkout' (holds before buying)
    title TEXT NOT NULL,
    organiser TEXT NOT NULL,
    payee_email TEXT,                      -- receipt: the organiser's PayPal email for the payout
    merchant TEXT,                         -- checkout: the merchant's name shown to the group
    total_cents INTEGER NOT NULL,
    -- checkout: open -> settling -> booked | failed;  open -> releasing -> released
    status TEXT NOT NULL DEFAULT 'open',
    expires_at TEXT,                       -- checkout: holds are released if not everyone is in by then
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
  -- receipt:  open -> confirming (capture returned) -> paid (PayPal webhook confirmed)
  -- checkout: open -> held -> confirming -> paid;  held -> released;  confirming -> refunded;  open -> out
  CREATE TABLE IF NOT EXISTS shares (
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    person TEXT NOT NULL,
    cents INTEGER NOT NULL,
    order_id TEXT UNIQUE,
    authorization_id TEXT,
    capture_id TEXT,
    payout_batch_id TEXT,                  -- receipt: set once when the organiser is paid out
    status TEXT NOT NULL DEFAULT 'open',
    PRIMARY KEY (tab_id, person)
  );
  -- the group feed shown on the tab page ("✅ PayPal confirmed Anna's 33.00 €")
  CREATE TABLE IF NOT EXISTS feed (
    id INTEGER PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id),
    text TEXT NOT NULL,
    at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  -- PayPal webhook event ids already handled: PayPal retries deliveries, we act once
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);
