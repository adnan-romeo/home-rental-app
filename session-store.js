const session = require('express-session');
const { db } = require('./db');

const deleteExpiredSessionsSql = 'DELETE FROM sessions WHERE expires_at <= ?';
const selectSessionSql = 'SELECT data, expires_at FROM sessions WHERE sid = ?';
const upsertSessionSql = `INSERT INTO sessions (sid, data, expires_at, updated_at)
   VALUES (?, ?, ?, datetime('now'))
   ON CONFLICT(sid) DO UPDATE SET
     data = excluded.data,
     expires_at = excluded.expires_at,
     updated_at = datetime('now')`;
const deleteSessionSql = 'DELETE FROM sessions WHERE sid = ?';

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
    db.execute({ sql: deleteExpiredSessionsSql, args: [Date.now()] }).catch(() => {});
  }

  get(sid, callback) {
    (async () => {
      try {
        const res = await db.execute({ sql: selectSessionSql, args: [sid] });
        const row = res && res.rows && res.rows[0];
        if (!row) return callback(null, null);
        if (row.expires_at <= Date.now()) {
          await db.execute({ sql: deleteSessionSql, args: [sid] });
          return callback(null, null);
        }
        return callback(null, JSON.parse(row.data));
      } catch (err) {
        return callback(err);
      }
    })();
  }

  set(sid, sess, callback) {
    (async () => {
      try {
        await db.execute({ sql: upsertSessionSql, args: [sid, JSON.stringify(sess), toExpiryTime(sess)] });
        return callback && callback(null);
      } catch (err) {
        return callback && callback(err);
      }
    })();
  }

  destroy(sid, callback) {
    (async () => {
      try {
        await db.execute({ sql: deleteSessionSql, args: [sid] });
        return callback && callback(null);
      } catch (err) {
        return callback && callback(err);
      }
    })();
  }

  touch(sid, sess, callback) {
    return this.set(sid, sess, callback);
  }
}

module.exports = SQLiteSessionStore;