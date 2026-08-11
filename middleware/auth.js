// middleware/auth.js
// Session-based authentication + role-based access control helpers.

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: 'You must be logged in to do that.' });
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ error: 'You must be logged in to do that.' });
    }
    if (req.session.user.role !== role) {
      return res.status(403).json({ error: `This action requires a ${role} account.` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
