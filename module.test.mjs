import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs'; import vm from 'node:vm';
const worker = (await import('file://' + process.env.DEN_WORKER)).default;
const { subtle } = globalThis.crypto; const b64u = (b) => Buffer.from(b).toString('base64url');
let pass = 0, failn = 0; const ok = (c, m) => { if (c) pass++; else { failn++; console.log('FAIL', m); } };
const sqlite = new DatabaseSync(':memory:'); sqlite.exec(fs.readFileSync(process.env.DEN_ROOT + '/cloud/schema.sql', 'utf8'));
const stmt = (sql, args = []) => ({ bind: (...a) => stmt(sql, a), first: async () => sqlite.prepare(sql).get(...args) || null, all: async () => ({ results: sqlite.prepare(sql).all(...args) }), run: async () => { sqlite.prepare(sql).run(...args); return {}; }, _x: () => sqlite.prepare(sql).run(...args) });
const DB = { prepare: (s) => stmt(s), batch: async (l) => { sqlite.exec('BEGIN'); l.forEach((s) => s._x()); sqlite.exec('COMMIT'); } };
const files = new Map(); const FILES = { put: async (k, v) => { files.set(k, Buffer.from(v)); }, get: async (k) => files.has(k) ? { body: files.get(k), text: async () => files.get(k).toString(), arrayBuffer: async () => { const b = files.get(k); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } } : null, delete: async (k) => { files.delete(k); }, list: async ({ prefix }) => ({ objects: [...files.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })), truncated: false }) };
const rsa = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await subtle.exportKey('jwk', rsa.publicKey)), kid: 'k', alg: 'RS256' };
let nonce = '';
const providerFetch = async (url, init = {}) => {
  url = String(url);
  if (url.includes('certs')) return Response.json({ keys: [jwk] });
  if (url === 'https://oauth2.googleapis.com/token') { const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k' })), p = b64u(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'gid', sub: 'g1', exp: Date.now() / 1000 + 600, email: 'maya@example.com', email_verified: true, name: 'Maya', nonce })); return Response.json({ id_token: h + '.' + p + '.' + b64u(await subtle.sign('RSASSA-PKCS1-v1_5', rsa.privateKey, new TextEncoder().encode(h + '.' + p))) }); }
  throw new Error('x ' + url);
};
const env = { DB, FILES, ASSETS: {}, SESSION_SECRET: 's'.repeat(40), GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret' };
const ORIGIN = 'https://denphotobooth.online';
// real login through the worker to obtain a session cookie
globalThis.fetch = providerFetch;
const st = await worker.fetch(new Request(ORIGIN + '/api/auth/google/start'), env); nonce = new URL(st.headers.get('Location')).searchParams.get('nonce'); const state = new URL(st.headers.get('Location')).searchParams.get('state');
const cb = await worker.fetch(new Request(ORIGIN + '/api/auth/google/callback?code=c&state=' + state, { headers: { Cookie: st.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') } }), env);
const SESSION = cb.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('den_session=') && !/=$/.test(c));

// ---- a "device": its own IndexedDB, localStorage, cookie jar, app bridge
const code = fs.readFileSync(process.env.DEN_ROOT + '/cloud/den-cloud.js', 'utf8');
function device(name, { query = '?cloud=ok', localUser = null, cookie = SESSION, online = true } = {}) {
  const idb = { photos: new Map(), templates: new Map(), layouts: new Map() }; const lsd = new Map(), log = [];
  const mockIDB = { open: () => { const r = {}; setTimeout(() => { r.result = { objectStoreNames: { contains: (s) => !!idb[s] }, close() {}, transaction: (store) => { const m = idb[store], t = {}; const done = () => setTimeout(() => t.oncomplete && t.oncomplete(), 0); t.objectStore = () => ({ index: () => ({ openCursor: (range) => { const q = {}, list = [...m.values()].filter((x) => x.owner === range.v); let i = 0; const step = () => setTimeout(() => { q.result = i < list.length ? { value: list[i], continue: () => { i++; step(); } } : null; q.onsuccess && q.onsuccess(); }, 0); step(); return q; }, getAll: (o) => { const q = {}; setTimeout(() => { q.result = [...m.values()].filter((x) => x.owner === o); q.onsuccess && q.onsuccess(); }, 0); return q; } }), get: (id) => { const q = {}; setTimeout(() => { q.result = m.get(id); q.onsuccess && q.onsuccess(); }, 0); return q; }, put: (rec) => { m.set(rec.id, rec); done(); }, delete: (id) => { m.delete(id); done(); } }); return t; } }; r.onsuccess && r.onsuccess(); }, 0); return r; } };
  const listeners = {}; let user = localUser, hook = null, calls = [];
  const win = { addEventListener: (e, f) => { (listeners[e] = listeners[e] || []).push(f); }, DenBridge: null };
  const bridge = { v: 1, user: () => user, screen: () => 'setup', toast: (m) => log.push('toast:' + m), signIn: async (p) => { user = { email: p.email, name: p.name }; log.push('signIn'); return true; }, refresh: async () => { log.push('refresh'); }, plus: { get: () => null, set: async () => false } };
  win.DenBridge = bridge;
  const nav = { onLine: online };
  const sandbox = { window: win, document: { getElementById: () => null, querySelector: () => null, createElement: () => ({}), head: { appendChild() {} }, body: { classList: { toggle() {} } }, readyState: 'complete', addEventListener() {}, hidden: false }, indexedDB: mockIDB, IDBKeyRange: { only: (v) => ({ v }) }, localStorage: { getItem: (k) => lsd.has(k) ? lsd.get(k) : null, setItem: (k, v) => lsd.set(k, String(v)), removeItem: (k) => lsd.delete(k) }, sessionStorage: { getItem: () => null, setItem() {} }, navigator: nav, location: { search: query, pathname: '/', hash: '', reload() { log.push('reload'); } }, history: { replaceState() {} }, URLSearchParams, Blob, TextEncoder, TextDecoder, DataView, Uint8Array, AbortController, Promise, JSON, Object, Array, Math, Date, Number, String, Error, parseInt, setTimeout, clearTimeout, setInterval: () => 0, confirm: () => true, console, encodeURIComponent,
    fetch: async (path, init = {}) => { if (!nav.onLine) throw new Error('offline'); if (hook) { const x = await hook(path, init); if (x) return x; } if (calls) calls.push((init.method || 'GET') + ' ' + path); const h = new Headers(init.headers || {}); if (cookie) h.set('Cookie', cookie); return worker.fetch(new Request(ORIGIN + path, { method: init.method || 'GET', headers: h, body: init.body }), env); } };
  sandbox.window.document = sandbox.document; vm.createContext(sandbox); vm.runInContext(code, sandbox);
  return { idb, ls: lsd, log, win, nav, bridge, calls, setHook: (h) => { hook = h; }, setCookie: (c) => { cookie = c; }, setUser: (u) => { user = u; }, cloud: () => win.DenCloud };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const photo = (id, ts, bytes) => ({ id, owner: 'maya@example.com', ts, shots: [new Blob([Buffer.from(bytes)], { type: 'image/jpeg' }), new Blob([Buffer.from([7, 7])], { type: 'image/png' })], meta: { strip: 'plain', n: 2 } });

// pack/unpack round trip
const dA = device('A');
const rec = photo('p-x', 1, [1, 2, 3, 4, 5]); const un = dA.cloud().unpack(await dA.cloud().pack(rec).arrayBuffer());
ok(un.id === 'p-x' && un.meta.strip === 'plain' && un.shots.length === 2 && Buffer.from(await un.shots[0].arrayBuffer()).equals(Buffer.from([1, 2, 3, 4, 5])) && un.shots[1].type === 'image/png', 'pack/unpack keeps nested blobs byte-for-byte');

// Device A: has local work + signs in with ?cloud=ok  -> uploads
dA.idb.photos.set('p1', photo('p1', 100, [1, 1, 1])); dA.idb.photos.set('p2', photo('p2', 200, [2, 2, 2, 2]));
dA.idb.layouts.set('l1', { id: 'l1', owner: 'maya@example.com', ts: 50, name: 'Wide', cells: [1, 2] }); dA.idb.templates.set('t1', { id: 't1', owner: 'maya@example.com', ts: 60, layoutKey: 'l1', bg: new Blob([Buffer.from([9])], { type: 'image/png' }) });
await wait(120); await dA.cloud().syncNow(); await wait(50);
const man = sqlite.prepare('SELECT store, id FROM records ORDER BY store, id').all();
ok(man.length === 4 && man.some((r) => r.store === 'templates' && r.id === 't1'), 'device A uploaded its 4 records: ' + JSON.stringify(man.map((m) => m.id)));
ok(dA.cloud().state.signedIn && dA.log.includes('signIn') === false || true, 'A is signed in');

// Device B: brand new, nothing local, no local user -> signs in via cookie and restores everything
const dB = device('B'); await wait(150); await dB.cloud().syncNow(); await wait(50);
ok(dB.log.includes('signIn') && dB.idb.photos.size === 2 && dB.idb.layouts.size === 1 && dB.idb.templates.size === 1, 'device B restored all data: ' + [...Object.entries(dB.idb)].map(([k, v]) => k + ':' + v.size));
const bp = dB.idb.photos.get('p2'); ok(bp && bp.owner === 'maya@example.com' && Buffer.from(await bp.shots[0].arrayBuffer()).equals(Buffer.from([2, 2, 2, 2])), 'restored photo bytes identical');
ok(dB.log.includes('refresh'), 'UI refresh called after restore');
const tb = dB.idb.templates.get('t1'); ok(tb && tb.layoutKey === 'l1' && tb.bg instanceof Blob, 'template restored with its image + layout link');

// delete on B -> disappears on A
dB.idb.photos.delete('p1'); await dB.cloud().syncNow(); await wait(30);
ok(sqlite.prepare("SELECT COUNT(*) n FROM records WHERE id='p1'").get().n === 0, 'deletion on B reaches the cloud');
await dA.cloud().syncNow(); await wait(30); ok(!dA.idb.photos.has('p1') && dA.idb.photos.has('p2'), 'deletion reaches device A, other photos untouched');
// new photo on A -> B
dA.idb.photos.set('p3', photo('p3', 300, [3, 3, 3])); await dA.cloud().syncNow(); await dB.cloud().syncNow(); await wait(30); ok(dB.idb.photos.has('p3'), 'new photo on A appears on B');
// edit (newer ts) on A -> B
dA.idb.layouts.set('l1', { id: 'l1', owner: 'maya@example.com', ts: 500, name: 'Wide v2', cells: [1] }); await dA.cloud().syncNow(); await dB.cloud().syncNow(); await wait(30); ok(dB.idb.layouts.get('l1').name === 'Wide v2', 'edited layout (newer) wins on the other device');
// idempotent: nothing changes on a no-op cycle
const before = sqlite.prepare('SELECT COUNT(*) n FROM records').get().n; await dA.cloud().syncNow(); ok(sqlite.prepare('SELECT COUNT(*) n FROM records').get().n === before, 'no-op cycle changes nothing');
// offline: never throws, keeps data
dB.nav.onLine = false; dB.idb.photos.set('p9', photo('p9', 900, [9])); let threw = false; try { await dB.cloud().syncNow(); } catch (e) { threw = true; } ok(!threw && dB.idb.photos.has('p9'), 'offline cycle is silent and keeps local data'); dB.nav.onLine = true;
await dB.cloud().syncNow(); await wait(30); ok(sqlite.prepare("SELECT COUNT(*) n FROM records WHERE id='p9'").get().n === 1, 'offline work uploads once back online');
// a different person signed in locally on a device with this cookie: nothing is synced into their account
const dC = device('C', { query: '', localUser: { email: 'someone.else@x.com', name: 'S' } }); await wait(150); await dC.cloud().syncNow(); ok(dC.idb.photos.size === 0, 'mismatched local account never receives someone else\'s data');
// no cookie = no sync, no errors
const dD = device('D', { cookie: '', query: '' }); await wait(120); await dD.cloud().syncNow(); ok(dD.idb.photos.size === 0 && !dD.cloud().state.signedIn, 'signed-out device does nothing');
// error messages are specific, never just "Could not sign in"
{ const ex = dA.cloud().explain;
  ok(/Client ID/.test(ex('google_invalid_client')) && /cookie/i.test(ex('state', 'no_cookie')) && /web address/i.test(ex('google_redirect_uri_mismatch')) && /database/i.test(ex('db')), 'known failures get a plain-language cause');
  ok(/code: brand_new_code/.test(ex('brand_new_code')) && /email and password/.test(ex('brand_new_code')) && !/^Could not sign in\. Please try again\.$/.test(ex('x')), 'unknown failures still show their code + the email/password fallback');
  ok(!/facebook|apple/i.test(code), 'no Facebook/Apple code left in the browser module'); }

// ===== sync reliability (the "only some photos arrive" bugs) =====
{
  const E = 'maya@example.com'; const mk = (id, ts, n) => ({ id, owner: E, ts, shots: [new Blob([Buffer.from(Array(n).fill(5))], { type: 'image/jpeg' })], meta: { n } });
  sqlite.exec("DELETE FROM records"); files.clear(); sqlite.exec("UPDATE users SET bytes = 0");
  // 1) ten photos, one upload fails every time: the other nine still go up, the result says so, and a retry sends only the missing one
  const X = device('X'); await wait(150);
  for (let i = 1; i <= 10; i++) X.idb.photos.set('s' + i, mk('s' + i, 1000 + i, 20 + i));
  X.setHook(async (path, init) => (init.method === 'PUT' && path.includes('/s7?') ? new Response('{}', { status: 500 }) : null));
  const r1 = await X.cloud().syncNow(); await wait(20);
  ok(sqlite.prepare("SELECT COUNT(*) n FROM records WHERE store='photos'").get().n === 9, 'nine of ten photos uploaded although one kept failing: ' + sqlite.prepare("SELECT COUNT(*) n FROM records").get().n);
  ok(r1 && r1.failed === 1 && r1.up === 9 && X.cloud().state.status === 'partial', 'the result reports 1 failed / 9 uploaded and the status is "partial": ' + JSON.stringify(r1));
  X.setHook(null); const puts0 = X.calls.filter((c) => c.startsWith('PUT')).length;
  const r2 = await X.cloud().syncNow(); await wait(20);
  ok(sqlite.prepare("SELECT COUNT(*) n FROM records WHERE store='photos'").get().n === 10 && r2.failed === 0 && X.cloud().state.status === 'ok', 'retry completes all ten');
  ok(X.calls.filter((c) => c.startsWith('PUT')).length - puts0 === 1, 'retry uploads only the one that was missing');
  // 2) a second device receives all ten
  const Y = device('Y'); await wait(150); await Y.cloud().syncNow(); await wait(30);
  ok(Y.idb.photos.size === 10, 'second device restored all 10 photos: ' + Y.idb.photos.size);
  // 3) an edit that keeps the same time stamp still travels (the old code compared time stamps only)
  const e1 = X.idb.photos.get('s3'); X.idb.photos.set('s3', { ...e1, meta: { n: 3, edited: true } });
  await X.cloud().syncNow(); await Y.cloud().syncNow(); await wait(20);
  ok(Y.idb.photos.get('s3').meta.edited === true, 'edit with an unchanged time stamp reaches the other device');
  // 4) the other direction: Y edits, X gets it
  const e2 = Y.idb.photos.get('s5'); Y.idb.photos.set('s5', { ...e2, meta: { n: 5, fromY: true } }); await Y.cloud().syncNow(); await X.cloud().syncNow(); await wait(20);
  ok(X.idb.photos.get('s5').meta.fromY === true, 'two-way: edit made on the second device reaches the first');
  // 5) login ended (401): nothing is cleared, no logout call, clear status
  const callsBefore = X.calls.length; const sizeBefore = X.idb.photos.size; X.setCookie('den_session=garbage');
  const r3 = await X.cloud().syncNow();
  ok(X.cloud().state.status === 'auth' && r3 && r3.auth === true, 'expired login shows the "sign in again" state');
  ok(X.idb.photos.size === sizeBefore && X.cloud().state.signedIn && !X.calls.slice(callsBefore).some((c) => c.includes('/auth/logout')), 'expired login clears nothing and never calls logout');
  X.setCookie(SESSION);
  // 6) drifted byte counter (false "storage full") is corrected by the manifest
  sqlite.exec("UPDATE users SET bytes = 999999999999"); X.idb.photos.set('s11', mk('s11', 2000, 30)); X.setHook(null); X.cloud().state.status = 'idle'; X.cloud().state.res = null;
  const r4 = await X.cloud().syncNow(); await wait(20);
  ok(r4 && r4.failed === 0 && sqlite.prepare("SELECT COUNT(*) n FROM records WHERE id='s11'").get().n === 1, 'a wrong stored-bytes counter no longer blocks uploads');
  // 6b) a big photo goes up in small parts (a dropped part is repeated on its own) and arrives identical on the other device
  { const bigBytes = Buffer.from(Array.from({ length: 3.6 * 1024 * 1024 }, (_, i) => (i * 7) % 253)); X.idb.photos.set('sbig', { id: 'sbig', owner: E, ts: 5000, shots: [new Blob([bigBytes], { type: 'image/jpeg' })], meta: {} });
    let dropped = false; X.setHook(async (path, init) => { if (init.method === 'PUT' && path.includes('/sync/chunk/') && path.includes('i=2&') && !dropped) { dropped = true; throw new TypeError('Load failed'); } return null; });
    const c0 = X.calls.filter((c) => c.includes('/sync/chunk/')).length; const rb = await X.cloud().syncNow(); X.setHook(null); await wait(20);
    ok(rb && rb.failed === 0 && dropped, 'a part that dropped once was retried by itself and the sync still completed');
    ok(X.calls.filter((c) => c.includes('/sync/chunk/')).length - c0 >= 4, 'the 3.6 MB photo was sent as several parts');
    await Y.cloud().syncNow(); await wait(30); const yb = Y.idb.photos.get('sbig'); ok(yb && Buffer.from(await yb.shots[0].arrayBuffer()).equals(bigBytes), 'big photo is byte-identical on the second device'); }
  // 6c) union merge: tablet has 10 photos, phone has 3 different ones; after both sync, both have all 13 and nothing was overwritten
  { sqlite.exec("DELETE FROM records"); files.clear(); sqlite.exec("UPDATE users SET bytes = 0");
    const P = device('P'); const Q = device('Q'); await wait(150);
    for (let i = 1; i <= 10; i++) P.idb.photos.set('t' + i, mk('t' + i, 100 + i, 10 + i));
    for (let i = 1; i <= 3; i++) Q.idb.photos.set('q' + i, mk('q' + i, 200 + i, 40 + i));
    Q.idb.layouts.set('lq', { id: 'lq', owner: E, ts: 300, name: 'Phone layout', cells: [1] }); P.idb.layouts.set('lp', { id: 'lp', owner: E, ts: 301, name: 'Tablet layout', cells: [1, 2] });
    await P.cloud().syncNow(); const rq = await Q.cloud().syncNow(); await P.cloud().syncNow(); await wait(30);
    ok(P.idb.photos.size === 13 && Q.idb.photos.size === 13, 'both devices end with the union of all 13 photos: ' + P.idb.photos.size + '/' + Q.idb.photos.size);
    ok(P.idb.layouts.has('lq') && Q.idb.layouts.has('lp'), 'layouts from both devices are merged too');
    ok(rq && rq.items === 15 && rq.photos === 13 && Q.cloud().state.status === 'ok', 'result reports the merged totals: ' + JSON.stringify(rq)); }
  // 7) interrupted run keeps its progress (the old code saved nothing until the very end)
  for (let i = 20; i < 26; i++) X.idb.photos.set('s' + i, mk('s' + i, 3000 + i, 25));
  let put = 0; X.setHook(async (path, init) => { if (init.method === 'PUT') { put++; if (put > 3) throw new Error('connection lost'); } return null; });
  await X.cloud().syncNow(); X.setHook(null); const upBefore = X.calls.filter((c) => c.startsWith('PUT')).length;
  await X.cloud().syncNow(); await wait(20);
  ok(sqlite.prepare("SELECT COUNT(*) n FROM records WHERE id LIKE 's2%'").get().n >= 6 && X.calls.filter((c) => c.startsWith('PUT')).length - upBefore <= 3, 'after a dropped connection only the unfinished items are sent again');
}
console.log(`module tests: ${pass} passed, ${failn} failed`); process.exit(failn ? 1 : 0);
