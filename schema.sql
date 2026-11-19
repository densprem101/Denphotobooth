-- Den Collective cloud accounts. Run once in the D1 console (safe to run again: every statement is IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  email       TEXT UNIQUE,
  name        TEXT,
  picture     TEXT,
  created     INTEGER,
  last_login  INTEGER,
  epoch       INTEGER DEFAULT 0,      -- bump this number to sign the account out of every device
  settings_ts INTEGER DEFAULT 0,
  bytes       INTEGER DEFAULT 0,
  password_hash  TEXT,                -- NULL for people who only use Google
  auth_provider  TEXT,                -- 'email', 'google' or 'hybrid' (both)
  email_verified INTEGER DEFAULT 0    -- 1 once Google has confirmed the email
);
CREATE TABLE IF NOT EXISTS identities (  -- one person can have Google + Facebook + Apple on the same account
  provider TEXT NOT NULL,
  subject  TEXT NOT NULL,
  user_id  TEXT NOT NULL,
  email    TEXT,
  PRIMARY KEY (provider, subject)
);
CREATE TABLE IF NOT EXISTS records (     -- index of what is stored in R2 (photos, templates, layouts)
  user_id TEXT NOT NULL,
  store   TEXT NOT NULL,
  id      TEXT NOT NULL,
  ts      INTEGER,
  size    INTEGER,
  PRIMARY KEY (user_id, store, id)
);
CREATE INDEX IF NOT EXISTS idx_records_user ON records (user_id);

CREATE TABLE IF NOT EXISTS auth_throttle (k TEXT PRIMARY KEY, n INTEGER, ts INTEGER);   -- counts wrong passwords (10 tries per 15 minutes)

-- Long-distance booth (signalling only; video / voice / chat travel directly between the two devices)
CREATE TABLE IF NOT EXISTS booth_rooms (code TEXT PRIMARY KEY, host_tok TEXT, guest_tok TEXT, created INTEGER, host_seen INTEGER, guest_seen INTEGER);
CREATE TABLE IF NOT EXISTS booth_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, to_role TEXT, body TEXT, ts INTEGER);
CREATE INDEX IF NOT EXISTS idx_booth_msgs ON booth_msgs (code, to_role, id);
