// db.js
// Turso / LibSQL database initialization using @libsql/client.

require('dotenv').config();
const { createClient } = require('@libsql/client');

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN
});

async function init() {
  // Create tables if they do not exist.
  await db.executeMultiple(`
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
        photos       TEXT NOT NULL DEFAULT '[]',
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
        month       TEXT NOT NULL,
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

  // Best-effort column additions for older local DB migrations.
  // If the column already exists the ALTER will fail; ignore errors.
  try {
    await db.execute("ALTER TABLE listings ADD COLUMN listing_type TEXT NOT NULL DEFAULT 'rental'");
  } catch (err) {}
  try {
    await db.execute('ALTER TABLE listings ADD COLUMN is_sublet INTEGER NOT NULL DEFAULT 0');
  } catch (err) {}
  try {
    await db.execute("ALTER TABLE listings ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
  } catch (err) {}

  try {
    await db.execute("UPDATE listings SET photos = '[]' WHERE photos IS NULL OR TRIM(photos) = ''");
  } catch (err) {}
}

// Initialize on import but export init to allow explicit control if desired.
init().catch((err) => {
  console.error('Error initializing database:', err);
});

module.exports = { db, init };
