/* ============================================================================================================
   Den Collective: Google sign-in + cloud sync.  Cloudflare Pages "advanced mode" worker (ONE file, no build step).

   - Handles ONLY /api/*  (see _routes.json). The website itself is served by Cloudflare directly and never passes
     through this file, so a mistake here can never take the booth offline.
   - Safe to re-upload the site any time: bindings (D1 + R2) and secrets live in the Cloudflare dashboard, not in the zip.
   - Needs:  D1 binding  DB  |  R2 binding  FILES  |  secrets  SESSION_SECRET, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
   - The database tables create themselves the first time they are needed (no SQL to paste).
   - Every sign-in failure is logged (Cloudflare "Real-time Logs") and reported to the page with an exact reason code.
   Sections: 1 helpers · 2 sessions · 3 Google · 4 auth routes · 5 sync routes · 6 diagnostics · 7 router
   ============================================================================================================ */

/* ---------- 1. helpers ---------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const b64uEnc = (buf) => { const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const b64uDec = (str) => { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const bin = atob(str), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hex = (u) => [...u].map((v) => v.toString(16).padStart(2, '0')).join('');
const now = () => Date.now();
const NO_STORE = { 'Cache-Control': 'no-store, private' };
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE, ...extra } });
const fail = (status, code) => json({ ok: false, error: code }, status);
const clean = (v) => String(v == null ? '' : v).replace(/^[\s"']+|[\s"']+$/g, '');          // secrets pasted with a space / new line / quotes still work
const cfg = (env) => ({ secret: clean(env.SESSION_SECRET), gid: clean(env.GOOGLE_CLIENT_ID), gsec: clean(env.GOOGLE_CLIENT_SECRET) });
const log = (event, data) => { try { console.log(JSON.stringify({ event, ...data })); } catch (e) { /* logging never breaks a request */ } };
class AuthError extends Error { constructor(stage, code, desc) { super(code); this.stage = stage; this.code = String(code || 'unknown').toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40); this.desc = String(desc || '').slice(0, 300); } }
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };

function parseCookies(req) { const out = {}; (req.headers.get('Cookie') || '').split(/;\s*/).forEach((p) => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1)); }); return out; }
function cookie(name, value, o) { return `${name}=${encodeURIComponent(value)}; Path=${o.path || '/'}; HttpOnly; Secure; SameSite=${o.sameSite || 'Lax'}; Max-Age=${o.maxAge}`; }

/* the tables create themselves once per worker start (IF NOT EXISTS), so there is no SQL to paste and nothing to forget */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, picture TEXT, created INTEGER, last_login INTEGER, epoch INTEGER DEFAULT 0, settings_ts INTEGER DEFAULT 0, bytes INTEGER DEFAULT 0)',
  'CREATE TABLE IF NOT EXISTS identities (provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, email TEXT, PRIMARY KEY (provider, subject))',
  'CREATE TABLE IF NOT EXISTS records (user_id TEXT NOT NULL, store TEXT NOT NULL, id TEXT NOT NULL, ts INTEGER, size INTEGER, PRIMARY KEY (user_id, store, id))',
  'CREATE INDEX IF NOT EXISTS idx_records_user ON records (user_id)',
  'CREATE TABLE IF NOT EXISTS auth_throttle (k TEXT PRIMARY KEY, n INTEGER, ts INTEGER)',
  'CREATE TABLE IF NOT EXISTS booth_rooms (code TEXT PRIMARY KEY, host_tok TEXT, guest_tok TEXT, created INTEGER, host_seen INTEGER, guest_seen INTEGER)',
  'CREATE TABLE IF NOT EXISTS booth_msgs (id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT, to_role TEXT, body TEXT, ts INTEGER)',
  'CREATE INDEX IF NOT EXISTS idx_booth_msgs ON booth_msgs (code, to_role, id)'];
/* An older or half-finished setup can leave a table that exists but is missing columns (that makes every insert fail). Any missing column is added automatically. */
const EXPECT = {
  users: { id: 'TEXT', email: 'TEXT', name: 'TEXT', picture: 'TEXT', created: 'INTEGER', last_login: 'INTEGER', epoch: 'INTEGER DEFAULT 0', settings_ts: 'INTEGER DEFAULT 0', bytes: 'INTEGER DEFAULT 0', password_hash: 'TEXT', auth_provider: 'TEXT', email_verified: 'INTEGER DEFAULT 0' },
  auth_throttle: { k: 'TEXT', n: 'INTEGER', ts: 'INTEGER' },
  booth_rooms: { code: 'TEXT', host_tok: 'TEXT', guest_tok: 'TEXT', created: 'INTEGER', host_seen: 'INTEGER', guest_seen: 'INTEGER' },
  booth_msgs: { id: 'INTEGER', code: 'TEXT', to_role: 'TEXT', body: 'TEXT', ts: 'INTEGER' },
  identities: { provider: 'TEXT', subject: 'TEXT', user_id: 'TEXT', email: 'TEXT' },
  records: { user_id: 'TEXT', store: 'TEXT', id: 'TEXT', ts: 'INTEGER', size: 'INTEGER' } };
let schemaReady = null, schemaProblems = [];
async function migrateSchema(env) {
  const problems = [];
  for (const t of Object.keys(EXPECT)) {
    const info = await env.DB.prepare(`PRAGMA table_info(${t})`).all(), have = new Set((info.results || []).map((r) => r.name));
    for (const c of Object.keys(EXPECT[t])) if (!have.has(c)) {
      try { await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN ${c} ${EXPECT[t][c]}`).run(); log('schema_migrated', { table: t, column: c }); }
      catch (e) { problems.push(`${t}.${c}`); log('schema_migrate_failed', { table: t, column: c, message: String(e && e.message) }); }
    }
  }
  return problems;
}
const ensureSchema = (env) => (schemaReady = schemaReady || (async () => { await env.DB.batch(SCHEMA.map((q) => env.DB.prepare(q))); schemaProblems = await migrateSchema(env); })().catch((e) => { schemaReady = null; log('schema_error', { message: String(e && e.message) }); }));

/* ---------- 2. signed tokens + sessions (stateless, HMAC-SHA256) ---------- */
const hmacKey = (env) => crypto.subtle.importKey('raw', enc.encode(cfg(env).secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function signToken(env, payload, ttlSec) {
  const body = b64uEnc(enc.encode(JSON.stringify({ ...payload, exp: Math.floor(now() / 1000) + ttlSec })));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return body + '.' + b64uEnc(sig);
}
async function readToken(env, token) {
  try {
    const [body, sig] = String(token || '').split('.'); if (!body || !sig) return null;
    if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), b64uDec(sig), enc.encode(body)))) return null;
    const p = JSON.parse(dec.decode(b64uDec(body))); return p.exp > Math.floor(now() / 1000) ? p : null;
  } catch (e) { return null; }
}
const SESSION_DAYS = 180;                                  // long-lived, and renewed on use (see /api/me): a person who keeps using the booth is never signed out by the clock
async function currentUser(req, env) {
  if (!env.DB || !cfg(env).secret) return null;
  await ensureSchema(env);
  const t = await readToken(env, parseCookies(req).den_session); if (!t || !t.u) return null;
  const u = await env.DB.prepare('SELECT id, email, name, picture, epoch, settings_ts, bytes, password_hash FROM users WHERE id = ?').bind(t.u).first();
  if (!u || (u.epoch || 0) !== (t.e || 0)) return null;
  u.sessExp = t.exp; u.sessEpoch = t.e || 0;                 // lets /api/me slide the expiry forward
  return u;
}
/* state-changing calls must come from our own pages: custom header + same Origin (blocks cross-site forgery) */
function sameSiteOk(req, url) { if (req.headers.get('X-Den-Cloud') !== '1') return false; const o = req.headers.get('Origin'); return !o || o === url.origin; }

/* ---------- 3. Google sign-in (OAuth 2.0 authorization-code flow + PKCE + OpenID Connect) ---------- */
const GOOGLE = { auth: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', jwks: 'https://www.googleapis.com/oauth2/v3/certs', issuers: ['https://accounts.google.com', 'accounts.google.com'] };
const googleReady = (env) => { const c = cfg(env); return !!(c.gid && c.gsec); };
const redirectUri = (origin) => `${origin}/api/auth/google/callback`;
const form = (o) => new URLSearchParams(o).toString();

/** Decodes the ID token Google sent back, checks who it is for and when, and (when Google's keys are reachable) its signature.
    The token arrives straight from Google's token endpoint over HTTPS, so if only the key download fails we still accept it (OpenID Connect Core 3.1.3.7). */
async function readIdToken(idToken, aud, nonce) {
  const parts = String(idToken || '').split('.'); if (parts.length !== 3) throw new AuthError('idtoken', 'malformed');
  let head, claims; try { head = JSON.parse(dec.decode(b64uDec(parts[0]))); claims = JSON.parse(dec.decode(b64uDec(parts[1]))); } catch (e) { throw new AuthError('idtoken', 'unreadable'); }
  if (!GOOGLE.issuers.includes(claims.iss)) throw new AuthError('idtoken', 'wrong_issuer', claims.iss);
  if (claims.aud !== aud) throw new AuthError('idtoken', 'wrong_audience', 'token is for another client id');
  if (!(claims.exp > Math.floor(now() / 1000) - 120)) throw new AuthError('idtoken', 'expired');
  if (nonce && claims.nonce !== nonce) throw new AuthError('idtoken', 'wrong_nonce');
  try {
    const keys = (await (await fetch(GOOGLE.jwks)).json()).keys || [], jwk = keys.find((k) => k.kid === head.kid); if (!jwk) throw new Error('key_not_found');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDec(parts[2]), enc.encode(parts[0] + '.' + parts[1])))) throw new AuthError('idtoken', 'bad_signature');
  } catch (e) { if (e instanceof AuthError) throw e; log('jwks_unavailable', { message: String(e && e.message) }); }   // keys unreachable: claims were still checked above
  return claims;
}
/** one-time code -> verified Google profile.  Every failure becomes an AuthError that says exactly what Google (or our check) rejected. */
async function exchangeCode(env, origin, code, st) {
  const c = cfg(env);
  let res, j;
  try { res = await fetch(GOOGLE.token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: form({ grant_type: 'authorization_code', code, client_id: c.gid, client_secret: c.gsec, redirect_uri: redirectUri(origin), code_verifier: st.v }) }); j = await res.json().catch(() => ({})); }
  catch (e) { throw new AuthError('token', 'network', String(e && e.message)); }
  if (!res.ok || !j.id_token) throw new AuthError('token', j.error || 'http_' + res.status, j.error_description);
  const claims = await readIdToken(j.id_token, c.gid, st.n);
  return { provider: 'google', subject: String(claims.sub), email: claims.email || '', verified: claims.email_verified === true || claims.email_verified === 'true', name: claims.name || '', picture: claims.picture || '' };
}

/* ---------- 4. auth routes ---------- */
const safeReturn = (r) => (typeof r === 'string' && /^\/[^/\\]*/.test(r) && !r.startsWith('//') ? r : '/');
const toLogin = (origin, reason, detail) => `${origin}/?cloud=error&reason=${encodeURIComponent(reason)}${detail ? '&detail=' + encodeURIComponent(detail) : ''}`;
const clearOauth = () => cookie('den_oauth', '', { path: '/api/auth', maxAge: 0 });
const clearOauthRoot = () => cookie('den_oauth', '', { path: '/', maxAge: 0 });
/* coarse network address (IPv4 /24, IPv6 /48): ties a cookie-less sign-in to the network it started on */
const netOf = (req) => { const ip = (req.headers.get('CF-Connecting-IP') || '').trim(); if (!ip) return ''; return ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip.split('.').slice(0, 3).join('.'); };
async function authStart(req, env, url) {
  const c = cfg(env); if (!googleReady(env) || !c.secret) { log('oauth_start_blocked', { reason: 'not_configured', hasId: !!c.gid, hasSecret: !!c.gsec, hasSession: !!c.secret }); return Response.redirect(toLogin(url.origin, 'not_configured'), 302); }
  const state = hex(rand(16)), nonce = hex(rand(16)), verifier = b64uEnc(rand(32));
  const q = { response_type: 'code', client_id: c.gid, redirect_uri: redirectUri(url.origin), scope: 'openid email profile', state, nonce, prompt: 'select_account',
    code_challenge: b64uEnc(await crypto.subtle.digest('SHA-256', enc.encode(verifier))), code_challenge_method: 'S256' };
  /* The sign-in details travel in TWO places: the cookie, and the signed `state` itself. Some browsers (an installed iPhone/iPad app, Safari private mode, in-app browsers) keep a separate cookie jar for the Google page, so the cookie can be missing when Google sends the person back. */
  const tok = await signToken(env, { s: state, n: nonce, v: verifier, r: safeReturn(url.searchParams.get('return')), i: netOf(req) }, 600);
  q.state = tok;
  const h = new Headers({ Location: GOOGLE.auth + '?' + form(q), ...NO_STORE });
  h.append('Set-Cookie', cookie('den_oauth', tok, { path: '/', maxAge: 600 }));
  return new Response(null, { status: 302, headers: h });
}
async function upsertUser(env, p) {
  const db = env.DB, t = now();
  const idn = await db.prepare('SELECT user_id FROM identities WHERE provider = ? AND subject = ?').bind(p.provider, p.subject).first();
  let user = null;
  if (idn) user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(idn.user_id).first();
  const email = (p.email || '').trim().toLowerCase();
  if (!user && email && p.verified) user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();   // same verified email = same person (and the same cloud data)
  if (user && !idn && user.password_hash && !user.email_verified) {
    /* An email + password account that nobody proved the email for, now met by the real owner signing in with Google. The password could have been set by someone else, so it is cleared (and every old login is signed out); the Google login owns the account, and its owner can set a new password from the menu. */
    await db.prepare('UPDATE users SET password_hash = NULL, epoch = COALESCE(epoch, 0) + 1 WHERE id = ?').bind(user.id).run();
    user.password_hash = null; log('password_cleared_on_google_link', {});
  }
  if (!user) {
    const id = 'u_' + hex(rand(16)), mail = email || `${p.provider}-${p.subject}@social.den.local`;
    await db.prepare('INSERT INTO users (id, email, name, picture, created, last_login, epoch, settings_ts, bytes, auth_provider, email_verified) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0, \'google\', 1)').bind(id, mail, p.name || mail.split('@')[0], p.picture || '', t, t).run();
    user = { id, email: mail, name: p.name || mail.split('@')[0] };
  } else {
    await db.prepare('UPDATE users SET last_login = ?, name = CASE WHEN name = \'\' OR name IS NULL THEN ? ELSE name END, picture = CASE WHEN picture = \'\' OR picture IS NULL THEN ? ELSE picture END WHERE id = ?').bind(t, p.name || '', p.picture || '', user.id).run();
  }
  if (!idn) await db.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, email) VALUES (?, ?, ?, ?)').bind(p.provider, p.subject, user.id, email).run();
  if (p.verified) await db.prepare("UPDATE users SET email_verified = 1, auth_provider = CASE WHEN password_hash IS NOT NULL AND password_hash != '' THEN 'hybrid' ELSE 'google' END WHERE id = ?").bind(user.id).run();
  return user.id;
}
async function authCallback(req, env, url) {
  const c = cfg(env), fb = (reason, detail, extra) => { log('oauth_error', { provider: 'google', reason, detail: detail || '', host: url.host, clientIdTail: c.gid.slice(-12), redirectUri: redirectUri(url.origin), ...(extra || {}) }); const h = new Headers({ Location: toLogin(url.origin, reason, detail), ...NO_STORE }); h.append('Set-Cookie', clearOauth()); h.append('Set-Cookie', clearOauthRoot()); return new Response(null, { status: 303, headers: h }); };
  if (!googleReady(env) || !c.secret || !env.DB) return fb('not_configured', !env.DB ? 'no_database' : 'missing_secret');
  const err = url.searchParams.get('error');
  if (err) return fb(err === 'access_denied' ? 'cancelled' : 'google_' + String(err).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 40), url.searchParams.get('error_description') || '');
  const cookieTok = parseCookies(req).den_oauth, code = url.searchParams.get('code'), stateParam = url.searchParams.get('state') || '';
  let st;
  if (cookieTok) {                                                                   // normal path: the cookie and the state sent back by Google must be the same signed value
    st = await readToken(env, cookieTok);
    if (!st) return fb('state', 'expired');
    if (!code || stateParam !== cookieTok) return fb('state', 'mismatch');
  } else {                                                                           // no cookie came back (separate cookie jar / blocked): trust the signed state, but only from the same network it started on
    st = await readToken(env, stateParam);
    const here = netOf(req);
    if (!st || !st.i || !here || st.i !== here || !code) return fb('state', 'no_cookie');
    log('oauth_state_fallback', { host: url.host });
  }
  let profile;
  try { profile = await exchangeCode(env, url.origin, code, st); }
  catch (e) { const a = e instanceof AuthError ? e : new AuthError('token', 'unexpected', e && e.message); return fb(a.stage === 'token' ? 'google_' + a.code : 'token_' + a.code, a.desc, { stage: a.stage, error: a.code, description: a.desc }); }
  let uid;
  try {
    await ensureSchema(env);
    try { uid = await upsertUser(env, profile); }
    catch (e) { if (!/no such table|no column named|no such column|has no column/i.test(String(e && e.message))) throw e; schemaReady = null; await ensureSchema(env); uid = await upsertUser(env, profile); }   // tables missing: create them and try once more
  }
  catch (e) { return fb('db', String(e && e.message).replace(/^D1_ERROR:\s*/i, '').slice(0, 110), { message: String(e && e.message) }); }
  try {
    const u = await env.DB.prepare('SELECT epoch FROM users WHERE id = ?').bind(uid).first();
    const sess = await signToken(env, { u: uid, e: (u && u.epoch) || 0 }, SESSION_DAYS * 86400);
    const back = st.r || '/', h = new Headers({ Location: `${url.origin}${back}${back.includes('?') ? '&' : '?'}cloud=ok`, ...NO_STORE });
    h.append('Set-Cookie', cookie('den_session', sess, { maxAge: SESSION_DAYS * 86400 })); h.append('Set-Cookie', clearOauth()); h.append('Set-Cookie', clearOauthRoot());
    log('oauth_ok', { provider: 'google', host: url.host });
    return new Response(null, { status: 303, headers: h });
  } catch (e) { return fb('login_failed', 'session', { message: String(e && e.message) }); }
}
/* ---------- email + password accounts: the same users table, the same sessions and the same cloud storage as Google ---------- */
const PW_ITER = 100000;                                         // Cloudflare Workers allows at most 100000 PBKDF2 iterations
async function pwHash(pw, salt) {
  salt = salt || rand(16);
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pw).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PW_ITER }, key, 256);
  return 'pbkdf2$' + PW_ITER + '$' + b64uEnc(salt) + '$' + b64uEnc(bits);
}
async function pwVerify(pw, stored) {
  const m = /^pbkdf2\$(\d+)\$([\w-]+)\$([\w-]+)$/.exec(String(stored || '')); if (!m) return false;
  const iter = Math.min(PW_ITER, parseInt(m[1], 10) || PW_ITER), salt = b64uDec(m[2]), want = b64uDec(m[3]);
  for (const cand of new Set([String(pw), String(pw).trim()])) {          // phone keyboards like to add a trailing space
    const key = await crypto.subtle.importKey('raw', enc.encode(cand.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const got = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
    let d = got.length ^ want.length; for (let i = 0; i < got.length; i++) d |= got[i] ^ (want[i] || 0);
    if (d === 0) return true;
  }
  return false;
}
const DUMMY_HASH = 'pbkdf2$100000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';   // makes "no such email" take as long as "wrong password"
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
async function readBody(req) { const t = await req.text(); if (t.length > 4000) return null; try { const j = JSON.parse(t); return j && typeof j === 'object' ? j : null; } catch (e) { return null; } }
const THROTTLE = { max: 10, windowMs: 15 * 60 * 1000 };
async function throttleKeys(req, email) { return ['e:' + email, 'i:' + (netOf(req) || '?')]; }
async function isLocked(env, keys) {
  for (const k of keys) { const r = await env.DB.prepare('SELECT n, ts FROM auth_throttle WHERE k = ?').bind(k).first(); if (r && r.n >= THROTTLE.max && now() - r.ts < THROTTLE.windowMs) return true; }
  return false;
}
async function noteFail(env, keys) {
  for (const k of keys) await env.DB.prepare('INSERT INTO auth_throttle (k, n, ts) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ? - ts > ? THEN 1 ELSE n + 1 END, ts = ?').bind(k, now(), now(), THROTTLE.windowMs, now()).run();
}
async function noteOk(env, keys) { try { await env.DB.prepare('DELETE FROM auth_throttle WHERE k = ?').bind(keys[0]).run(); } catch (e) { /* best effort */ } }
async function sessionFor(env, uid) {
  const u = await env.DB.prepare('SELECT epoch FROM users WHERE id = ?').bind(uid).first();
  const tok = await signToken(env, { u: uid, e: (u && u.epoch) || 0 }, SESSION_DAYS * 86400);
  return { 'Set-Cookie': cookie('den_session', tok, { maxAge: SESSION_DAYS * 86400 }) };
}
const pubUser = (u, hasPw) => ({ id: u.id, email: u.email, name: u.name || '', picture: u.picture || '', hasPassword: !!hasPw });
async function authRegister(req, env, user) {
  const b = await readBody(req); if (!b) return fail(400, 'bad_request');
  const email = String(b.email || '').normalize('NFKC').trim().toLowerCase(), pw = String(b.password || ''), name = String(b.name || '').trim().slice(0, 40);
  if (!EMAIL_RE.test(email) || email.length > 254) return fail(400, 'bad_email');
  if (pw.length < 6 || pw.length > 100) return fail(400, 'bad_password');
  if (email === OWNER_EMAIL) return fail(403, 'reserved');                              // reserved for the verified owner: only Google sign-in can open this account
  const keys = await throttleKeys(req, email); if (await isLocked(env, keys)) return fail(429, 'too_many');
  const row = await env.DB.prepare('SELECT id, email, name, picture, password_hash FROM users WHERE LOWER(email) = ?').bind(email).first();
  if (row) {
    if (row.password_hash) return fail(409, 'exists');                                   // same person: log in instead
    if (user && user.id === row.id) return authSetPassword(req, env, user, { password: pw });   // already signed in to this very account (Google): this just adds the password
    return fail(409, 'google_account');                                                  // never let a stranger attach a password to somebody else's Google account
  }
  const id = 'u_' + hex(rand(16)), t = now(), hash = await pwHash(pw);
  await env.DB.prepare('INSERT INTO users (id, email, name, picture, created, last_login, epoch, settings_ts, bytes, password_hash, auth_provider, email_verified) VALUES (?, ?, ?, \'\', ?, ?, 0, 0, 0, ?, \'email\', 0)').bind(id, email, name || email.split('@')[0], t, t, hash).run();
  await env.DB.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, email) VALUES (\'password\', ?, ?, ?)').bind(email, id, email).run();
  log('register_ok', {});
  return json({ ok: true, user: pubUser({ id, email, name: name || email.split('@')[0] }, true) }, 200, await sessionFor(env, id));
}
async function authLogin(req, env) {
  const b = await readBody(req); if (!b) return fail(400, 'bad_request');
  const email = String(b.email || '').normalize('NFKC').trim().toLowerCase(), pw = String(b.password || '');
  if (!EMAIL_RE.test(email) || !pw || pw.length > 100) return fail(401, 'invalid');
  const keys = await throttleKeys(req, email); if (await isLocked(env, keys)) return fail(429, 'too_many');
  const row = await env.DB.prepare('SELECT id, email, name, picture, password_hash FROM users WHERE LOWER(email) = ?').bind(email).first();
  const ok = await pwVerify(pw, row && row.password_hash ? row.password_hash : DUMMY_HASH);
  if (!row) { await noteFail(env, keys); return fail(401, 'invalid'); }
  if (!row.password_hash) { await noteFail(env, keys); return fail(401, 'google_only'); }   // this email exists but only signs in with Google (no password set yet)
  if (!ok) { await noteFail(env, keys); return fail(401, 'invalid'); }
  await noteOk(env, keys);
  await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now(), row.id).run();
  return json({ ok: true, user: pubUser(row, true) }, 200, await sessionFor(env, row.id));
}
/** Signed-in people can add a password to a Google account (bridging both log-ins), or change the one they have. */
async function authSetPassword(req, env, user, preset) {
  const b = preset || await readBody(req); if (!b) return fail(400, 'bad_request');
  const pw = String(b.password || ''), cur = String(b.current || '');
  if (pw.length < 6 || pw.length > 100) return fail(400, 'bad_password');
  const row = await env.DB.prepare('SELECT id, password_hash FROM users WHERE id = ?').bind(user.id).first(); if (!row) return fail(401, 'signed_out');
  if (row.password_hash && !preset) { const keys = ['e:' + String(user.email).toLowerCase()]; if (await isLocked(env, keys)) return fail(429, 'too_many'); if (!(await pwVerify(cur, row.password_hash))) { await noteFail(env, keys); return fail(403, 'wrong_current'); } }
  const g = await env.DB.prepare("SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = 'google'").bind(user.id).first();
  await env.DB.prepare("UPDATE users SET password_hash = ?, auth_provider = ?, email_verified = CASE WHEN ? THEN 1 ELSE email_verified END WHERE id = ?").bind(await pwHash(pw), g ? 'hybrid' : 'email', g ? 1 : 0, user.id).run();
  log('password_set', {});
  return json({ ok: true, user: pubUser(user, true) });
}
function logout() { return json({ ok: true }, 200, { 'Set-Cookie': cookie('den_session', '', { maxAge: 0 }) }); }

/* ---------- 5. sync routes (D1 = index, R2 = the data itself) ---------- */
const STORES = new Set(['photos', 'templates', 'layouts', 'welcome']);
const ID_RE = /^[A-Za-z0-9._~-]{1,100}$/;
const limits = (env) => ({ user: num(env.MAX_USER_BYTES, 1024 * 1024 * 1024), object: num(env.MAX_OBJECT_BYTES, 80 * 1024 * 1024) });
const rkey = (uid, store, id) => `u/${uid}/${store}/${id}`;

async function syncManifest(env, user) {
  const rows = await env.DB.prepare('SELECT store, id, ts, size FROM records WHERE user_id = ?').bind(user.id).all(), list = rows.results || [];
  /* the stored-bytes counter can drift (an upload that stopped half way, an old version): re-count it from the index so a wrong number never blocks uploads with a false "storage full" */
  try { const lst = await env.FILES.list({ prefix: `u/${user.id}/tmp/`, limit: 100 }); const old = (lst.objects || []).filter((o) => now() - new Date(o.uploaded).getTime() > 3600 * 1000).map((o) => o.key); if (old.length) await env.FILES.delete(old); } catch (e) { /* leftovers of abandoned uploads are cleaned up next time */ }
  const real = list.reduce((n, r) => n + (Number(r.size) || 0), 0); let bytes = user.bytes || 0;
  if (real !== bytes) { bytes = real; try { await env.DB.prepare('UPDATE users SET bytes = ? WHERE id = ?').bind(real, user.id).run(); } catch (e) { log('bytes_fix_failed', { message: String(e && e.message) }); } }
  return json({ ok: true, records: list, count: list.length, settingsTs: user.settings_ts || 0, bytes, quota: limits(env).user });
}
/* stores one finished record (used by both the single-request upload and the chunked one) */
async function commitRecord(env, user, store, id, buf, ts) {
  const L = limits(env);
  if (buf.byteLength > L.object || !buf.byteLength) return fail(413, 'too_big');
  const prev = await env.DB.prepare('SELECT size FROM records WHERE user_id = ? AND store = ? AND id = ?').bind(user.id, store, id).first();
  const grow = buf.byteLength - ((prev && prev.size) || 0);
  if ((user.bytes || 0) + grow > L.user) return fail(507, 'quota');
  await env.FILES.put(rkey(user.id, store, id), buf, { httpMetadata: { contentType: 'application/octet-stream' } });
  try { await env.DB.batch([
    env.DB.prepare('INSERT INTO records (user_id, store, id, ts, size) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, store, id) DO UPDATE SET ts = excluded.ts, size = excluded.size').bind(user.id, store, id, ts, buf.byteLength),
    env.DB.prepare('UPDATE users SET bytes = MAX(0, bytes + ?) WHERE id = ?').bind(grow, user.id)]); }
  catch (e) { log('sync_put_index_failed', { store, message: String(e && e.message) }); if (!prev) { try { await env.FILES.delete(rkey(user.id, store, id)); } catch (e2) { /* nothing to undo */ } } return fail(500, 'server_error'); }   // the app retries this one automatically
  return json({ ok: true, ts, size: buf.byteLength });
}
async function syncPut(req, env, user, store, id, url) {
  if (!STORES.has(store) || !ID_RE.test(id)) return fail(400, 'bad_id');
  const L = limits(env), declared = Number(req.headers.get('Content-Length') || 0);
  if (declared > L.object) return fail(413, 'too_big');
  const buf = await req.arrayBuffer();
  return commitRecord(env, user, store, id, buf, Math.floor(num(url.searchParams.get('ts'), now())));
}
/* Chunked upload for big records on weak mobile connections: the app sends the record in small parts (u = upload id, i = part number, n = number of parts).
   Parts wait in temporary storage; the last part assembles them and stores the record. Re-sending a part is harmless, so a dropped connection only repeats that one small part. */
const UP_RE = /^[a-z0-9]{8,40}$/;
async function syncChunk(req, env, user, store, id, url) {
  if (!STORES.has(store) || !ID_RE.test(id)) return fail(400, 'bad_id');
  const u = url.searchParams.get('u') || '', i = parseInt(url.searchParams.get('i'), 10), n = parseInt(url.searchParams.get('n'), 10), L = limits(env);
  if (!UP_RE.test(u) || !(n >= 1 && n <= 200) || !(i >= 0 && i < n)) return fail(400, 'bad_chunk');
  const part = await req.arrayBuffer(); if (!part.byteLength || part.byteLength > 8 * 1024 * 1024) return fail(413, 'too_big');
  const tk = (k) => `u/${user.id}/tmp/${u}/${k}`;
  if (i < n - 1) { await env.FILES.put(tk(i), part); return json({ ok: true, part: i }); }
  const parts = [], total = [];
  let size = part.byteLength;
  for (let k = 0; k < n - 1; k++) { const o = await env.FILES.get(tk(k)); if (!o) return fail(409, 'missing_part'); const ab = await o.arrayBuffer(); size += ab.byteLength; if (size > L.object) return fail(413, 'too_big'); parts.push(ab); }
  const out = new Uint8Array(size); let pos = 0; for (const ab of parts) { out.set(new Uint8Array(ab), pos); pos += ab.byteLength; } out.set(new Uint8Array(part), pos);
  const res = await commitRecord(env, user, store, id, out.buffer, Math.floor(num(url.searchParams.get('ts'), now())));
  for (let k = 0; k < n - 1; k++) { try { await env.FILES.delete(tk(k)); } catch (e) { /* cleaned up later */ } }
  return res;
}
async function syncGet(env, user, store, id) {
  if (!STORES.has(store) || !ID_RE.test(id)) return fail(400, 'bad_id');
  const o = await env.FILES.get(rkey(user.id, store, id)); if (!o) return fail(404, 'not_found');
  return new Response(o.body, { headers: { 'Content-Type': 'application/octet-stream', ...NO_STORE } });
}
async function syncDelete(env, user, store, id) {
  if (!STORES.has(store) || !ID_RE.test(id)) return fail(400, 'bad_id');
  const prev = await env.DB.prepare('SELECT size FROM records WHERE user_id = ? AND store = ? AND id = ?').bind(user.id, store, id).first();
  await env.FILES.delete(rkey(user.id, store, id));
  await env.DB.batch([env.DB.prepare('DELETE FROM records WHERE user_id = ? AND store = ? AND id = ?').bind(user.id, store, id), env.DB.prepare('UPDATE users SET bytes = MAX(0, bytes - ?) WHERE id = ?').bind((prev && prev.size) || 0, user.id)]);
  return json({ ok: true });
}
async function settingsGet(env, user) {
  const o = await env.FILES.get(`u/${user.id}/settings.json`); if (!o) return json({ ok: true, ts: 0, data: null });
  return json({ ok: true, ts: user.settings_ts || 0, data: JSON.parse(await o.text()) });
}
async function settingsPut(req, env, user) {
  const text = await req.text(); if (text.length > 6 * 1024 * 1024) return fail(413, 'too_big');
  let data; try { data = JSON.parse(text); } catch (e) { return fail(400, 'bad_json'); }
  const ts = now();
  await env.FILES.put(`u/${user.id}/settings.json`, JSON.stringify(data), { httpMetadata: { contentType: 'application/json' } });
  await env.DB.prepare('UPDATE users SET settings_ts = ? WHERE id = ?').bind(ts, user.id).run();
  return json({ ok: true, ts });
}
async function deleteAccount(env, user) {                        // "Delete my cloud data": removes everything stored for this account
  let cursor; do { const l = await env.FILES.list({ prefix: `u/${user.id}/`, cursor }); for (const o of l.objects) await env.FILES.delete(o.key); cursor = l.truncated ? l.cursor : null; } while (cursor);
  await env.DB.batch([env.DB.prepare('DELETE FROM records WHERE user_id = ?').bind(user.id), env.DB.prepare('DELETE FROM identities WHERE user_id = ?').bind(user.id), env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id)]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie('den_session', '', { maxAge: 0 }) });
}

/* ---------- 6. diagnostics: open  /api/health?check=1  to see exactly what is set up and what is missing (never shows secrets) ---------- */
async function diagnose(env, url) {
  const c = cfg(env), checks = [], add = (name, ok, hint) => checks.push({ name, ok: !!ok, hint: ok ? '' : hint });
  add('Database binding "DB"', !!env.DB, 'Pages project > Settings > Bindings > add a D1 binding named DB.');
  add('Storage binding "FILES"', !!env.FILES, 'Pages project > Settings > Bindings > add an R2 binding named FILES.');
  add('SESSION_SECRET', c.secret.length >= 32, 'Add a Secret called SESSION_SECRET with at least 32 random characters.');
  add('GOOGLE_CLIENT_ID', /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(c.gid), 'Must look like 123456-abc.apps.googleusercontent.com (copy it again from Google Cloud > Credentials).');
  add('GOOGLE_CLIENT_SECRET', c.gsec.length >= 20, 'Add a Secret called GOOGLE_CLIENT_SECRET (usually starts with GOCSPX-).');
  add('No hidden spaces in the secrets', clean(env.GOOGLE_CLIENT_SECRET) === String(env.GOOGLE_CLIENT_SECRET || '') && clean(env.GOOGLE_CLIENT_ID) === String(env.GOOGLE_CLIENT_ID || ''), 'The values had spaces or quotes. They are ignored automatically, but re-paste them cleanly.');
  if (env.DB) { try { await ensureSchema(env); const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('users','identities','records')").first(); add('Database tables (users, identities, records)', r && r.n === 3, 'Tables could not be created. Make sure the D1 binding points to your den-db database.'); } catch (e) { add('Database tables (users, identities, records)', false, 'Database error: ' + String(e && e.message).slice(0, 120)); } }
  if (env.DB) add('Database columns are complete', schemaProblems.length === 0, 'These columns are missing and could not be added: ' + schemaProblems.join(', ') + '. In D1 Console run: DROP TABLE users; DROP TABLE identities; DROP TABLE records; (safe if nobody has synced yet), then retry.');
  if (env.FILES) { try { await env.FILES.head('health-check'); add('Storage reachable', true); } catch (e) { add('Storage reachable', false, 'R2 bucket could not be read: ' + String(e && e.message).slice(0, 120)); } }
  return { ok: checks.every((x) => x.ok), checks, googleClientId: c.gid || null, addThisRedirectUriInGoogleCloud: redirectUri(url.origin), addThisJavaScriptOriginInGoogleCloud: url.origin };
}


/* ---------- 6b. Long-distance booth: signalling only. The video, voice and chat go straight between the two devices (WebRTC);
   this just passes the "hello, here is how to reach me" notes. It never reads or writes the login cookie or any account. ---------- */
const BOOTH = { ttlMs: 8 * 3600e3, seenMs: 25e3, maxBody: 24000, perHour: 30, alphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' };
const boothCode = () => { const r = rand(6); return [...r].map((v) => BOOTH.alphabet[v % BOOTH.alphabet.length]).join(''); };
const boothNorm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
async function boothLimit(env, k, max, win) {                  // true = over the limit; counts this call
  const t = now(), r = await env.DB.prepare('SELECT n, ts FROM auth_throttle WHERE k = ?').bind(k).first();
  if (r && t - r.ts < win && r.n >= max) return true;
  await env.DB.prepare('INSERT INTO auth_throttle (k, n, ts) VALUES (?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN ? - ts > ? THEN 1 ELSE n + 1 END, ts = CASE WHEN ? - ts > ? THEN ? ELSE ts END').bind(k, t, t, win, t, win, t).run();
  return false;
}
async function boothSweep(env) { const old = now() - BOOTH.ttlMs; try { await env.DB.batch([env.DB.prepare('DELETE FROM booth_msgs WHERE ts < ?').bind(old), env.DB.prepare('DELETE FROM booth_rooms WHERE created < ?').bind(old)]); } catch (e) { /* tidy-up only */ } }
async function boothRoute(req, env, url, path) {
  if (!sameSiteOk(req, url)) return fail(403, 'forbidden');
  const t = now();
  if (path === '/api/booth/create' && req.method === 'POST') {
    if (await boothLimit(env, 'b:' + (netOf(req) || '?'), BOOTH.perHour, 3600e3)) return fail(429, 'too_many');
    if (Math.random() < 0.1) await boothSweep(env);
    for (let i = 0; i < 6; i++) {
      const code = boothCode(), tok = hex(rand(16));
      try { await env.DB.prepare('INSERT INTO booth_rooms (code, host_tok, guest_tok, created, host_seen, guest_seen) VALUES (?, ?, NULL, ?, ?, 0)').bind(code, tok, t, t).run(); return json({ ok: true, code, token: tok, role: 'host' }); }
      catch (e) { /* code already used: try another */ }
    }
    return fail(500, 'no_code');
  }
  let body = {}; if (req.method === 'POST') { try { body = await req.json(); } catch (e) { return fail(400, 'bad_json'); } }
  const code = boothNorm(body.code || url.searchParams.get('code')); if (code.length < 4) return fail(400, 'bad_code');
  const room = await env.DB.prepare('SELECT * FROM booth_rooms WHERE code = ?').bind(code).first();
  if (!room || t - room.created > BOOTH.ttlMs) return fail(404, 'no_room');
  if (path === '/api/booth/join' && req.method === 'POST') {
    if (await boothLimit(env, 'j:' + (netOf(req) || '?'), 120, 3600e3)) return fail(429, 'too_many');
    const tok = String(body.token || '');
    if (tok && tok === room.guest_tok) return json({ ok: true, code, token: tok, role: 'guest' });          // coming back after a reload
    if (tok && tok === room.host_tok) return json({ ok: true, code, token: tok, role: 'host' });
    if (room.guest_tok && t - (room.guest_seen || 0) < BOOTH.seenMs * 2) return fail(409, 'full');
    const g = hex(rand(16));
    await env.DB.batch([env.DB.prepare('UPDATE booth_rooms SET guest_tok = ?, guest_seen = ? WHERE code = ?').bind(g, t, code), env.DB.prepare('DELETE FROM booth_msgs WHERE code = ?').bind(code)]);
    return json({ ok: true, code, token: g, role: 'guest' });
  }
  const tok = String(body.token || url.searchParams.get('token') || ''), role = tok && tok === room.host_tok ? 'host' : tok && tok === room.guest_tok ? 'guest' : '';
  if (!role) return fail(403, 'bad_token');
  const other = role === 'host' ? 'guest' : 'host';
  if (path === '/api/booth/send' && req.method === 'POST') {
    const msg = typeof body.msg === 'string' ? body.msg : JSON.stringify(body.msg || ''); if (!msg || msg.length > BOOTH.maxBody) return fail(400, 'bad_msg');
    await env.DB.prepare('INSERT INTO booth_msgs (code, to_role, body, ts) VALUES (?, ?, ?, ?)').bind(code, other, msg, t).run();
    return json({ ok: true });
  }
  if (path === '/api/booth/poll' && req.method === 'GET') {
    const after = Math.max(0, parseInt(url.searchParams.get('after'), 10) || 0);
    const rows = (await env.DB.prepare('SELECT id, body FROM booth_msgs WHERE code = ? AND to_role = ? AND id > ? ORDER BY id LIMIT 50').bind(code, role, after).all()).results || [];
    const mine = role === 'host' ? room.host_seen : room.guest_seen, theirs = role === 'host' ? room.guest_seen : room.host_seen;
    if (!mine || t - mine > BOOTH.seenMs / 2) await env.DB.prepare(`UPDATE booth_rooms SET ${role}_seen = ? WHERE code = ?`).bind(t, code).run();   // a write only every ~12 s
    return json({ ok: true, msgs: rows, peer: !!theirs && t - theirs < BOOTH.seenMs * 2, peerJoined: role === 'host' ? !!room.guest_tok : true });
  }
  if (path === '/api/booth/leave' && req.method === 'POST') {
    if (role === 'guest') await env.DB.prepare('UPDATE booth_rooms SET guest_tok = NULL, guest_seen = 0 WHERE code = ?').bind(code).run();
    else await env.DB.batch([env.DB.prepare('DELETE FROM booth_rooms WHERE code = ?').bind(code), env.DB.prepare('DELETE FROM booth_msgs WHERE code = ?').bind(code)]);
    return json({ ok: true });
  }
  return fail(404, 'not_found');
}


/* ---------- 6c. Guest share links (the QR on the final page): kept for 24 hours, independent of the booth screen ----------
   The session's strip / photos / live GIF are uploaded to R2 (share/<token>/...) and indexed in D1 (tables shares + share_files, created by
   themselves the first time they are needed, in their OWN step so they can never affect sign-in). expires_at = created + 24 h.
   Past that time the viewer shows "expired" and a tidy-up deletes the R2 files. This never reads or writes the login cookie, never touches
   users / records (the saved Photo Archive) and never needs an account: the secret write key below is what protects an upload. ---------- */
const SHARE = { ttlMs: 86400e3, perHour: 300, maxFile: 40 * 1024 * 1024, maxTotal: 150 * 1024 * 1024, maxFiles: 60, tombMs: 30 * 86400e3,
  kinds: new Set(['preview', 'strip-web', 'strip', 'photo', 'live']), types: new Set(['image/jpeg', 'image/png', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']) };
let shareReady = null;
const ensureShareSchema = (env) => (shareReady = shareReady || env.DB.batch([
  env.DB.prepare('CREATE TABLE IF NOT EXISTS shares (token TEXT PRIMARY KEY, wkey TEXT, event TEXT, meta TEXT, created INTEGER, expires_at INTEGER, done INTEGER DEFAULT 0, bytes INTEGER DEFAULT 0, purged INTEGER DEFAULT 0)'),
  env.DB.prepare('CREATE TABLE IF NOT EXISTS share_files (token TEXT NOT NULL, kind TEXT NOT NULL, idx INTEGER NOT NULL, name TEXT, type TEXT, size INTEGER, seq INTEGER, PRIMARY KEY (token, kind, idx))'),
  env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_shares_exp ON shares (expires_at)')]).catch((e) => { shareReady = null; throw e; }));
const shareObj = (t, kind, i) => `share/${t}/${kind}.${i}`;
async function shareSweep(env) {                       // deletes ONLY expired guest-share files; the row stays (as a tiny "expired" marker) for 30 days, then goes too
  const t = now();
  try {
    const rows = (await env.DB.prepare('SELECT token FROM shares WHERE expires_at < ? AND purged = 0 LIMIT 20').bind(t).all()).results || [];
    for (const r of rows) {
      const fs = (await env.DB.prepare('SELECT kind, idx FROM share_files WHERE token = ?').bind(r.token).all()).results || [];
      if (fs.length) await env.FILES.delete(fs.map((f) => shareObj(r.token, f.kind, f.idx)));
      await env.DB.batch([env.DB.prepare('DELETE FROM share_files WHERE token = ?').bind(r.token), env.DB.prepare("UPDATE shares SET purged = 1, meta = '', bytes = 0 WHERE token = ?").bind(r.token)]);
    }
    await env.DB.prepare('DELETE FROM shares WHERE expires_at < ?').bind(t - SHARE.tombMs).run();
  } catch (e) { log('share_sweep_failed', { message: String(e && e.message) }); }
}
const shareMeta = (b) => {                              // only plain numbers / flags are kept from what the booth sends
  const m = b && typeof b.meta === 'object' && b.meta ? b.meta : {}, pars = Array.isArray(m.pars) ? m.pars.slice(0, 40).map((v) => Math.round((Number(v) || 1.3) * 1e4) / 1e4) : [];
  return { photos: Math.max(0, Math.min(40, parseInt(m.photos, 10) || 0)), live: !!m.live, ar: Math.round((Number(m.ar) || 0) * 1e4) / 1e4, pars, files: Math.max(0, Math.min(SHARE.maxFiles, parseInt(m.files, 10) || 0)) };
};
async function shareRoute(req, env, url, path) {
  try {
    await ensureShareSchema(env);
    const t = now();
    if (path === '/api/share/create' && req.method === 'POST') {
      if (!sameSiteOk(req, url)) return fail(403, 'forbidden');
      if (await boothLimit(env, 'sc:' + (netOf(req) || '?'), SHARE.perHour, 3600e3)) return fail(429, 'too_many');
      let body = {}; try { body = await req.json(); } catch (e) { return fail(400, 'bad_json'); }
      if (Math.random() < 0.1) await shareSweep(env);
      const id = hex(rand(16)), key = hex(rand(16)), exp = t + SHARE.ttlMs, ev = String((body && body.event) || '').slice(0, 80);
      await env.DB.prepare('INSERT INTO shares (token, wkey, event, meta, created, expires_at, done, bytes, purged) VALUES (?, ?, ?, ?, ?, ?, 0, 0, 0)').bind(id, key, ev, JSON.stringify(shareMeta(body)), t, exp).run();
      return json({ ok: true, token: 'den-v' + id, key, expires_at: exp, ttl: Math.round(SHARE.ttlMs / 1000) });
    }
    const m = /^\/api\/share\/den-v([0-9a-f]{32})(?:\/(done)|\/f\/([a-z-]{1,12})\/(\d{1,2}))?$/.exec(path); if (!m) return fail(404, 'not_found');
    const id = m[1], row = await env.DB.prepare('SELECT * FROM shares WHERE token = ?').bind(id).first();
    if (!row) return fail(404, 'no_share');
    const gone = t >= row.expires_at || !!row.purged;
    if (gone) { if (Math.random() < 0.05) await shareSweep(env); return fail(410, 'expired'); }                 // the clean "Link expired after 24 hours" case
    const keyOk = String(req.headers.get('X-Share-Key') || '') === row.wkey;
    if (m[3] === undefined && m[2] === undefined) {                                                             // GET /api/share/<token>: what is ready so far
      if (req.method !== 'GET') return fail(405, 'method');
      const files = ((await env.DB.prepare('SELECT kind, idx, name, type, size FROM share_files WHERE token = ? ORDER BY seq').bind(id).all()).results || []).map((f) => ({ kind: f.kind, i: f.idx, name: f.name, type: f.type, size: f.size }));
      let meta = {}; try { meta = JSON.parse(row.meta || '{}'); } catch (e) { /* empty */ }
      return json({ ok: true, event: row.event || '', meta, files, done: !!row.done, expires_at: row.expires_at, now: t });
    }
    if (m[2] === 'done') {
      if (req.method !== 'POST') return fail(405, 'method'); if (!sameSiteOk(req, url)) return fail(403, 'forbidden'); if (!keyOk) return fail(403, 'bad_key');
      await env.DB.prepare('UPDATE shares SET done = 1 WHERE token = ?').bind(id).run(); return json({ ok: true });
    }
    const kind = m[3], idx = parseInt(m[4], 10);
    if (!SHARE.kinds.has(kind) || idx > 39) return fail(400, 'bad_file');
    if (req.method === 'GET') {                                                                                  // a guest downloading one of the files
      const o = await env.FILES.get(shareObj(id, kind, idx)); if (!o) return fail(404, 'not_found');
      const f = await env.DB.prepare('SELECT name, type FROM share_files WHERE token = ? AND kind = ? AND idx = ?').bind(id, kind, idx).first();
      return new Response(o.body, { headers: { 'Content-Type': (f && f.type) || 'application/octet-stream', 'Cache-Control': 'private, max-age=600', 'Content-Disposition': `inline; filename="${(f && f.name) || kind}"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    if (req.method !== 'PUT') return fail(405, 'method'); if (!sameSiteOk(req, url)) return fail(403, 'forbidden'); if (!keyOk) return fail(403, 'bad_key');
    const type = String(req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase(); if (!SHARE.types.has(type)) return fail(415, 'bad_type');
    if (Number(req.headers.get('Content-Length') || 0) > SHARE.maxFile) return fail(413, 'too_big');
    const buf = await req.arrayBuffer(); if (!buf.byteLength) return fail(400, 'empty'); if (buf.byteLength > SHARE.maxFile) return fail(413, 'too_big');
    const cur = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM share_files WHERE token = ? AND NOT (kind = ? AND idx = ?)').bind(id, kind, idx).first();
    if ((cur.n || 0) + buf.byteLength > SHARE.maxTotal || (cur.c || 0) >= SHARE.maxFiles) return fail(413, 'too_big');
    let name = String(req.headers.get('X-Share-Name') || ''); if (!/^[A-Za-z0-9._-]{1,60}$/.test(name)) name = `${kind}-${idx}`;
    await env.FILES.put(shareObj(id, kind, idx), buf, { httpMetadata: { contentType: type } });
    await env.DB.batch([
      env.DB.prepare('INSERT INTO share_files (token, kind, idx, name, type, size, seq) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM share_files WHERE token = ?)) ON CONFLICT(token, kind, idx) DO UPDATE SET name = excluded.name, type = excluded.type, size = excluded.size').bind(id, kind, idx, name, type, buf.byteLength, id),
      env.DB.prepare('UPDATE shares SET bytes = (SELECT COALESCE(SUM(size), 0) FROM share_files WHERE token = ?) WHERE token = ?').bind(id, id)]);
    return json({ ok: true });
  } catch (e) { shareReady = null; log('share_error', { path, message: String(e && e.message) }); return fail(500, 'server_error'); }
}

/* ---------- 6d. Owner access (Part 1) ----------
   The owner is ONE verified person: densprem02@gmail.com signed in through Google (the account must have a Google identity AND a verified email).
   Everything under /api/owner/ answers 404 to anybody else, so the panel is invisible to every other user and to signed-out visitors.
   - /api/owner/me      { owner: true, signing: true|false }
   - /api/owner/visits  names, emails and visit times of signed-in people. NEVER photos, archives or any stored file.
   - /api/owner/sign    makes a Den+ key, a password reset code or an account recovery link with the SAME formats and the SAME private key your key maker uses.
                        The private key lives only in the Cloudflare secret DEN_SIGN_JWK (never in the website or the browser).
   Nothing here reads or writes a login cookie, a token, a session or the users table, so every existing login keeps working. ---------- */
const OWNER_EMAIL = 'densprem02@gmail.com';
const DEN_PUB = 'BDG-UjAPDeCTpPia6ZX6jsXpA032zmQSgG6ntOn8gQ3KSwGze25l-88qQq5-L9LDX5-iLGPe4ZXuYluKrNu2Xbg';   // same public key the website checks codes with
async function ownerOk(env, user) {
  try {
    if (!user || String(user.email || '').trim().toLowerCase() !== OWNER_EMAIL) return false;
    const r = await env.DB.prepare('SELECT email_verified FROM users WHERE id = ?').bind(user.id).first();
    if (!r || Number(r.email_verified) !== 1) return false;
    const g = await env.DB.prepare("SELECT 1 AS x FROM identities WHERE user_id = ? AND provider = 'google'").bind(user.id).first();
    return !!g;
  } catch (e) { return false; }
}
let visitsReady = null;
const ensureVisits = (env) => (visitsReady = visitsReady || env.DB.prepare('CREATE TABLE IF NOT EXISTS den_visits (email TEXT PRIMARY KEY, name TEXT, first_ts INTEGER, last_ts INTEGER, n INTEGER)').run().catch((e) => { visitsReady = null; throw e; }));
async function noteVisit(env, user) {                               // best effort, at most one write per person per 10 minutes, never blocks or changes a login
  try {
    const email = String(user.email || '').trim().toLowerCase(); if (!email || /@social\.den\.local$/.test(email)) return;
    await ensureVisits(env); const t = now();
    await env.DB.prepare('INSERT INTO den_visits (email, name, first_ts, last_ts, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT(email) DO UPDATE SET name = excluded.name, last_ts = excluded.last_ts, n = den_visits.n + 1 WHERE den_visits.last_ts < excluded.last_ts - 600000')
      .bind(email, String(user.name || '').slice(0, 60), t, t).run();
  } catch (e) { /* never affects the request */ }
}
async function signingKey(env) {
  const raw = clean(env.DEN_SIGN_JWK); if (!raw) return null;
  const alg = { name: 'ECDSA', namedCurve: 'P-256' };
  try {
    if (raw.startsWith('{')) return await crypto.subtle.importKey('jwk', JSON.parse(raw), alg, false, ['sign']);
    return await crypto.subtle.importKey('pkcs8', b64uDec(raw.replace(/\s+/g, '')), alg, false, ['sign']);
  } catch (e) { return null; }
}
async function signPayload(env, text) {                            // returns [payloadB64u, signatureB64u] or null; proves the key matches the website's public key
  const key = await signingKey(env); if (!key) return null;
  const bytes = enc.encode(text), sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bytes));
  const pub = await crypto.subtle.importKey('raw', b64uDec(DEN_PUB), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, bytes))) return 'mismatch';
  return [b64uEnc(bytes), b64uEnc(sig)];
}
async function ownerRoute(req, env, url, path, user) {
  if (!(await ownerOk(env, user))) return fail(404, 'not_found');   // identical answer for everyone who is not the owner
  if (req.method !== 'GET' && !sameSiteOk(req, url)) return fail(403, 'forbidden');
  if (path === '/api/owner/me' && req.method === 'GET') return json({ ok: true, owner: true, signing: !!(await signingKey(env)) });
  if (path === '/api/owner/visits' && req.method === 'GET') {
    try { await ensureVisits(env); const r = await env.DB.prepare('SELECT email, name, first_ts, last_ts, n FROM den_visits ORDER BY last_ts DESC LIMIT 300').all(); return json({ ok: true, visits: (r.results || []).map((v) => ({ email: v.email, name: v.name || '', first: v.first_ts, last: v.last_ts, n: v.n })) }); }
    catch (e) { return fail(500, 'visits_failed'); }
  }
  if (path === '/api/owner/sign' && req.method === 'POST') {
    const t = await req.text(); if (t.length > 1800000) return fail(413, 'too_large');
    let b; try { b = JSON.parse(t); } catch (e) { return fail(400, 'bad_request'); } if (!b || typeof b !== 'object') return fail(400, 'bad_request');
    const email = String(b.email || '').normalize('NFKC').trim().toLowerCase(), kind = String(b.kind || '');
    if (!EMAIL_RE.test(email) || email.length > 254 || /[|\s]/.test(email)) return fail(400, 'bad_email');
    if (!(await signingKey(env))) return fail(503, 'signing_not_set');
    let out;
    if (kind === 'plus') {                                                     // DENPLUS.<v1|email|YYYY-MM-DD|days>.<sig>
      const days = Math.max(1, Math.min(365, Math.round(Number(b.days)) || 31)), d = new Date().toISOString().slice(0, 10);
      const sg = await signPayload(env, ['v1', email, d, days].join('|')); if (sg === 'mismatch') return fail(500, 'wrong_key'); out = { code: 'DENPLUS.' + sg[0] + '.' + sg[1], days };
    } else if (kind === 'reset') {                                             // DENRESET.<r1|email|issuedMs|hours|nonce>.<sig>
      const hours = Math.max(1, Math.min(168, Math.round(Number(b.hours)) || 48));
      const sg = await signPayload(env, ['r1', email, now(), hours, hex(rand(8))].join('|')); if (sg === 'mismatch') return fail(500, 'wrong_key'); out = { code: 'DENRESET.' + sg[0] + '.' + sg[1], hours };
    } else if (kind === 'recovery') {                                          // DENBACKUP.<b1|email|issuedMs|hours|nonce|gz|sha256>.<sig>.<gzipped account bundle>  (account recovery link, no file needed)
      const hours = Math.max(1, Math.min(168, Math.round(Number(b.hours)) || 72)), days = Math.max(0, Math.min(365, Math.round(Number(b.days)) || 0)), rc = b.rec || {};
      const nm = String(rc.name || '').trim().slice(0, 40);                      // the password is hashed in the browser (PBKDF2 120000, the app's own rule); only the salt + hash arrive here
      if (!nm || !/^[A-Za-z0-9+/]{22,24}={0,2}$/.test(String(rc.salt || '')) || !/^[A-Za-z0-9+/]{42,44}={0,2}$/.test(String(rc.hash || ''))) return fail(400, 'bad_login');
      const bundle = { den: 'account', v: 2, email, rec: { name: nm, salt: rc.salt, hash: rc.hash, created: now() }, data: { layouts: [], templates: [], photos: [] } };
      if (days > 0) { const kg = await signPayload(env, ['v1', email, new Date().toISOString().slice(0, 10), days].join('|')); if (kg === 'mismatch') return fail(500, 'wrong_key'); bundle.key = 'DENPLUS.' + kg[0] + '.' + kg[1]; }
      const gz = new Uint8Array(await new Response(new Blob([enc.encode(JSON.stringify(bundle))]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      const sha = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', gz))), issued = now();
      const sg = await signPayload(env, ['b1', email, issued, hours, b64uEnc(rand(9)), 'gz', sha].join('|')); if (sg === 'mismatch') return fail(500, 'wrong_key');
      const code = 'DENBACKUP.' + sg[0] + '.' + sg[1] + '.' + b64uEnc(gz); out = { code, link: url.origin + '/#restore=' + code, hours, days, exp: issued + hours * 36e5 };
    } else return fail(400, 'bad_kind');
    log('owner_sign', { kind }); return json({ ok: true, ...out });
  }
  return fail(404, 'not_found');
}

/* ---------- 7. router ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/+$/, '');
    if (!path.startsWith('/api/')) return env.ASSETS ? env.ASSETS.fetch(req) : new Response('Not found', { status: 404 });   // everything that is not /api is the normal website
    try {
      const c = cfg(env), storage = !!(env.DB && env.FILES && c.secret);
      if (path === '/api/health') { if (url.searchParams.get('check')) return json(await diagnose(env, url)); return json({ ok: true, storage, providers: { google: storage && googleReady(env) } }); }
      if (path === '/api/auth/google/start') return req.method === 'GET' ? authStart(req, env, url) : fail(405, 'method');
      if (path === '/api/auth/google/callback') return req.method === 'GET' ? authCallback(req, env, url) : fail(405, 'method');
      if (!storage) return fail(503, 'not_configured');
      await ensureSchema(env);
      if (path === '/api/auth/logout' && req.method === 'POST') return sameSiteOk(req, url) ? logout() : fail(403, 'forbidden');
      if ((path === '/api/auth/register' || path === '/api/auth/login') && req.method === 'POST') {
        if (!sameSiteOk(req, url)) return fail(403, 'forbidden');
        return path === '/api/auth/login' ? authLogin(req, env) : authRegister(req, env, await currentUser(req, env));
      }
      if (path.startsWith('/api/booth/')) return boothRoute(req, env, url, path);   // before the login lookup on purpose: guests need no account, and this never touches a session
      if (path.startsWith('/api/share/')) return shareRoute(req, env, url, path);   // guest QR links: before the login lookup on purpose (guests need no account; this never touches a session)
      const user = await currentUser(req, env);
      if (path.startsWith('/api/owner/')) return ownerRoute(req, env, url, path, user);   // 404 for everyone except the verified owner
      if (path === '/api/me' && req.method === 'GET' && user) await noteVisit(env, user);   // names + emails + times only, for the owner's "Who visited"
      if (path === '/api/me' && req.method === 'GET' && user && user.sessExp && user.sessExp - Math.floor(now() / 1000) < (SESSION_DAYS - 1) * 86400) {   // sliding session: re-issue the same login with a fresh full lifetime (at most about once a day)
        const fresh = await signToken(env, { u: user.id, e: user.sessEpoch }, SESSION_DAYS * 86400);
        return json({ ok: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '', hasPassword: !!user.password_hash }, bytes: user.bytes || 0 }, 200, { 'Set-Cookie': cookie('den_session', fresh, { maxAge: SESSION_DAYS * 86400 }) });
      }
      if (path === '/api/me' && req.method === 'GET') return user ? json({ ok: true, user: { id: user.id, email: user.email, name: user.name, picture: user.picture || '', hasPassword: !!user.password_hash }, bytes: user.bytes || 0 }) : fail(401, 'signed_out');
      if (!user) return fail(401, 'signed_out');
      if (req.method !== 'GET' && !sameSiteOk(req, url)) return fail(403, 'forbidden');
      if (path === '/api/auth/password' && req.method === 'POST') return authSetPassword(req, env, user);
      if (path === '/api/me' && req.method === 'DELETE') return deleteAccount(env, user);
      if (path === '/api/sync/manifest' && req.method === 'GET') return syncManifest(env, user);
      if (path === '/api/sync/settings') return req.method === 'GET' ? settingsGet(env, user) : req.method === 'PUT' ? settingsPut(req, env, user) : fail(405, 'method');
      const ck = /^\/api\/sync\/chunk\/([a-z]+)\/([^/]+)$/.exec(path);
      if (ck) return req.method === 'PUT' ? syncChunk(req, env, user, ck[1], decodeURIComponent(ck[2]), url) : fail(405, 'method');
      const m = /^\/api\/sync\/rec\/([a-z]+)\/([^/]+)$/.exec(path);
      if (m) { const id = decodeURIComponent(m[2]); return req.method === 'PUT' ? syncPut(req, env, user, m[1], id, url) : req.method === 'GET' ? syncGet(env, user, m[1], id) : req.method === 'DELETE' ? syncDelete(env, user, m[1], id) : fail(405, 'method'); }
      return fail(404, 'not_found');
    } catch (e) { if (/no such table|no column named|no such column|has no column/i.test(String(e && e.message))) schemaReady = null; log('server_error', { path, message: String(e && e.message) }); return fail(500, 'server_error'); }   // never leaks details; the booth keeps working offline either way
  },
};
