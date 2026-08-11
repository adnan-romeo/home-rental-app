const session = require('express-session');
const db = require('./db');

const selectSession = db.prepare('SELECT data, expires_at FROM sessions WHERE sid = ?');
const upsertSession = db.prepare(
  `INSERT INTO sessions (sid, data, expires_at, updated_at)
   VALUES (@sid, @data, @expires_at, datetime('now'))
   ON CONFLICT(sid) DO UPDATE SET
     data = excluded.data,
     expires_at = excluded.expires_at,
     updated_at = datetime('now')`
);
const deleteSession = db.prepare('DELETE FROM sessions WHERE sid = ?');
const deleteExpiredSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');

function toExpiryTime(sess) {
  const cookie = sess && sess.cookie;
  if (!cookie) return Date.now() + 1000 * 60 * 60 * 24 * 7;
  if (cookie.expires) {
    const expiresAt = new Date(cookie.expires).getTime();
    if (!Number.isNaN(expiresAt)) return expiresAt;
  }
  if (typeof cookie.originalMaxAge === 'number') {
    return Date.now() + cookie.originalMaxAge;
  }
  return Date.now() + 1000 * 60 * 60 * 24 * 7;
}

class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    deleteExpiredSessions.run(Date.now());
  }

  get(sid, callback) {
    try {
      const row = selectSession.get(sid);
      if (!row) return callback(null, null);
      if (row.expires_at <= Date.now()) {
        deleteSession.run(sid);
        return callback(null, null);
      }
      return callback(null, JSON.parse(row.data));
    } catch (err) {
      return callback(err);
    }
  }

  set(sid, sess, callback) {
    try {
      upsertSession.run({
        sid,
        data: JSON.stringify(sess),
        expires_at: toExpiryTime(sess)
      });
      return callback && callback(null);
    } catch (err) {
      return callback && callback(err);
    }
  }

  destroy(sid, callback) {
    try {
      deleteSession.run(sid);
      return callback && callback(null);
    } catch (err) {
      return callback && callback(err);
    }
  }

  touch(sid, sess, callback) {
    return this.set(sid, sess, callback);
  }
}

module.exports = SQLiteSessionStore;