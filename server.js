// server.js
// Home Rental Web Application - backend API server.
// Express + SQLite (better-sqlite3) + bcryptjs + express-session.

const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const db = require('./db');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'rental_session',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  })
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...rest } = user;
  return rest;
}

function asyncRoute(fn) {
  return (req, res, next) => {
    try {
      fn(req, res, next);
    } catch (err) {
      next(err);
    }
  };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/register',
  asyncRoute((req, res) => {
    const { name, email, password, role, phone } = req.body;

    if (!isNonEmptyString(name) || !isNonEmptyString(email) || !isNonEmptyString(password) || !isNonEmptyString(phone)) {
      return res.status(400).json({ error: 'Name, email, password, and phone are all required.' });
    }
    if (role !== 'renter' && role !== 'landlord') {
      return res.status(400).json({ error: "Role must be either 'renter' or 'landlord'." });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const password_hash = bcrypt.hashSync(password, 10);

    const info = db
      .prepare('INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)')
      .run(name.trim(), email.toLowerCase().trim(), password_hash, role, phone.trim());

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.status(201).json({ user: sanitizeUser(user) });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute((req, res) => {
    const { email, password } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.json({ user: sanitizeUser(user) });
  })
);

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('rental_session');
    res.json({ success: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: sanitizeUser(user) });
});

// ---------------------------------------------------------------------------
// LISTING ROUTES
// ---------------------------------------------------------------------------

// Public browse: available listings, with optional filters.
// If a logged-in landlord passes ?mine=1, return all of their own listings instead.
app.get(
  '/api/listings',
  asyncRoute((req, res) => {
    const { minRent, maxRent, location, rooms, mine } = req.query;

    if (mine === '1') {
      if (!req.session.user || req.session.user.role !== 'landlord') {
        return res.status(401).json({ error: 'You must be logged in as a landlord to view your listings.' });
      }
      const listings = db
        .prepare('SELECT * FROM listings WHERE landlord_id = ? ORDER BY created_at DESC')
        .all(req.session.user.id);
      return res.json({ listings });
    }

    let query = "SELECT * FROM listings WHERE status = 'available'";
    const params = [];

    if (minRent) {
      query += ' AND rent_fee >= ?';
      params.push(Number(minRent));
    }
    if (maxRent) {
      query += ' AND rent_fee <= ?';
      params.push(Number(maxRent));
    }
    if (location) {
      query += ' AND location LIKE ?';
      params.push(`%${location}%`);
    }
    if (rooms) {
      query += ' AND rooms = ?';
      params.push(Number(rooms));
    }
    query += ' ORDER BY created_at DESC';

    const listings = db.prepare(query).all(...params);
    res.json({ listings });
  })
);

app.get(
  '/api/listings/:id',
  asyncRoute((req, res) => {
    const listing = db
      .prepare(
        `SELECT listings.*, users.name AS landlord_name, users.phone AS landlord_phone, users.email AS landlord_email
         FROM listings JOIN users ON users.id = listings.landlord_id
         WHERE listings.id = ?`
      )
      .get(req.params.id);

    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    res.json({ listing });
  })
);

app.post(
  '/api/listings',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const { title, description, rent_fee, location, rooms } = req.body;

    if (!isNonEmptyString(title) || !isNonEmptyString(location)) {
      return res.status(400).json({ error: 'Title and location are required.' });
    }
    const fee = Number(rent_fee);
    const roomCount = Number(rooms);
    if (!Number.isFinite(fee) || fee <= 0) {
      return res.status(400).json({ error: 'Rent fee must be a positive number.' });
    }
    if (!Number.isInteger(roomCount) || roomCount <= 0) {
      return res.status(400).json({ error: 'Rooms must be a positive whole number.' });
    }

    const info = db
      .prepare(
        `INSERT INTO listings (landlord_id, title, description, rent_fee, location, rooms, status)
         VALUES (?, ?, ?, ?, ?, ?, 'available')`
      )
      .run(req.session.user.id, title.trim(), (description || '').trim(), fee, location.trim(), roomCount);

    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ listing });
  })
);

app.put(
  '/api/listings/:id',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only edit your own listings.' });
    }

    const { title, description, rent_fee, location, rooms, status } = req.body;

    const newTitle = isNonEmptyString(title) ? title.trim() : listing.title;
    const newDescription = description !== undefined ? String(description).trim() : listing.description;
    const newLocation = isNonEmptyString(location) ? location.trim() : listing.location;
    const newFee = rent_fee !== undefined && Number.isFinite(Number(rent_fee)) && Number(rent_fee) > 0 ? Number(rent_fee) : listing.rent_fee;
    const newRooms = rooms !== undefined && Number.isInteger(Number(rooms)) && Number(rooms) > 0 ? Number(rooms) : listing.rooms;
    const newStatus = status === 'available' || status === 'rented' ? status : listing.status;

    db.prepare(
      `UPDATE listings SET title = ?, description = ?, rent_fee = ?, location = ?, rooms = ?, status = ? WHERE id = ?`
    ).run(newTitle, newDescription, newFee, newLocation, newRooms, newStatus, listing.id);

    const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(listing.id);
    res.json({ listing: updated });
  })
);

app.delete(
  '/api/listings/:id',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only delete your own listings.' });
    }
    db.prepare('DELETE FROM listings WHERE id = ?').run(listing.id);
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// RENTAL REQUEST ROUTES
// ---------------------------------------------------------------------------

app.post(
  '/api/requests',
  requireRole('renter'),
  asyncRoute((req, res) => {
    const { listingId } = req.body;
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.status !== 'available') {
      return res.status(400).json({ error: 'This listing is no longer available.' });
    }

    const existing = db
      .prepare("SELECT * FROM rental_requests WHERE listing_id = ? AND renter_id = ? AND status = 'pending'")
      .get(listingId, req.session.user.id);
    if (existing) {
      return res.status(409).json({ error: 'You already have a pending request for this listing.' });
    }

    const info = db
      .prepare("INSERT INTO rental_requests (listing_id, renter_id, status) VALUES (?, ?, 'pending')")
      .run(listingId, req.session.user.id);

    const request = db.prepare('SELECT * FROM rental_requests WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json({ request });
  })
);

app.get(
  '/api/requests/mine',
  requireRole('renter'),
  asyncRoute((req, res) => {
    const requests = db
      .prepare(
        `SELECT rental_requests.*, listings.title, listings.location, listings.rent_fee, listings.rooms, listings.status AS listing_status
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         WHERE rental_requests.renter_id = ?
         ORDER BY rental_requests.created_at DESC`
      )
      .all(req.session.user.id);
    res.json({ requests });
  })
);

app.get(
  '/api/requests/incoming',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const requests = db
      .prepare(
        `SELECT rental_requests.*, listings.title AS listing_title, users.name AS renter_name, users.phone AS renter_phone, users.email AS renter_email
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         JOIN users ON users.id = rental_requests.renter_id
         WHERE listings.landlord_id = ?
         ORDER BY rental_requests.created_at DESC`
      )
      .all(req.session.user.id);
    res.json({ requests });
  })
);

app.put(
  '/api/requests/:id/accept',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const request = db.prepare('SELECT * FROM rental_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(request.listing_id);
    if (!listing || listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage requests for your own listings.' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be accepted.' });
    }
    if (listing.status !== 'available') {
      return res.status(400).json({ error: 'This listing is already rented.' });
    }

    const acceptTxn = db.transaction(() => {
      db.prepare("UPDATE rental_requests SET status = 'accepted' WHERE id = ?").run(request.id);
      db.prepare("UPDATE listings SET status = 'rented' WHERE id = ?").run(listing.id);
      // Auto-reject any other pending requests for the same listing
      db.prepare(
        "UPDATE rental_requests SET status = 'rejected' WHERE listing_id = ? AND id != ? AND status = 'pending'"
      ).run(listing.id, request.id);
      // Seed the current month's payment record as unpaid
      db.prepare(
        `INSERT OR IGNORE INTO payments (listing_id, renter_id, month, is_paid, amount) VALUES (?, ?, ?, 0, ?)`
      ).run(listing.id, request.renter_id, currentMonth(), listing.rent_fee);
    });
    acceptTxn();

    const updated = db.prepare('SELECT * FROM rental_requests WHERE id = ?').get(request.id);
    res.json({ request: updated });
  })
);

app.put(
  '/api/requests/:id/reject',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const request = db.prepare('SELECT * FROM rental_requests WHERE id = ?').get(req.params.id);
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(request.listing_id);
    if (!listing || listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage requests for your own listings.' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be rejected.' });
    }

    db.prepare("UPDATE rental_requests SET status = 'rejected' WHERE id = ?").run(request.id);
    const updated = db.prepare('SELECT * FROM rental_requests WHERE id = ?').get(request.id);
    res.json({ request: updated });
  })
);

// ---------------------------------------------------------------------------
// PAYMENT ROUTES
// ---------------------------------------------------------------------------

// Toggle paid/unpaid for the current month on a rented listing (landlord only)
app.post(
  '/api/payments/toggle',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const { listingId } = req.body;
    const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(listingId);
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage payments for your own listings.' });
    }
    if (listing.status !== 'rented') {
      return res.status(400).json({ error: 'This listing is not currently rented.' });
    }

    const acceptedRequest = db
      .prepare("SELECT * FROM rental_requests WHERE listing_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1")
      .get(listing.id);
    if (!acceptedRequest) {
      return res.status(400).json({ error: 'No active renter found for this listing.' });
    }

    const month = currentMonth();
    let payment = db
      .prepare('SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?')
      .get(listing.id, acceptedRequest.renter_id, month);

    if (!payment) {
      db.prepare(
        'INSERT INTO payments (listing_id, renter_id, month, is_paid, amount) VALUES (?, ?, ?, 1, ?)'
      ).run(listing.id, acceptedRequest.renter_id, month, listing.rent_fee);
    } else {
      db.prepare('UPDATE payments SET is_paid = ? WHERE id = ?').run(payment.is_paid ? 0 : 1, payment.id);
    }

    payment = db
      .prepare('SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?')
      .get(listing.id, acceptedRequest.renter_id, month);
    res.json({ payment });
  })
);

// ---------------------------------------------------------------------------
// DASHBOARD ROUTES
// ---------------------------------------------------------------------------

app.get(
  '/api/dashboard/landlord',
  requireRole('landlord'),
  asyncRoute((req, res) => {
    const landlordId = req.session.user.id;
    const listings = db.prepare('SELECT * FROM listings WHERE landlord_id = ?').all(landlordId);

    const totalListings = listings.length;
    const rentedCount = listings.filter((l) => l.status === 'rented').length;
    const vacantCount = listings.filter((l) => l.status === 'available').length;

    const pendingRequestsCount = db
      .prepare(
        `SELECT COUNT(*) AS count FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         WHERE listings.landlord_id = ? AND rental_requests.status = 'pending'`
      )
      .get(landlordId).count;

    const month = currentMonth();
    const rentedUnits = listings
      .filter((l) => l.status === 'rented')
      .map((listing) => {
        const acceptedRequest = db
          .prepare(
            `SELECT rental_requests.*, users.name AS renter_name, users.phone AS renter_phone
             FROM rental_requests JOIN users ON users.id = rental_requests.renter_id
             WHERE listing_id = ? AND rental_requests.status = 'accepted'
             ORDER BY rental_requests.created_at DESC LIMIT 1`
          )
          .get(listing.id);

        let payment = null;
        if (acceptedRequest) {
          payment = db
            .prepare('SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?')
            .get(listing.id, acceptedRequest.renter_id, month);
        }

        return {
          listing,
          renter: acceptedRequest
            ? { id: acceptedRequest.renter_id, name: acceptedRequest.renter_name, phone: acceptedRequest.renter_phone }
            : null,
          payment: payment || { month, is_paid: 0, amount: listing.rent_fee }
        };
      });

    res.json({
      stats: { totalListings, rentedCount, vacantCount, pendingRequestsCount },
      rentedUnits
    });
  })
);

app.get(
  '/api/dashboard/renter',
  requireRole('renter'),
  asyncRoute((req, res) => {
    const renterId = req.session.user.id;
    const month = currentMonth();

    const activeRequest = db
      .prepare(
        `SELECT rental_requests.*, listings.title, listings.location, listings.rent_fee, listings.rooms, listings.id AS listing_id,
                users.name AS landlord_name, users.phone AS landlord_phone
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         JOIN users ON users.id = listings.landlord_id
         WHERE rental_requests.renter_id = ? AND rental_requests.status = 'accepted'
         ORDER BY rental_requests.created_at DESC LIMIT 1`
      )
      .get(renterId);

    let payment = null;
    if (activeRequest) {
      payment = db
        .prepare('SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?')
        .get(activeRequest.listing_id, renterId, month);
    }

    const requestCounts = db
      .prepare(
        `SELECT status, COUNT(*) AS count FROM rental_requests WHERE renter_id = ? GROUP BY status`
      )
      .all(renterId);

    res.json({
      activeRental: activeRequest || null,
      payment: payment || (activeRequest ? { month, is_paid: 0, amount: activeRequest.rent_fee } : null),
      requestCounts
    });
  })
);

// ---------------------------------------------------------------------------
// Fallback + error handling
// ---------------------------------------------------------------------------

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found.' });
});

// Centralized error handler - never leak stack traces to the client.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'An unexpected server error occurred. Please try again.' });
});

app.listen(PORT, () => {
  console.log(`Home Rental App running at http://localhost:${PORT}`);
});
