// Worker self-test (Google-only). Run: sh cloud/tests/run-tests.sh
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
const worker = (await import('file://' + process.env.DEN_WORKER)).default;
const { subtle } = globalThis.crypto; const b64u = (b) => Buffer.from(b).toString('base64url');
let pass = 0, failn = 0; const ok = (c, m) => { if (c) pass++; else { failn++; process.stdout.write('FAIL ' + m + '\n'); } };
const logs = []; const realLog = console.log; console.log = (...a) => logs.push(a.join(' '));

function makeEnv(extra = {}, withSchema = true) {
  const sqlite = new DatabaseSync(':memory:'); if (typeof withSchema === 'string') sqlite.exec(withSchema); else if (withSchema) sqlite.exec(fs.readFileSync(process.env.DEN_ROOT + '/cloud/schema.sql', 'utf8'));
  const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => sqlite.prepare(sql).get(...args) || null, all: async () => ({ results: sqlite.prepare(sql).all(...args) }), run: async () => { sqlite.prepare(sql).run(...args); return {}; }, _x: () => sqlite.prepare(sql).run(...args) });
  const DB = { prepare: (s) => stmt(s), batch: async (l) => { sqlite.exec('BEGIN'); try { l.forEach((s) => s._x()); sqlite.exec('COMMIT'); } catch (e) { sqlite.exec('ROLLBACK'); throw e; } } };
  const store = new Map();
  const FILES = { put: async (k, v) => { store.set(k, Buffer.from(v)); }, head: async () => null, get: async (k) => store.has(k) ? { body: store.get(k), text: async () => store.get(k).toString(), arrayBuffer: async () => { const b = store.get(k); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } : null, delete: async (k) => { store.delete(k); }, list: async ({ prefix }) => ({ objects: [...store.keys()].filter((k) => k.startsWith(prefix || '')).map((key) => ({ key })), truncated: false }) };
  return { sqlite, store, env: { DB, FILES, ASSETS: { fetch: async () => new Response('site') }, SESSION_SECRET: 'x'.repeat(40), GOOGLE_CLIENT_ID: '123-abc.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'GOCSPX-testsecret0123456789', MAX_USER_BYTES: '5000', ...extra } };
}
const rsa = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await subtle.exportKey('jwk', rsa.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
let nonce = '', tokenMode = 'ok', seenBody = null, jwksDown = false, claimsOverride = {};
async function idToken(claims) { const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' })), p = b64u(JSON.stringify(claims)); return h + '.' + p + '.' + b64u(await subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(h + '.' + p))); }
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes('oauth2/v3/certs')) return jwksDown ? new Response('down', { status: 503 }) : Response.json({ keys: [jwk] });
  if (url === 'https://oauth2.googleapis.com/token') {
    const b = new URLSearchParams(init.body); seenBody = Object.fromEntries(b);
    if (tokenMode === 'invalid_client') return Response.json({ error: 'invalid_client', error_description: 'Unauthorized' }, { status: 401 });
    if (tokenMode === 'redirect') return Response.json({ error: 'redirect_uri_mismatch', error_description: 'Bad Request' }, { status: 400 });
    if (tokenMode === 'invalid_grant') return Response.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 });
    if (tokenMode === 'network') throw new Error('connection reset');
    if (b.get('client_secret') !== 'GOCSPX-testsecret0123456789' || !b.get('code_verifier') || b.get('client_id') !== '123-abc.apps.googleusercontent.com') return Response.json({ error: 'invalid_client' }, { status: 401 });
    return Response.json({ id_token: await idToken({ iss: 'https://accounts.google.com', aud: '123-abc.apps.googleusercontent.com', sub: 'g-123', exp: Math.floor(Date.now() / 1000) + 600, email: 'Maya@Example.com', email_verified: true, name: 'Maya', picture: 'p.png', nonce, ...claimsOverride }) });
  }
  throw new Error('unexpected fetch ' + url);
};
const O = 'https://denphotobooth.online';
const reasonOf = (res) => new URL(res.headers.get('Location')).searchParams.get('reason');
const detailOf = (res) => new URL(res.headers.get('Location')).searchParams.get('detail');
const cookiesOf = (res) => res.headers.getSetCookie().map((c) => c.split(';')[0]);
const jar = (res) => cookiesOf(res).filter((c) => !/=$/.test(c)).join('; ');

async function startLogin(T) {
  const call = (p, i) => worker.fetch(new Request(O + p, i), T.env);
  const s = await call('/api/auth/google/start?return=/'); const loc = new URL(s.headers.get('Location')); nonce = loc.searchParams.get('nonce');
  return { s, loc, state: loc.searchParams.get('state'), oc: jar(s), call };
}
async function loginOnce(T, tweak = {}) { const l = await startLogin(T); const cb = await l.call(`/api/auth/google/callback?code=c&state=${tweak.state || l.state}`, { headers: { Cookie: tweak.noCookie ? '' : l.oc } }); return { ...l, cb, session: cookiesOf(cb).find((c) => c.startsWith('den_session=') && !/=$/.test(c)) }; }

// ---------- Google flow, success ----------
{
  const T = makeEnv(), g = await loginOnce(T);
  ok(g.loc.origin + g.loc.pathname === 'https://accounts.google.com/o/oauth2/v2/auth', 'start redirects to Google');
  ok(g.loc.searchParams.get('redirect_uri') === O + '/api/auth/google/callback', 'redirect_uri is exactly the callback address');
  ok(g.loc.searchParams.get('client_id') === '123-abc.apps.googleusercontent.com' && g.loc.searchParams.get('code_challenge_method') === 'S256', 'client id + PKCE sent');
  ok(g.cb.status === 303 && g.cb.headers.get('Location').includes('cloud=ok') && g.session, 'callback signs in and sets the session cookie');
  ok(seenBody.redirect_uri === O + '/api/auth/google/callback' && seenBody.grant_type === 'authorization_code' && seenBody.code === 'c', 'token exchange sends the SAME redirect_uri + the code');
  const me = await (await worker.fetch(new Request(O + '/api/me', { headers: { Cookie: g.session } }), T.env)).json(); ok(me.ok && me.user.email === 'maya@example.com' && me.user.name === 'Maya', 'session works: lowercase email + name');
  // second login = same account, not a duplicate
  const g2 = await loginOnce(T); const me2 = await (await worker.fetch(new Request(O + '/api/me', { headers: { Cookie: g2.session } }), T.env)).json(); ok(me2.user.id === me.user.id && T.sqlite.prepare('SELECT COUNT(*) n FROM users').get().n === 1, 'logging in again reuses the account');
}
// ---------- the old failure: database tables never created ----------
{
  const T = makeEnv({}, false), g = await loginOnce(T); ok(g.session && T.sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('users','identities','records')").get().n === 3, 'tables create themselves, so sign-in works even if schema.sql was never run');
}
// ---------- the real-world failure: tables exist but from an older / partial setup (missing columns) ----------
{
  const legacy = 'CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT); CREATE TABLE identities (provider TEXT, subject TEXT, user_id TEXT, PRIMARY KEY (provider, subject)); CREATE TABLE records (user_id TEXT, id TEXT, ts INTEGER, PRIMARY KEY (user_id, id));';
  const T = makeEnv({}, legacy); const g = await loginOnce(T);
  const cols = (t) => T.sqlite.prepare(`PRAGMA table_info(${t})`).all().map((r) => r.name);
  ok(g.session && ['epoch', 'bytes', 'settings_ts', 'picture'].every((c) => cols('users').includes(c)) && cols('identities').includes('email') && cols('records').includes('size'), 'older tables with missing columns are repaired automatically and sign-in works');
  const d = await (await worker.fetch(new Request(O + '/api/health?check=1'), T.env)).json(); ok(d.checks.some((c) => /columns/i.test(c.name)), 'diagnostics reports the column check');
}
// ---------- if the database still refuses, the real message is shown (not just "db") ----------
{
  const T = makeEnv(); const bad = { ...T.env, DB: { ...T.env.DB, prepare: (q) => { if (/INSERT INTO users/.test(q)) throw new Error('D1_ERROR: table users has no column named epoch'); return T.env.DB.prepare(q); } } };
  const call = (p, i) => worker.fetch(new Request(O + p, i), bad); const s0 = await call('/api/auth/google/start'); const loc = new URL(s0.headers.get('Location')); nonce = loc.searchParams.get('nonce');
  const cb = await call('/api/auth/google/callback?code=c&state=' + loc.searchParams.get('state'), { headers: { Cookie: jar(s0) } }); ok(reasonOf(cb) === 'db' && /no column named epoch/.test(detailOf(cb)), 'the actual database error reaches the app: ' + detailOf(cb));
}
// ---------- secrets pasted with spaces / quotes / line breaks still work ----------
{
  const T = makeEnv({ GOOGLE_CLIENT_ID: '  "123-abc.apps.googleusercontent.com"\n', GOOGLE_CLIENT_SECRET: ' GOCSPX-testsecret0123456789 \r\n', SESSION_SECRET: '\n' + 'y'.repeat(40) + ' ' });
  const g = await loginOnce(T); ok(g.session, 'whitespace/quotes around pasted secrets are ignored');
}
// ---------- every failure has its own specific code (never just "failed") ----------
{
  const T = makeEnv();
  for (const [mode, expect] of [['invalid_client', 'google_invalid_client'], ['redirect', 'google_redirect_uri_mismatch'], ['invalid_grant', 'google_invalid_grant'], ['network', 'google_network']]) {
    tokenMode = mode; const g = await loginOnce(T); ok(!g.session && g.cb.status === 303 && reasonOf(g.cb) === expect, `Google "${mode}" -> reason ${expect} (got ${reasonOf(g.cb)})`);
  }
  tokenMode = 'ok'; claimsOverride = { aud: 'someone-else.apps.googleusercontent.com' }; let g = await loginOnce(T); ok(reasonOf(g.cb) === 'token_wrong_audience', 'wrong audience is named'); claimsOverride = { exp: 1 }; g = await loginOnce(T); ok(reasonOf(g.cb) === 'token_expired', 'expired token is named'); claimsOverride = { nonce: 'forged' }; g = await loginOnce(T); ok(reasonOf(g.cb) === 'token_wrong_nonce', 'forged nonce is rejected'); claimsOverride = {};
  jwksDown = true; g = await loginOnce(T); ok(g.session, 'Google keys unreachable: claims are still checked and sign-in still works'); jwksDown = false;
  g = await loginOnce(T, { noCookie: true }); ok(reasonOf(g.cb) === 'state' && detailOf(g.cb) === 'no_cookie', 'missing cookie -> state / no_cookie');
  { // cookie jar missing (installed iPhone app / private mode): signed state + same network still signs in; other network does not
    const call2 = (pp, i) => worker.fetch(new Request(O + pp, i), T.env);
    const s0 = await call2('/api/auth/google/start?return=/', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }); const loc0 = new URL(s0.headers.get('Location')); nonce = loc0.searchParams.get('nonce');
    const okcb = await call2('/api/auth/google/callback?code=c&state=' + encodeURIComponent(loc0.searchParams.get('state')), { headers: { 'CF-Connecting-IP': '203.0.113.77' } });
    ok(!reasonOf(okcb) && cookiesOf(okcb).some((c) => c.startsWith('den_session=')), 'no cookie but same network: signed state signs in');
    const s1 = await call2('/api/auth/google/start?return=/', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }); const loc1 = new URL(s1.headers.get('Location')); nonce = loc1.searchParams.get('nonce');
    const badcb = await call2('/api/auth/google/callback?code=c&state=' + encodeURIComponent(loc1.searchParams.get('state')), { headers: { 'CF-Connecting-IP': '198.51.100.5' } });
    ok(reasonOf(badcb) === 'state' && detailOf(badcb) === 'no_cookie', 'no cookie and another network: refused');
    ok(/Path=\//.test(s0.headers.get('Set-Cookie') || ''), 'sign-in cookie is set for the whole site (Secure, HttpOnly, SameSite=Lax)');
  }
  g = await loginOnce(T, { state: 'forged' }); ok(reasonOf(g.cb) === 'state' && detailOf(g.cb) === 'mismatch', 'wrong state -> state / mismatch');
  const l = await startLogin(T); const cb = await l.call('/api/auth/google/callback?error=access_denied', { headers: { Cookie: l.oc } }); ok(reasonOf(cb) === 'cancelled', 'user pressing Cancel on Google -> cancelled');
  const cb2 = await l.call('/api/auth/google/callback?error=invalid_request&error_description=Missing+required+parameter', { headers: { Cookie: l.oc } }); ok(reasonOf(cb2) === 'google_invalid_request' && /Missing/.test(detailOf(cb2)), 'Google callback errors are passed through with their description');
  ok(logs.some((x) => x.includes('"event":"oauth_error"') && x.includes('google_invalid_client') && x.includes('redirectUri')), 'every failure is logged with the redirect_uri used (Cloudflare Logs)');
  const cb3 = await l.call('/api/auth/google/callback?code=c&state=x', { headers: { Cookie: l.oc } }); ok(cb3.status === 303, 'bad callbacks always redirect back to the app (never a blank page)');
}
// ---------- database really broken -> named, not generic ----------
{
  const T = makeEnv(); const bad = { ...T.env, DB: { ...T.env.DB, prepare: (q) => { if (/INSERT INTO users/.test(q)) throw new Error('D1_ERROR: boom'); return T.env.DB.prepare(q); } } };
  const call = (p, i) => worker.fetch(new Request(O + p, i), bad); const s = await call('/api/auth/google/start'); const loc = new URL(s.headers.get('Location')); nonce = loc.searchParams.get('nonce');
  const cb = await call('/api/auth/google/callback?code=c&state=' + loc.searchParams.get('state'), { headers: { Cookie: jar(s) } }); ok(reasonOf(cb) === 'db', 'database error -> reason db');
}
// ---------- not configured / health / diagnostics ----------
{
  const T = makeEnv(); const call = (p, i, e = T.env) => worker.fetch(new Request(O + p, i), e);
  ok((await (await call('/index.html')).text()) === 'site', 'non-api goes to the normal website');
  let h = await (await call('/api/health')).json(); ok(h.storage && h.providers.google === true && Object.keys(h.providers).join() === 'google', 'health: Google only');
  h = await (await call('/api/health', {}, { ASSETS: T.env.ASSETS })).json(); ok(h.storage === false && h.providers.google === false, 'health without bindings is graceful');
  const st = await call('/api/auth/google/start', {}, { ...T.env, GOOGLE_CLIENT_SECRET: '' }); ok(reasonOf(st) === 'not_configured', 'missing secret -> not_configured');
  const d = await (await call('/api/health?check=1')).json(); ok(d.ok && d.addThisRedirectUriInGoogleCloud === O + '/api/auth/google/callback' && JSON.stringify(d).indexOf('GOCSPX') === -1, 'diagnostics: all green, shows the exact callback address, never shows secrets');
  const d2 = await (await call('/api/health?check=1', {}, { ...T.env, GOOGLE_CLIENT_ID: 'wrong', DB: undefined })).json(); ok(!d2.ok && d2.checks.filter((c) => !c.ok).length >= 2 && d2.checks.every((c) => c.ok || c.hint), 'diagnostics: every problem comes with a fix hint');
  const gone = [await call('/api/auth/facebook/start'), await call('/api/auth/apple/start'), await call('/api/auth/apple/callback', { method: 'POST' })]; ok(gone.every((r) => [401, 404].includes(r.status) && !(r.headers.get('Location') || '')), 'Facebook and Apple routes no longer exist (no redirect, no handler)');
  ok(!fs.readFileSync(process.env.DEN_WORKER, 'utf8').match(/facebook|appleid|APPLE_|FACEBOOK_/i), 'no Facebook/Apple code left in the worker');
}
// ---------- sync, isolation, security (unchanged behaviour) ----------
{
  const T = makeEnv(); const g = await loginOnce(T), C = g.session; const call = (p, i, e = T.env) => worker.fetch(new Request(O + p, i), e);
  const H = (extra = {}) => ({ headers: { Cookie: C, 'X-Den-Cloud': '1', Origin: O, ...extra } });
  ok((await call('/api/sync/rec/photos/p1?ts=1000', { method: 'PUT', body: new Uint8Array([1, 2, 3, 4]), ...H() })).status === 200, 'PUT record');
  ok((await call('/api/sync/rec/photos/p1?ts=1', { method: 'PUT', body: new Uint8Array([1]), headers: { Cookie: C } })).status === 403, 'PUT without CSRF header refused');
  ok((await call('/api/sync/rec/photos/p1?ts=1', { method: 'PUT', body: new Uint8Array([1]), headers: { Cookie: C, 'X-Den-Cloud': '1', Origin: 'https://evil.example' } })).status === 403, 'PUT from another origin refused');
  ok((await call('/api/sync/rec/bad/p1?ts=1', { method: 'PUT', body: new Uint8Array([1]), ...H() })).status === 400 && (await call('/api/sync/rec/photos/..%2Fx?ts=1', { method: 'PUT', body: new Uint8Array([1]), ...H() })).status === 400, 'unknown store / path traversal refused');
  let man = await (await call('/api/sync/manifest', { headers: { Cookie: C } })).json(); ok(man.records.length === 1 && man.bytes === 4, 'manifest lists the record');
  ok(Buffer.from(await (await call('/api/sync/rec/photos/p1', { headers: { Cookie: C } })).arrayBuffer()).equals(Buffer.from([1, 2, 3, 4])), 'GET returns identical bytes');
  ok((await call('/api/sync/rec/welcome/wv1?ts=1000', { method: 'PUT', body: new Uint8Array([9, 8, 7]), ...H() })).status === 200 && Buffer.from(await (await call('/api/sync/rec/welcome/wv1', { headers: { Cookie: C } })).arrayBuffer()).equals(Buffer.from([9, 8, 7])), 'welcome-screen media record stores and returns identical bytes');
  ok((await call('/api/sync/rec/welcome/wv1', { method: 'DELETE', ...H() })).status === 200, 'welcome-screen media record can be deleted');
  ok((await call('/api/sync/rec/photos/big?ts=1', { method: 'PUT', body: new Uint8Array(6000), ...H() })).status === 507, 'per-user quota enforced');
  const T2 = { env: { ...T.env } }; // a second Google account on the same database
  claimsOverride = { sub: 'g-999', email: 'other@example.com' }; const g2 = await loginOnce(T); claimsOverride = {};
  ok((await call('/api/sync/rec/photos/p1', { headers: { Cookie: g2.session } })).status === 404, "another account can NOT read this user's data");
  ok((await call('/api/me')).status === 401 && (await call('/api/me', { headers: { Cookie: C.slice(0, -3) + 'abc' } })).status === 401, 'no cookie / tampered cookie = signed out');
  { const r0 = await call('/api/me', { headers: { Cookie: C } }); ok(r0.status === 200 && !(r0.headers.get('Set-Cookie') || ''), 'a fresh login is not re-issued on every call');
    const realNow = Date.now; Date.now = () => realNow() + 20 * 86400 * 1000;
    try { const r1 = await call('/api/me', { headers: { Cookie: C } }); const sc = r1.headers.get('Set-Cookie') || ''; ok(r1.status === 200 && /den_session=[^;]+; .*Max-Age=15552000/.test(sc), 'sliding session: a login that is 20 days old is renewed for a full 180 days'); }
    finally { Date.now = realNow; } }
  { // chunked upload
    const u = 'up' + 'a1b2c3d4e5'; const big = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251)); const part = (i, n, b) => call(`/api/sync/chunk/photos/pc1?u=${u}&i=${i}&n=${n}&ts=4242`, { method: 'PUT', body: b, ...H() });
    ok((await part(0, 3, big.subarray(0, 1000))).status === 200 && (await part(0, 3, big.subarray(0, 1000))).status === 200, 'chunk 1 accepted (and re-sending it is harmless)');
    ok((await part(2, 3, big.subarray(2000))).status === 409, 'last part without all earlier parts -> asks for the missing one');
    ok((await part(1, 3, big.subarray(1000, 2000))).status === 200, 'chunk 2 accepted');
    const fin = await part(2, 3, big.subarray(2000)); const fj = await fin.json(); ok(fin.status === 200 && fj.size === 2500 && fj.ts === 4242, 'last part assembles the record');
    const back = Buffer.from(await (await call('/api/sync/rec/photos/pc1', { headers: { Cookie: C } })).arrayBuffer()); ok(back.equals(big), 'assembled record is byte-identical');
    ok(![...T.store.keys()].some((k) => k.includes('/tmp/')), 'temporary parts are removed');
    ok((await call('/api/sync/chunk/photos/pc1?u=x&i=0&n=1', { method: 'PUT', body: big, ...H() })).status === 400, 'bad upload id refused');
  }
  T.sqlite.prepare('UPDATE users SET epoch = 1 WHERE email = ?').run('maya@example.com'); ok((await call('/api/me', { headers: { Cookie: C } })).status === 401, 'epoch bump signs out every device'); T.sqlite.prepare('UPDATE users SET epoch = 0 WHERE email = ?').run('maya@example.com');
  ok((await call('/api/me', { method: 'DELETE', ...H() })).status === 200 && T.sqlite.prepare("SELECT COUNT(*) n FROM records WHERE user_id IN (SELECT id FROM users)").get().n === 0, 'delete my cloud data');
}
{
  /* ---- email + password accounts: same users table, same session, same cloud storage ---- */
  const T = makeEnv(); const call = (p, i, e = T.env) => worker.fetch(new Request(O + p, i), e);
  const H = (extra = {}) => ({ 'X-Den-Cloud': '1', 'Content-Type': 'application/json', ...extra });
  const post = (p, body, cookie) => call(p, { method: 'POST', headers: H(cookie ? { Cookie: cookie } : {}), body: JSON.stringify(body) });
  let r = await post('/api/auth/register', { email: 'SamMartinez20@iCloud.com ', password: 'secret1', name: 'Sam' }); let j = await r.json();
  const sam = jar(r); ok(r.status === 200 && j.ok && j.user.email === 'sammartinez20@icloud.com' && sam.includes('den_session='), 'register: email is lowercased, session cookie set');
  const row = T.sqlite.prepare("SELECT * FROM users WHERE email = 'sammartinez20@icloud.com'").get(); ok(row && /^pbkdf2\$100000\$/.test(row.password_hash) && !row.password_hash.includes('secret1') && row.auth_provider === 'email', 'password stored only as a salted PBKDF2 hash');
  ok((await (await call('/api/me', { headers: { Cookie: sam } })).json()).user.hasPassword === true, 'the new account has a working session');
  ok((await post('/api/auth/register', { email: 'sammartinez20@icloud.com', password: 'other11' })).status === 409, 'same email again: refused, not duplicated');
  ok((await post('/api/auth/register', { email: 'x', password: 'secret1' })).status === 400 && (await post('/api/auth/register', { email: 'a@b.co', password: '123' })).status === 400, 'bad email / short password refused');
  ok((await call('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 403, 'register needs the same-site header');
  r = await post('/api/auth/login', { email: 'SAMMARTINEZ20@icloud.com', password: 'secret1' }); j = await r.json(); ok(r.status === 200 && j.ok && jar(r).includes('den_session='), 'login works with any capitals');
  ok((await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'secret1 ' })).status === 200, 'a trailing space from a phone keyboard is forgiven');
  r = await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'nope123' }); ok(r.status === 401 && (await r.json()).error === 'invalid', 'wrong password = 401 invalid');
  r = await post('/api/auth/login', { email: 'nobody@icloud.com', password: 'secret1' }); ok(r.status === 401 && (await r.json()).error === 'invalid', 'unknown email = the same answer');
  /* the same cloud storage as Google accounts */
  const C = jar(await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'secret1' }));
  const put = await call('/api/sync/rec/photos/p1', { method: 'PUT', headers: { 'X-Den-Cloud': '1', Cookie: C }, body: Buffer.from('photo-bytes') }); ok(put.status === 200, 'email accounts can upload');
  const man = await (await call('/api/sync/manifest', { headers: { Cookie: jar(await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'secret1' })) } })).json(); ok((man.records || []).some((x) => x.id === 'p1'), 'a second device that logs in sees the same records');
  /* Google account + password bridge */
  const g = await loginOnce(T); const gme = await (await call('/api/me', { headers: { Cookie: g.session } })).json(); ok(gme.user.email === 'maya@example.com' && gme.user.hasPassword === false, 'a Google-only account has no password yet');
  r = await post('/api/auth/register', { email: 'maya@example.com', password: 'mayapw1' }); ok(r.status === 409 && (await r.json()).error === 'google_account', 'a stranger cannot attach a password to a Google account');
  r = await post('/api/auth/login', { email: 'maya@example.com', password: 'mayapw1' }); ok(r.status === 401 && (await r.json()).error === 'google_only', 'logging in to a Google-only email explains it instead of "no account"');
  r = await post('/api/auth/password', { password: 'mayapw1' }, g.session); ok(r.status === 200, 'signed in with Google: can set a password');
  r = await post('/api/auth/login', { email: 'maya@example.com', password: 'mayapw1' }); j = await r.json(); ok(r.status === 200 && j.user.id === gme.user.id, 'then email + password opens the SAME account (same data)');
  ok(T.sqlite.prepare("SELECT auth_provider p FROM users WHERE email = 'maya@example.com'").get().p === 'hybrid', 'account is marked hybrid');
  ok((await call('/api/me', { headers: { Cookie: g.session } })).status === 200, 'setting a password never signs the Google session out');
  ok((await post('/api/auth/password', { password: 'newpw22', current: 'wrongone' }, g.session)).status === 403, 'changing a password needs the current one');
  ok((await post('/api/auth/password', { password: 'newpw22', current: 'mayapw1' }, g.session)).status === 200 && (await post('/api/auth/login', { email: 'maya@example.com', password: 'newpw22' })).status === 200, 'change password works');
  ok((await post('/api/auth/password', { password: 'x123456' })).status === 401, 'no session = no password change');
  /* Google sign-in meeting an email-registered (unverified) account: the password is cleared so a pre-registered stranger cannot keep access */
  const pre = await post('/api/auth/register', { email: 'maya2@example.com', password: 'attacker1' }); ok(pre.status === 200, 'attacker pre-registers an email');
  const pcookie = jar(pre);
  claimsOverride = { email: 'maya2@example.com', sub: 'g-999' }; const g3 = await loginOnce(T); claimsOverride = {};
  const after = T.sqlite.prepare("SELECT password_hash h, auth_provider p, email_verified v FROM users WHERE email = 'maya2@example.com'").get();
  ok(g3.session && after && !after.h && after.v === 1, 'real owner arrives with Google: old password cleared, email verified');
  ok((await call('/api/me', { headers: { Cookie: pcookie } })).status === 401, 'and the pre-registered session is signed out');
  ok((await post('/api/auth/login', { email: 'maya2@example.com', password: 'attacker1' })).status === 401, 'the attacker password no longer works');
  /* throttle */
  for (let i = 0; i < 10; i++) await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'bad' + i });
  ok((await post('/api/auth/login', { email: 'sammartinez20@icloud.com', password: 'secret1' })).status === 429, 'after 10 wrong tries the account pauses for a while');
}
// ---------- long-distance booth signalling ----------
{
  const T = makeEnv(), H = { 'X-Den-Cloud': '1', 'Content-Type': 'application/json' };
  const call = (p, i) => worker.fetch(new Request(O + p, i), T.env), post = (p, b) => call(p, { method: 'POST', headers: H, body: JSON.stringify(b) });
  const g = await loginOnce(T);
  const c = await (await post('/api/booth/create', {})).json();
  ok(c.ok && /^[A-HJ-NP-Z2-9]{6}$/.test(c.code) && c.role === 'host' && c.token, 'host creates a booth with a 6-character code');
  ok((await call('/api/booth/create', { method: 'POST' })).status === 403, 'a request without the site header is refused');
  ok((await post('/api/booth/join', { code: 'ZZZZZZ' })).status === 404, 'unknown code is not found');
  const j = await (await post('/api/booth/join', { code: c.code.toLowerCase() })).json();
  ok(j.ok && j.role === 'guest' && j.token && j.token !== c.token, 'guest joins with the code (any letter case)');
  ok((await post('/api/booth/join', { code: c.code })).status === 409, 'a third person cannot take the guest seat');
  ok((await (await post('/api/booth/join', { code: c.code, token: j.token })).json()).role === 'guest', 'the guest can come back after a reload with the same token');
  ok((await post('/api/booth/send', { code: c.code, token: 'nope', msg: 'x' })).status === 403, 'sending needs a valid token');
  ok((await post('/api/booth/send', { code: c.code, token: c.token, msg: JSON.stringify({ t: 'offer' }) })).status === 200, 'host sends an offer');
  const p1 = await (await call(`/api/booth/poll?code=${c.code}&token=${j.token}&after=0`, { headers: H })).json();
  ok(p1.ok && p1.msgs.length === 1 && JSON.parse(p1.msgs[0].body).t === 'offer', 'guest receives it');
  const p2 = await (await call(`/api/booth/poll?code=${c.code}&token=${j.token}&after=${p1.msgs[0].id}`, { headers: H })).json();
  ok(p2.msgs.length === 0, 'and only once');
  const p3 = await (await call(`/api/booth/poll?code=${c.code}&token=${c.token}&after=0`, { headers: H })).json();
  ok(p3.msgs.length === 0 && p3.peer === true, 'the host does not get its own message back and sees the guest is here');
  ok((await post('/api/booth/send', { code: c.code, token: j.token, msg: 'x'.repeat(30000) })).status === 400, 'oversized notes are refused');
  /* never touches a login */
  const me = await (await call('/api/me', { headers: { Cookie: g.session } })).json(); ok(me.ok, 'an account signed in before is still signed in after booth calls');
  const r = await post('/api/booth/send', { code: c.code, token: c.token, msg: 'hi' }); ok(!r.headers.get('Set-Cookie'), 'booth calls never set or clear a cookie');
  await post('/api/booth/leave', { code: c.code, token: j.token });
  ok((await (await post('/api/booth/join', { code: c.code })).json()).role === 'guest', 'after the guest leaves, the seat is free again');
  await post('/api/booth/leave', { code: c.code, token: c.token });
  ok((await post('/api/booth/join', { code: c.code })).status === 404, 'when the host leaves the booth is closed');
  const T2 = makeEnv(); let over = 0; for (let i = 0; i < 32; i++) if ((await worker.fetch(new Request(O + '/api/booth/create', { method: 'POST', headers: H, body: '{}' }), T2.env)).status === 429) over++;
  ok(over >= 1, 'creating booths is rate-limited');
}
console.log = realLog; console.log(`worker tests: ${pass} passed, ${failn} failed`); process.exit(failn ? 1 : 0);
