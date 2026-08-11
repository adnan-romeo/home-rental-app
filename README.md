# HomeNest — Home Rental Web Application

A complete full-stack rental marketplace: Vanilla HTML/CSS/JS frontend,
Node.js + Express backend, SQLite (`better-sqlite3`) database, session-based
auth with `bcryptjs` password hashing, and a light/dark theme toggle.

## Project Structure

```
home-rental-app/
├── package.json
├── db.js                 # SQLite init — creates rental_app.db + tables on startup
├── server.js              # Express app + all API routes
├── middleware/
│   └── auth.js            # requireAuth / requireRole middleware
├── public/
│   ├── index.html         # Login / Register page
│   ├── dashboard.html      # Role-based app shell (renter or landlord view)
│   ├── styles.css          # All styling, CSS variables for light/dark theme
│   └── app.js              # All frontend logic (fetch calls, rendering, theme)
└── rental_app.db          # Created automatically the first time you run the app
```

## Setup

```bash
cd home-rental-app
npm install
npm start
```

Then open **http://localhost:3000** in your browser.

The database file `rental_app.db` is created automatically on first run —
no configuration, no separate database server, nothing to set up.

To reset all data, stop the server and delete `rental_app.db` (and the
`-wal` / `-shm` files if present), then restart.

## How to use it

1. Open the app and click **Register**. Create one account as a **Landlord**
   and, in a separate browser/incognito window, one as a **Renter**.
2. As the landlord: go to **My Listings** and create a property.
3. As the renter: browse listings, filter by location/price/rooms, open a
   listing to see the landlord's phone number, and click **Request to Rent**.
4. As the landlord: go to the **Requests** tab and **Accept** the request —
   the listing automatically flips to "rented" and any other pending
   requests for that unit are auto-rejected.
5. As the landlord: go to **Payment Tracker** and toggle the unit between
   Paid/Unpaid for the current month.
6. As the renter: check **My Active Rental** to see the live payment status.
7. Use the theme toggle in the header to switch themes — your preference is
   saved in `localStorage` and persists across refreshes.

## Database Schema

- **users**: `id, name, email, password_hash, role ('renter'|'landlord'), phone`
- **listings**: `id, landlord_id, title, description, rent_fee, location, rooms, status ('available'|'rented')`
- **rental_requests**: `id, listing_id, renter_id, status ('pending'|'accepted'|'rejected'), created_at`
- **payments**: `id, listing_id, renter_id, month, is_paid, amount`

Foreign keys are enforced (`PRAGMA foreign_keys = ON`) with `ON DELETE CASCADE`
so deleting a listing or user cleans up its related requests/payments.

## API Endpoints

| Method | Route | Access | Description |
|---|---|---|---|
| POST | `/api/auth/register` | public | Create account, starts session |
| POST | `/api/auth/login` | public | Log in, starts session |
| POST | `/api/auth/logout` | any | Destroy session |
| GET | `/api/auth/me` | any | Current logged-in user |
| GET | `/api/listings` | public | Browse available listings (filters: `location`, `minRent`, `maxRent`, `rooms`); `?mine=1` returns the logged-in landlord's own listings |
| GET | `/api/listings/:id` | public | Listing detail incl. landlord contact info |
| POST | `/api/listings` | landlord | Create a listing |
| PUT | `/api/listings/:id` | landlord (owner) | Edit a listing |
| DELETE | `/api/listings/:id` | landlord (owner) | Delete a listing |
| POST | `/api/requests` | renter | Send a "request to rent" |
| GET | `/api/requests/mine` | renter | My sent requests |
| GET | `/api/requests/incoming` | landlord | Requests on my listings |
| PUT | `/api/requests/:id/accept` | landlord (owner) | Accept — flips listing to rented, auto-rejects other pending requests, seeds this month's payment |
| PUT | `/api/requests/:id/reject` | landlord (owner) | Reject |
| POST | `/api/payments/toggle` | landlord (owner) | Toggle paid/unpaid for the current month |
| GET | `/api/dashboard/landlord` | landlord | Stats + rented units with payment status |
| GET | `/api/dashboard/renter` | renter | Active rental + payment status + request counts |

All routes return JSON. Errors are `{ "error": "message" }` with an
appropriate HTTP status code (400/401/403/404/409/500) and are never
uncaught — every route is wrapped and a final error-handling middleware
guards against leaking stack traces.

## Notes

- Passwords are hashed with `bcryptjs` (10 salt rounds) — never stored in plain text.
- Sessions are cookie-based (`express-session`), `httpOnly`, 7-day expiry.
- Role-based access control is enforced **server-side** on every mutating
  route (landlord-only, owner-only, renter-only), not just hidden in the UI.
- Theme preference persists via `localStorage` (`homenest-theme`).
