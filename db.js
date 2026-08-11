// db.js
// Zero-config local SQLite database. The file rental_app.db is created
// automatically in the project root the first time the server starts,
// and all tables are created if they do not already exist.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'rental_app.db');
const db = new Database(DB_PATH);

// Sensible production-ish defaults for a local file DB
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('renter', 'landlord')),
    phone         TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS listings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    landlord_id  INTEGER NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT NOT NULL DEFAULT '',
    rent_fee     REAL NOT NULL,
    location     TEXT NOT NULL,
    rooms        INTEGER NOT NULL,
    listing_type TEXT NOT NULL DEFAULT 'rental' CHECK (listing_type IN ('rental', 'roommate')),
    is_sublet    INTEGER NOT NULL DEFAULT 0 CHECK (is_sublet IN (0, 1)),
    status       TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'rented')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (landlord_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS rental_requests (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  INTEGER NOT NULL,
    renter_id   INTEGER NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
    FOREIGN KEY (renter_id)  REFERENCES users(id)    ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id  INTEGER NOT NULL,
    renter_id   INTEGER NOT NULL,
    month       TEXT NOT NULL, -- format: 'YYYY-MM'
    is_paid     INTEGER NOT NULL DEFAULT 0,
    amount      REAL NOT NULL,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE,
    FOREIGN KEY (renter_id)  REFERENCES users(id)    ON DELETE CASCADE,
    UNIQUE (listing_id, renter_id, month)
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid         TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_listings_landlord ON listings(landlord_id);
  CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
  CREATE INDEX IF NOT EXISTS idx_requests_listing ON rental_requests(listing_id);
  CREATE INDEX IF NOT EXISTS idx_requests_renter ON rental_requests(renter_id);
  CREATE INDEX IF NOT EXISTS idx_payments_listing ON payments(listing_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

const listingColumns = db.prepare('PRAGMA table_info(listings)').all().map((column) => column.name);
if (!listingColumns.includes('listing_type')) {
  db.exec("ALTER TABLE listings ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'rental'");
}
if (!listingColumns.includes('is_sublet')) {
  db.exec('ALTER TABLE listings ADD COLUMN is_sublet INTEGER NOT NULL DEFAULT 0');
}

module.exports = db;
