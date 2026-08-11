// server.js
// Home Rental Web Application - backend API server.
// Express + SQLite (better-sqlite3) + bcryptjs + express-session.

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { db, init } = require('./db');
const SQLiteSessionStore = require('./session-store');
const { requireAuth, requireRole } = require('./middleware/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'rental_session',
    secret: process.env.SESSION_SECRET || 'dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    store: new SQLiteSessionStore(),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
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
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseListingType(value) {
  return value === 'roommate' ? 'roommate' : 'rental';
}

function parseBooleanFlag(value) {
  return value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0;
}

function parseListingPhotos(value) {
  if (Array.isArray(value)) {
    return value.filter((photo) => typeof photo === 'string' && photo.trim().length > 0);
  }

  if (typeof value !== 'string' || !value.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((photo) => typeof photo === 'string' && photo.trim().length > 0);
  } catch (err) {
    return [];
  }
}

function hydrateListing(row) {
  if (!row) return row;
  return { ...row, photos: parseListingPhotos(row.photos) };
}

function hydrateListings(rows) {
  return rows.map(hydrateListing);
}

function photosToStorage(value) {
  return JSON.stringify(parseListingPhotos(value));
}

// ---------------------------------------------------------------------------
// AUTH ROUTES
// ---------------------------------------------------------------------------

app.post(
  '/api/auth/register',
  asyncRoute(async (req, res) => {
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

    const existingRes = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email.toLowerCase().trim()] });
    const existing = (existingRes && existingRes.rows && existingRes.rows[0]) || null;
    if (existing) {
      return res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const password_hash = bcrypt.hashSync(password, 10);

    await db.execute({
      sql: 'INSERT INTO users (name, email, password_hash, role, phone) VALUES (?, ?, ?, ?, ?)',
      args: [name.trim(), email.toLowerCase().trim(), password_hash, role, phone.trim()]
    });

    const userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase().trim()] });
    const user = (userRes && userRes.rows && userRes.rows[0]) || null;

    req.session.user = { id: user.id, name: user.name, email: user.email, role: user.role };
    res.status(201).json({ user: sanitizeUser(user) });
  })
);

app.post(
  '/api/auth/login',
  asyncRoute(async (req, res) => {
    const { email, password } = req.body;
    if (!isNonEmptyString(email) || !isNonEmptyString(password)) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }
    const userRes = await db.execute({ sql: 'SELECT * FROM users WHERE email = ?', args: [email.toLowerCase().trim()] });
    const user = (userRes && userRes.rows && userRes.rows[0]) || null;
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

app.get('/api/auth/me', asyncRoute(async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not authenticated.' });
  const userRes = await db.execute({ sql: 'SELECT * FROM users WHERE id = ?', args: [req.session.user.id] });
  const user = (userRes && userRes.rows && userRes.rows[0]) || null;
  if (!user) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ user: sanitizeUser(user) });
}));

// ---------------------------------------------------------------------------
// LISTING ROUTES
// ---------------------------------------------------------------------------

// Public browse: available listings, with optional filters.
// If a logged-in landlord passes ?mine=1, return all of their own listings instead.
app.get(
  '/api/listings',
  asyncRoute(async (req, res) => {
    const { minRent, maxRent, location, rooms, mine } = req.query;

    if (mine === '1') {
      if (!req.session.user || req.session.user.role !== 'landlord') {
        return res.status(401).json({ error: 'You must be logged in as a landlord to view your listings.' });
      }
      const listingsRes = await db.execute({ sql: 'SELECT * FROM listings WHERE landlord_id = ? ORDER BY created_at DESC', args: [req.session.user.id] });
      const listings = listingsRes.rows || [];
      return res.json({ listings: hydrateListings(listings) });
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

    const listingsRes = await db.execute({ sql: query, args: params });
    const listings = listingsRes.rows || [];
    res.json({ listings: hydrateListings(listings) });
  })
);

app.get(
  '/api/listings/:id',
  asyncRoute(async (req, res) => {
    const listingRes = await db.execute({
      sql: `SELECT listings.*, users.name AS poster_name, users.phone AS poster_phone, users.email AS poster_email
         FROM listings JOIN users ON users.id = listings.landlord_id
         WHERE listings.id = ?`,
      args: [req.params.id]
    });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;

    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    res.json({ listing: hydrateListing(listing) });
  })
);

app.post(
  '/api/listings',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const { title, description, rent_fee, location, rooms, listing_type, is_sublet, photos } = req.body;
    const normalizedType = parseListingType(listing_type);

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

    const insertRes = await db.execute({
      sql: `INSERT INTO listings (landlord_id, title, description, rent_fee, location, rooms, listing_type, is_sublet, photos, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'available') RETURNING *`,
      args: [
        req.session.user.id,
        title.trim(),
        (description || '').trim(),
        fee,
        location.trim(),
        roomCount,
        normalizedType,
        parseBooleanFlag(is_sublet),
        photosToStorage(photos)
      ]
    });
    const listing = (insertRes && insertRes.rows && insertRes.rows[0]) || null;
    res.status(201).json({ listing: hydrateListing(listing) });
  })
);

app.put(
  '/api/listings/:id',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [req.params.id] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only edit your own listings.' });
    }

    const { title, description, rent_fee, location, rooms, status, listing_type, is_sublet, photos } = req.body;

    const newTitle = isNonEmptyString(title) ? title.trim() : listing.title;
    const newDescription = description !== undefined ? String(description).trim() : listing.description;
    const newLocation = isNonEmptyString(location) ? location.trim() : listing.location;
    const newFee = rent_fee !== undefined && Number.isFinite(Number(rent_fee)) && Number(rent_fee) > 0 ? Number(rent_fee) : listing.rent_fee;
    const newRooms = rooms !== undefined && Number.isInteger(Number(rooms)) && Number(rooms) > 0 ? Number(rooms) : listing.rooms;
    const newStatus = status === 'available' || status === 'rented' ? status : listing.status;
    const newType = listing_type === 'rental' || listing_type === 'roommate' ? listing_type : listing.listing_type || 'rental';
    const newSublet = is_sublet !== undefined ? parseBooleanFlag(is_sublet) : listing.is_sublet;
    const newPhotos = photos !== undefined ? photosToStorage(photos) : listing.photos;

    await db.execute({
      sql: `UPDATE listings SET title = ?, description = ?, rent_fee = ?, location = ?, rooms = ?, listing_type = ?, is_sublet = ?, photos = ?, status = ? WHERE id = ?`,
      args: [newTitle, newDescription, newFee, newLocation, newRooms, newType, newSublet, newPhotos, newStatus, listing.id]
    });

    const updatedRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [listing.id] });
    const updated = (updatedRes && updatedRes.rows && updatedRes.rows[0]) || null;
    res.json({ listing: hydrateListing(updated) });
  })
);

app.delete(
  '/api/listings/:id',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [req.params.id] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only delete your own listings.' });
    }
    await db.execute({ sql: 'DELETE FROM listings WHERE id = ?', args: [listing.id] });
    res.json({ success: true });
  })
);

// ---------------------------------------------------------------------------
// RENTAL REQUEST ROUTES
// ---------------------------------------------------------------------------

app.post(
  '/api/requests',
  requireRole('renter'),
  asyncRoute(async (req, res) => {
    const { listingId } = req.body;
    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [listingId] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.status !== 'available') {
      return res.status(400).json({ error: 'This listing is no longer available.' });
    }

    const existingRes = await db.execute({ sql: "SELECT * FROM rental_requests WHERE listing_id = ? AND renter_id = ? AND status = 'pending'", args: [listingId, req.session.user.id] });
    const existing = (existingRes && existingRes.rows && existingRes.rows[0]) || null;
    if (existing) {
      return res.status(409).json({ error: 'You already have a pending request for this listing.' });
    }

    const insertRes = await db.execute({ sql: "INSERT INTO rental_requests (listing_id, renter_id, status) VALUES (?, ?, 'pending') RETURNING *", args: [listingId, req.session.user.id] });
    const request = (insertRes && insertRes.rows && insertRes.rows[0]) || null;
    res.status(201).json({ request });
  })
);

app.get(
  '/api/requests/mine',
  requireRole('renter'),
  asyncRoute(async (req, res) => {
    const requestsRes = await db.execute({
      sql: `SELECT rental_requests.*, listings.title, listings.location, listings.rent_fee, listings.rooms, listings.status AS listing_status
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         WHERE rental_requests.renter_id = ?
         ORDER BY rental_requests.created_at DESC`,
      args: [req.session.user.id]
    });
    const requests = requestsRes.rows || [];
    res.json({ requests });
  })
);

app.get(
  '/api/requests/incoming',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const requestsRes = await db.execute({
      sql: `SELECT rental_requests.*, listings.title AS listing_title, users.name AS renter_name, users.phone AS renter_phone, users.email AS renter_email
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         JOIN users ON users.id = rental_requests.renter_id
         WHERE listings.landlord_id = ?
         ORDER BY rental_requests.created_at DESC`,
      args: [req.session.user.id]
    });
    const requests = requestsRes.rows || [];
    res.json({ requests });
  })
);

app.put(
  '/api/requests/:id/accept',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const requestRes = await db.execute({ sql: 'SELECT * FROM rental_requests WHERE id = ?', args: [req.params.id] });
    const request = (requestRes && requestRes.rows && requestRes.rows[0]) || null;
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [request.listing_id] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing || listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage requests for your own listings.' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be accepted.' });
    }
    if (listing.status !== 'available') {
      return res.status(400).json({ error: 'This listing is already rented.' });
    }

    // Transaction: try to run statements atomically using BEGIN/COMMIT.
    await db.execute('BEGIN');
    try {
      await db.execute({ sql: "UPDATE rental_requests SET status = 'accepted' WHERE id = ?", args: [request.id] });
      await db.execute({ sql: "UPDATE listings SET status = 'rented' WHERE id = ?", args: [listing.id] });
      await db.execute({ sql: "UPDATE rental_requests SET status = 'rejected' WHERE listing_id = ? AND id != ? AND status = 'pending'", args: [listing.id, request.id] });
      await db.execute({ sql: `INSERT OR IGNORE INTO payments (listing_id, renter_id, month, is_paid, amount) VALUES (?, ?, ?, 0, ?)`, args: [listing.id, request.renter_id, currentMonth(), listing.rent_fee] });
      await db.execute('COMMIT');
    } catch (err) {
      await db.execute('ROLLBACK');
      throw err;
    }

    const updatedRes = await db.execute({ sql: 'SELECT * FROM rental_requests WHERE id = ?', args: [request.id] });
    const updated = (updatedRes && updatedRes.rows && updatedRes.rows[0]) || null;
    res.json({ request: updated });
  })
);

app.put(
  '/api/requests/:id/reject',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const requestRes = await db.execute({ sql: 'SELECT * FROM rental_requests WHERE id = ?', args: [req.params.id] });
    const request = (requestRes && requestRes.rows && requestRes.rows[0]) || null;
    if (!request) return res.status(404).json({ error: 'Request not found.' });

    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [request.listing_id] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing || listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage requests for your own listings.' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending requests can be rejected.' });
    }

    await db.execute({ sql: "UPDATE rental_requests SET status = 'rejected' WHERE id = ?", args: [request.id] });
    const updatedRes = await db.execute({ sql: 'SELECT * FROM rental_requests WHERE id = ?', args: [request.id] });
    const updated = (updatedRes && updatedRes.rows && updatedRes.rows[0]) || null;
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
  asyncRoute(async (req, res) => {
    const { listingId } = req.body;
    const listingRes = await db.execute({ sql: 'SELECT * FROM listings WHERE id = ?', args: [listingId] });
    const listing = (listingRes && listingRes.rows && listingRes.rows[0]) || null;
    if (!listing) return res.status(404).json({ error: 'Listing not found.' });
    if (listing.landlord_id !== req.session.user.id) {
      return res.status(403).json({ error: 'You can only manage payments for your own listings.' });
    }
    if (listing.status !== 'rented') {
      return res.status(400).json({ error: 'This listing is not currently rented.' });
    }

    const acceptedReqRes = await db.execute({ sql: "SELECT * FROM rental_requests WHERE listing_id = ? AND status = 'accepted' ORDER BY created_at DESC LIMIT 1", args: [listing.id] });
    const acceptedRequest = (acceptedReqRes && acceptedReqRes.rows && acceptedReqRes.rows[0]) || null;
    if (!acceptedRequest) {
      return res.status(400).json({ error: 'No active renter found for this listing.' });
    }

    const month = currentMonth();
    const paymentRes = await db.execute({ sql: 'SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?', args: [listing.id, acceptedRequest.renter_id, month] });
    let payment = (paymentRes && paymentRes.rows && paymentRes.rows[0]) || null;

    if (!payment) {
      await db.execute({ sql: 'INSERT INTO payments (listing_id, renter_id, month, is_paid, amount) VALUES (?, ?, ?, 1, ?)', args: [listing.id, acceptedRequest.renter_id, month, listing.rent_fee] });
    } else {
      await db.execute({ sql: 'UPDATE payments SET is_paid = ? WHERE id = ?', args: [payment.is_paid ? 0 : 1, payment.id] });
    }

    const newPaymentRes = await db.execute({ sql: 'SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?', args: [listing.id, acceptedRequest.renter_id, month] });
    const newPayment = (newPaymentRes && newPaymentRes.rows && newPaymentRes.rows[0]) || null;
    res.json({ payment: newPayment });
  })
);

// ---------------------------------------------------------------------------
// DASHBOARD ROUTES
// ---------------------------------------------------------------------------

app.get(
  '/api/dashboard/landlord',
  requireRole('landlord'),
  asyncRoute(async (req, res) => {
    const landlordId = req.session.user.id;
    const listingsRes = await db.execute({ sql: 'SELECT * FROM listings WHERE landlord_id = ?', args: [landlordId] });
    const listings = listingsRes.rows || [];

    const totalListings = listings.length;
    const rentedCount = listings.filter((l) => l.status === 'rented').length;
    const vacantCount = listings.filter((l) => l.status === 'available').length;

    const pendingRes = await db.execute({
      sql: `SELECT COUNT(*) AS count FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         WHERE listings.landlord_id = ? AND rental_requests.status = 'pending'`,
      args: [landlordId]
    });
    const pendingRequestsCount = (pendingRes && pendingRes.rows && pendingRes.rows[0] && pendingRes.rows[0].count) || 0;

    const month = currentMonth();
    const rentedUnits = [];
    for (const listing of listings.filter((l) => l.status === 'rented')) {
      const acceptedReqRes = await db.execute({
        sql: `SELECT rental_requests.*, users.name AS renter_name, users.phone AS renter_phone
             FROM rental_requests JOIN users ON users.id = rental_requests.renter_id
             WHERE listing_id = ? AND rental_requests.status = 'accepted'
             ORDER BY rental_requests.created_at DESC LIMIT 1`,
        args: [listing.id]
      });
      const acceptedRequest = (acceptedReqRes && acceptedReqRes.rows && acceptedReqRes.rows[0]) || null;

      let payment = null;
      if (acceptedRequest) {
        const paymentRes = await db.execute({ sql: 'SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?', args: [listing.id, acceptedRequest.renter_id, month] });
        payment = (paymentRes && paymentRes.rows && paymentRes.rows[0]) || null;
      }

      rentedUnits.push({
        listing,
        renter: acceptedRequest ? { id: acceptedRequest.renter_id, name: acceptedRequest.renter_name, phone: acceptedRequest.renter_phone } : null,
        payment: payment || { month, is_paid: 0, amount: listing.rent_fee }
      });
    }

    res.json({ stats: { totalListings, rentedCount, vacantCount, pendingRequestsCount }, rentedUnits });
  })
);

app.get(
  '/api/dashboard/renter',
  requireRole('renter'),
  asyncRoute(async (req, res) => {
    const renterId = req.session.user.id;
    const month = currentMonth();

    const activeRes = await db.execute({
      sql: `SELECT rental_requests.*, listings.title, listings.location, listings.rent_fee, listings.rooms, listings.id AS listing_id,
                users.name AS landlord_name, users.phone AS landlord_phone
         FROM rental_requests
         JOIN listings ON listings.id = rental_requests.listing_id
         JOIN users ON users.id = listings.landlord_id
         WHERE rental_requests.renter_id = ? AND rental_requests.status = 'accepted'
         ORDER BY rental_requests.created_at DESC LIMIT 1`,
      args: [renterId]
    });
    const activeRequest = (activeRes && activeRes.rows && activeRes.rows[0]) || null;

    let payment = null;
    if (activeRequest) {
      const paymentRes = await db.execute({ sql: 'SELECT * FROM payments WHERE listing_id = ? AND renter_id = ? AND month = ?', args: [activeRequest.listing_id, renterId, month] });
      payment = (paymentRes && paymentRes.rows && paymentRes.rows[0]) || null;
    }

    const countsRes = await db.execute({ sql: `SELECT status, COUNT(*) AS count FROM rental_requests WHERE renter_id = ? GROUP BY status`, args: [renterId] });
    const requestCounts = countsRes.rows || [];

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

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Home Rental App running at http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Failed to initialize database, server not started.', err);
    process.exit(1);
  });
