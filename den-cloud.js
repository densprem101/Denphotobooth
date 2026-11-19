/* ============================================================================================================
   Den Collective: cloud sign-in + sync (browser side).  Loaded by ONE line in index.html:
       <script src="/cloud/den-cloud.js" defer></script>
   It only talks to the app through window.DenBridge (a tiny, versioned adapter in index.html), and to the server
   through /api/*.  Remove the script tag and the booth is exactly the offline booth it always was.
   Rules this file follows:  never throws into the page · never blocks the UI · never touches the camera/capture flow ·
   never runs while a shoot is in progress · does nothing when offline or signed out.
   ============================================================================================================ */
(function () {
  'use strict';
  if (window.DenCloud) return;
  var STORES = ['layouts', 'templates', 'photos', 'welcome'];                       // layouts first: templates depend on them
  var SETTINGS_KEYS = ['den.event.v1', 'den.print.v1', 'den.theme', 'den.look', 'den.logo', 'den.cal.v1'];
  var S = { err: '', ready: false, storage: false, providers: {}, signedIn: false, me: null, busy: false, status: 'idle', prog: { done: 0, total: 0 }, res: null, flash: false, authLost: false, last: 0, bytes: 0, quota: 0, timer: 0, retry: 0 };
  var $ = function (id) { return document.getElementById(id); };
  var bridge = function () { var b = window.DenBridge; return b && b.v === 1 ? b : null; };
  var say = function (m) { try { var b = bridge(); if (b && b.toast) b.toast(m); } catch (e) { /* ignore */ } };
  var ls = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }, del: function (k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } } };
  var inShoot = function () { var b = bridge(); try { return !!b && b.screen() === 'capture'; } catch (e) { return false; } };

  /* ---------- network ---------- */
  function api(path, o) {
    o = o || {}; var ctl = new AbortController(), to = setTimeout(function () { ctl.abort(); }, o.timeout || 30000);
    var h = Object.assign({ 'X-Den-Cloud': '1' }, o.headers || {});
    return fetch('/api' + path, { method: o.method || 'GET', headers: h, body: o.body, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal }).then(function (r) { clearTimeout(to); return r; }, function (e) { clearTimeout(to); throw e; });
  }
  var jsonOf = function (r) { return r.json().catch(function () { return {}; }); };

  /* ---------- local data (same IndexedDB the app uses; opened briefly, closed right away so the app is never blocked) ---------- */
  function openLocal() {
    return new Promise(function (res, rej) {
      try { var r = indexedDB.open('den-collectives', 4); r.onupgradeneeded = function () { ['photos', 'templates', 'layouts', 'welcome'].forEach(function (n) { if (!r.result.objectStoreNames.contains(n)) { var st = r.result.createObjectStore(n, { keyPath: 'id' }); st.createIndex('owner', 'owner'); } }); }; r.onsuccess = function () { var db = r.result; db.onversionchange = function () { db.close(); }; res(db); }; r.onerror = function () { rej(r.error); }; r.onblocked = function () { rej(new Error('blocked')); }; } catch (e) { rej(e); }
    });
  }
  function reqP(r) { return new Promise(function (res, rej) { r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); }
  var recTs = function (r) { var n = Number(r && (r.ts || r.updated || r.created || r.t)) || 0; return n > 0 ? Math.floor(n) : 1; };
  /** short fingerprint of a record's content (ignores which account owns it; binary parts count by size + type), so an edit is noticed even when the record's own time stamp did not change */
  var hash = function (s) { var h = 5381; for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return String(h); };
  function fingerprint(rec) {
    var walk = function (v) {
      if (v instanceof Blob) return 'B' + v.size + ':' + (v.type || '');
      if (v instanceof ArrayBuffer) return 'A' + v.byteLength;
      if (ArrayBuffer.isView(v)) return 'V' + v.byteLength;
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') { var o = {}; Object.keys(v).sort().forEach(function (k) { if (k !== 'owner') o[k] = walk(v[k]); }); return o; }
      return v;
    };
    return hash(JSON.stringify(walk(rec)));
  }
  async function listLocal(email) {
    var db = await openLocal(), out = {};
    try {
      for (var i = 0; i < STORES.length; i++) {
        var st = STORES[i]; if (!db.objectStoreNames.contains(st)) continue;
        var idx = db.transaction(st, 'readonly').objectStore(st).index('owner');
        await new Promise(function (res, rej) {                                   // a cursor reads one record at a time (a getAll would hold every photo in memory at once)
          var c = idx.openCursor(IDBKeyRange.only(email));
          c.onsuccess = function () { var cur = c.result; if (!cur) return res(); var r = cur.value; if (r && typeof r.id === 'string') out[st + '/' + r.id] = { ts: recTs(r), fp: fingerprint(r) }; cur.continue(); };
          c.onerror = function () { rej(c.error); };
        });
      }
    } finally { db.close(); }
    return out;
  }
  async function getLocal(store, id) { var db = await openLocal(); try { return await reqP(db.transaction(store, 'readonly').objectStore(store).get(id)); } finally { db.close(); } }
  async function putLocal(store, rec) { var db = await openLocal(); try { var t = db.transaction(store, 'readwrite'); t.objectStore(store).put(rec); await new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; }); } finally { db.close(); } }
  async function delLocal(store, id) { var db = await openLocal(); try { var t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(id); await new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; }); } finally { db.close(); } }

  /* one record = one file: [4 bytes header length][JSON header][raw blob bytes ...]  (photos travel as real binary, no base64 bloat) */
  function pack(rec) {
    var blobs = [];
    var walk = function (v) { if (v instanceof Blob) { blobs.push(v); return { $b: blobs.length - 1, t: v.type || '', n: v.size }; } if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) { var ab = v instanceof ArrayBuffer ? v : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); blobs.push(new Blob([ab])); return { $b: blobs.length - 1, t: '', n: ab.byteLength, k: 'ab' }; } if (Array.isArray(v)) return v.map(walk); if (v && typeof v === 'object') { var o = {}; Object.keys(v).forEach(function (k) { o[k] = walk(v[k]); }); return o; } return v; };
    var head = new TextEncoder().encode(JSON.stringify({ v: 1, rec: walk(rec) })), len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, head.length);
    return new Blob([len, head].concat(blobs));
  }
  function unpack(buf) {
    var dv = new DataView(buf), hl = dv.getUint32(0), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl))), marks = [];
    var find = function (v) { if (Array.isArray(v)) v.forEach(find); else if (v && typeof v === 'object') { if (typeof v.$b === 'number' && typeof v.n === 'number') marks[v.$b] = v; else Object.keys(v).forEach(function (k) { find(v[k]); }); } };
    find(head.rec); var pos = 4 + hl, blobs = marks.map(function (m) { var raw = buf.slice(pos, pos + m.n); pos += m.n; if (raw.byteLength !== m.n) throw new Error('truncated'); return m.k === 'ab' ? raw : new Blob([raw], { type: m.t || '' }); });
    var build = function (v) { if (Array.isArray(v)) return v.map(build); if (v && typeof v === 'object') { if (typeof v.$b === 'number' && typeof v.n === 'number') return blobs[v.$b]; var o = {}; Object.keys(v).forEach(function (k) { o[k] = build(v[k]); }); return o; } return v; };
    return build(head.rec);
  }

  /* ---------- sync: three-way compare (this device / the cloud / what both agreed on last time) ---------- */
  var baseKey = function () { return 'den.cloud.base.' + (S.me && S.me.id); };
  var loadBase = function () { try { return JSON.parse(ls.get(baseKey()) || '{}') || {}; } catch (e) { return {}; } };
  var saveBase = function (b) { ls.set(baseKey(), JSON.stringify(b)); };
  var setKey = function () { return 'den.cloud.set.' + (S.me && S.me.id); };

  function readSettings(email) {
    var o = {}; SETTINGS_KEYS.forEach(function (k) { var v = ls.get(k); if (v !== null) o[k] = v; });
    try { var p = bridge().plus.get(email); if (p && p.key) o.__plus = p.key; } catch (e) { /* no Den+ key */ }
    return o;
  }
  async function syncSettings(email, remoteTs) {
    var saved = {}; try { saved = JSON.parse(ls.get(setKey()) || '{}') || {}; } catch (e) { saved = {}; }
    var cur = readSettings(email), h = hash(JSON.stringify(cur)), changedVisual = false;
    if (remoteTs > (saved.ts || 0) && (!saved.hash || saved.hash === h)) {          // newer in the cloud and nothing changed here: bring it down (new device, or edited on another)
      var d = await jsonOf(await api('/sync/settings'));
      if (d.ok && d.data) {
        Object.keys(d.data).forEach(function (k) { if (k !== '__plus' && SETTINGS_KEYS.indexOf(k) >= 0 && ls.get(k) !== d.data[k]) { ls.set(k, d.data[k]); changedVisual = true; } });
        if (d.data.__plus) { try { await bridge().plus.set(email, d.data.__plus); } catch (e) { /* ignore */ } }
        ls.set(setKey(), JSON.stringify({ hash: hash(JSON.stringify(readSettings(email))), ts: d.ts }));
      }
    } else if (h !== saved.hash && Object.keys(cur).length) {                       // changed on this device: send it up
      var r = await jsonOf(await api('/sync/settings', { method: 'PUT', body: JSON.stringify(cur), headers: { 'Content-Type': 'application/json' } }));
      if (r.ok) ls.set(setKey(), JSON.stringify({ hash: h, ts: r.ts }));
    }
    return changedVisual;
  }

  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var normBase = function (x) { return x && typeof x === 'object' ? x : (x ? { r: x, f: null } : null); };   // older versions stored just a number
  var WHY = { other: 'something unexpected happened (details are in the browser console)', quota: 'your cloud storage is full', too_big: 'a file is too big to upload', network: 'the connection dropped', server: 'the server had a problem', auth: 'your cloud login ended', corrupt: 'a downloaded file was damaged', missing: 'the cloud did not keep a file', local: 'a file on this device could not be read' };

  /** one request with automatic retries for dropped connections and temporary server errors. A 401 (login ended) is reported, never "fixed" by touching cookies or the local login. */
  async function apiRetry(path, o, tries) {
    var last = null; tries = tries || 3;
    for (var a = 0; a < tries; a++) {
      try {
        var r = await api(path, o);
        if (r.status === 401) { S.authLost = true; return r; }
        if (r.status >= 500 || r.status === 429 || r.status === 408) { last = r; await sleep(600 * Math.pow(2, a)); continue; }
        return r;
      } catch (e) { last = e; if (!navigator.onLine) break; await sleep(600 * Math.pow(2, a)); }
    }
    if (last instanceof Response) return last;
    throw last || new Error('network');
  }
  /** sends one record. Small ones go in a single request; big ones in 1 MB parts, each part retried on its own, so a weak connection only repeats a small piece. Always sends from memory (an ArrayBuffer): a file-backed Blob read from IndexedDB makes Safari fail the upload with "Load failed". */
  var CHUNK = 1024 * 1024, uid = function () { var a = new Uint8Array(10), o = ''; (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256; }); a.forEach(function (x) { o += (x % 36).toString(36); }); return 'u' + Date.now().toString(36) + o; };
  async function putRecord(path, chunkPath, buf, ts) {
    if (buf.byteLength <= CHUNK * 1.5) return apiRetry(path + '?ts=' + ts, { method: 'PUT', body: buf, timeout: 120000 }, 4);
    var u = uid(), n = Math.ceil(buf.byteLength / CHUNK), last = null;
    for (var i = 0; i < n; i++) {
      last = await apiRetry(chunkPath + '?u=' + u + '&i=' + i + '&n=' + n + '&ts=' + ts, { method: 'PUT', body: buf.slice(i * CHUNK, (i + 1) * CHUNK), timeout: 90000 }, 5);
      if (last.status === 404 && i === 0) return apiRetry(path + '?ts=' + ts, { method: 'PUT', body: buf, timeout: 180000 }, 4);   // an older server without the chunk route: one request instead
      if (!last.ok) return last;
      S.prog.sub = (i + 1) / n; render();
    }
    return last;
  }
  var whyOf = function (r, e) { if (r) { if (r.status === 401) return 'auth'; if (r.status === 507) return 'quota'; if (r.status === 413) return 'too_big'; if (r.status >= 500) return 'server'; return 'other'; } return e && /truncated|Unexpected|JSON/i.test(String(e && e.message)) ? 'corrupt' : e && (e.name === 'TypeError' || e.name === 'AbortError' || /load failed|failed to fetch|network|abort|timeout/i.test(String(e.message))) ? 'network' : 'other'; };   // only a real connection failure is called "connection dropped"

  async function cycle(reason) {
    var manual = reason === 'manual', b = bridge();
    if (!b || !S.signedIn) { if (manual) say('Sign in first to sync your data.'); return null; }
    if (S.busy) return null;                                                        // the button already shows "Syncing..."
    if (!manual && S.status === 'auth') return null;                                // login ended: wait for the person to sign in again instead of knocking every minute
    if (!navigator.onLine) { setStatus('offline'); if (manual) say('You are offline. It will sync when the internet is back.'); return null; }
    if (inShoot()) { schedule(20000); if (manual) say('Finish the photo shoot first, then sync.'); return null; }   // a shoot is never slowed down by syncing
    var u = b.user(); if (!u || !S.me || u.email !== S.me.email) return null;      // only ever sync the account that is signed in on this device
    S.busy = true; S.authLost = false; S.prog = { done: 0, total: 0 }; S.res = null; clearTimeout(S.flashT); setStatus('syncing');
    var up = 0, down = 0, gone = 0, failed = [], base = loadBase(), quotaFull = false;
    var stop = function () { return inShoot() || !navigator.onLine || S.authLost; };
    var split = function (key) { var i = key.indexOf('/'); return [key.slice(0, i), key.slice(i + 1)]; };
    var path = function (key) { var p = split(key); return '/sync/rec/' + p[0] + '/' + encodeURIComponent(p[1]); };
    var fail = function (key, why) { failed.push({ key: key, why: why }); };
    var tick = function () { S.prog.done++; render(); };
    try {
      var mr = await apiRetry('/sync/manifest');
      if (mr.status === 401) throw { auth: true };
      var man = await jsonOf(mr); if (!mr.ok || !man.ok) throw new Error('manifest');
      S.bytes = man.bytes || 0; S.quota = man.quota || 0;
      var remote = {}; (man.records || []).forEach(function (r) { remote[r.store + '/' + r.id] = { ts: Number(r.ts) || 0, size: r.size || 0 }; });
      var local = await listLocal(u.email), keys = {};
      [local, remote, base].forEach(function (o) { Object.keys(o).forEach(function (x) { keys[x] = 1; }); });
      var plan = { down: [], up: [], delLocal: [], delRemote: [] };
      Object.keys(keys).forEach(function (key) {
        var L = local[key], R = remote[key], B = normBase(base[key]);
        if (L && R) {
          var lc, rc;
          if (B) { rc = R.ts !== B.r; lc = B.f ? B.f !== L.fp : (!rc && L.ts > R.ts); }
          else if (L.ts === R.ts) { base[key] = { r: R.ts, f: L.fp }; return; }                 // first time this device sees it and both agree
          else { lc = L.ts > R.ts; rc = !lc; }
          if (lc && rc) plan.up.push(key);                                                      // both changed: the device that is syncing now keeps its version
          else if (lc) plan.up.push(key); else if (rc) plan.down.push(key); else base[key] = { r: R.ts, f: L.fp };
        } else if (L && !R) { if (B && !(B.f && B.f !== L.fp)) plan.delLocal.push(key); else plan.up.push(key); }   // had it before + unchanged = removed on another device; edited here = keep it
        else if (!L && R) { if (B && R.ts === B.r) plan.delRemote.push(key); else plan.down.push(key); }          // had it before = removed here; changed meanwhile elsewhere = bring it back
        else delete base[key];
      });
      var baseCount = Object.keys(base).length, delTotal = plan.delLocal.length + plan.delRemote.length;
      if (delTotal >= 5 && delTotal > baseCount * 0.5) { plan.delLocal = []; plan.delRemote = []; }   // a mass removal is never trusted: the sets are merged instead, nothing is wiped
      if (plan.delLocal.length >= 3 && !Object.keys(remote).length) plan.delLocal = [];         // an empty cloud listing next to a full device is suspicious: never wipe the device on that
      var byStore = function (a, c) { return STORES.indexOf(split(a)[0]) - STORES.indexOf(split(c)[0]); };
      plan.down.sort(byStore); plan.up.sort(byStore);
      S.prog.total = plan.down.length + plan.up.length + plan.delRemote.length + plan.delLocal.length;
      var pool = async function (items, n, fn) { var i = 0; await Promise.all(Array.apply(null, Array(Math.min(n, items.length))).map(async function () { while (i < items.length) { var it = items[i++]; if (stop() || quotaFull) return; await fn(it); } })); };

      for (var si = 0; si < STORES.length; si++) {                                              // layouts, then templates, then photos (templates need their layouts)
        var inStore = function (k) { return split(k)[0] === STORES[si]; };
        await pool(plan.down.filter(inStore), 3, async function (key) {
          try {
            var d = split(key), res = await apiRetry(path(key), { timeout: 120000 });
            if (res.status === 404) { fail(key, 'missing'); return; }
            if (!res.ok) { fail(key, whyOf(res)); return; }
            var rec = unpack(await res.arrayBuffer()); rec.owner = u.email; await putLocal(d[0], rec);
            base[key] = { r: remote[key].ts, f: fingerprint(rec) }; saveBase(base); down++;
          } catch (e) { fail(key, e && e.auth ? 'auth' : whyOf(null, e)); } finally { tick(); }
        });
        await pool(plan.up.filter(inStore), 3, async function (key) {
          try {
            var p = split(key), lr = await getLocal(p[0], p[1]); if (!lr) { tick(); return; }
            var f = fingerprint(lr), ts = Math.max(Date.now(), ((remote[key] && remote[key].ts) || 0) + 1);   // the cloud time always moves forward, so other devices notice the change
            var buf; try { buf = await pack(lr).arrayBuffer(); } catch (pe) { try { console.warn('[DenCloud] could not read ' + key + ' from this device', pe); } catch (e3) { /* ignore */ } fail(key, 'local'); return; }
            var cp = path(key).replace('/sync/rec/', '/sync/chunk/'), rs = await putRecord(path(key), cp, buf, ts), rj = await jsonOf(rs);
            if (rs.ok && rj.ok) { base[key] = { r: rj.ts || ts, f: f }; remote[key] = { ts: rj.ts || ts, size: rj.size || 0 }; saveBase(base); up++; }
            else { if (rs.status === 507) { quotaFull = true; say('Your cloud storage is full. Delete old sessions to keep syncing.'); } fail(key, whyOf(rs)); }
          } catch (e) { try { console.warn('[DenCloud] upload of ' + key + ' failed', e); } catch (e3) { /* ignore */ } fail(key, whyOf(null, e)); } finally { tick(); }
        });
      }
      await pool(plan.delRemote, 3, async function (key) { try { var x = await apiRetry(path(key), { method: 'DELETE' }); if (x.ok) { delete base[key]; saveBase(base); } else fail(key, whyOf(x)); } catch (e) { fail(key, whyOf(null, e)); } finally { tick(); } });
      for (var i = 0; i < plan.delLocal.length && !stop(); i++) { try { var dl = split(plan.delLocal[i]); await delLocal(dl[0], dl[1]); delete base[plan.delLocal[i]]; gone++; } catch (e) { fail(plan.delLocal[i], 'local'); } tick(); }
      saveBase(base);

      if (S.authLost) throw { auth: true };
      /* check-up: ask the cloud again what it holds and make sure every item that was meant to be uploaded is really there */
      if (up && !stop()) {
        try {
          var vr = await apiRetry('/sync/manifest'), vm = vr.ok ? await jsonOf(vr) : null;
          if (vm && vm.ok) {
            var have = {}; (vm.records || []).forEach(function (r) { have[r.store + '/' + r.id] = 1; }); S.bytes = vm.bytes || S.bytes;
            plan.up.forEach(function (k) { if (!have[k] && !failed.some(function (f) { return f.key === k; })) { delete base[k]; fail(k, 'missing'); up--; } });
            saveBase(base);
          }
        } catch (e) { /* the check-up is best effort */ }
      }
      var changedVisual = false; try { changedVisual = await syncSettings(u.email, man.settingsTs || 0); } catch (e) { /* settings are retried next time */ }
      S.last = Date.now();
      var allKeys = {}; Object.keys(remote).forEach(function (k) { allKeys[k] = 1; }); plan.down.forEach(function (k) { allKeys[k] = 1; });
      var merged = Object.keys(allKeys), mPhotos = merged.filter(function (k) { return k.indexOf('photos/') === 0; }).length;
      S.res = { up: up, down: down, gone: gone, failed: failed.length, total: S.prog.total, why: failed.length ? failed[0].why : '', items: merged.length, photos: mPhotos };
      if (failed.length) { S.retry = Math.min(S.retry + 1, 5); schedule(Math.min(300000, 20000 * Math.pow(2, S.retry))); setStatus('partial'); }
      else { S.retry = 0; setStatus('ok'); }
      if (down || gone || changedVisual) { try { await b.refresh(); } catch (e) { /* ignore */ } }
      if (changedVisual && reason === 'login' && !sessionStorage.getItem('den.cloud.reloaded')) {      // first sign-in on a new device: apply the saved look once
        try { sessionStorage.setItem('den.cloud.reloaded', '1'); } catch (e) { /* ignore */ }
        var sc = ''; try { sc = b.screen(); } catch (e) { /* ignore */ }
        if (sc === 'landing' || sc === 'setup' || !sc) setTimeout(function () { location.reload(); }, 400);
      }
      if (reason === 'login' && down) say('Restored ' + down + ' item' + (down === 1 ? '' : 's') + ' from your cloud account.');
      if (manual) say(failed.length ? 'Sync finished, but ' + failed.length + ' item' + (failed.length === 1 ? '' : 's') + ' could not be synced (' + (WHY[S.res.why] || WHY.other) + ').' : 'Merged: ' + (up || down ? up + ' uploaded, ' + down + ' downloaded. ' : 'already the same on both sides. ') + S.res.items + ' items now match.');
    } catch (e) {
      if (e && e.auth) { S.res = { auth: true }; setStatus('auth'); if (manual) say('Your cloud login ended. Sign in with Google again to keep syncing. Nothing on this device was changed.'); }   // never clears cookies or the local login
      else { S.res = { failed: 1, why: navigator.onLine ? 'network' : 'network' }; setStatus(navigator.onLine ? 'error' : 'offline'); S.retry = Math.min(S.retry + 1, 5); schedule(Math.min(300000, 15000 * Math.pow(2, S.retry))); if (manual) say('Could not reach the cloud. Please try again in a moment.'); }
    } finally { S.busy = false; render(); }
    return S.res;
  }
  function schedule(ms) { clearTimeout(S.timer); S.timer = setTimeout(function () { cycle('tick'); }, ms); }

  /* ---------- sign-in state ---------- */
  async function checkSession(justLoggedIn) {
    var b = bridge(); if (!b || !S.storage) return;
    try {
      var r = await api('/me');
      if (r.status === 401) { S.signedIn = false; S.me = null; render(); return; }                  // only a real "not signed in" answer counts
      if (!r.ok) { render(); return; }                                                                // a hiccup (500 / 503 / 429) must never look like a logout: keep everything as it is and try again later
      var j = await jsonOf(r), local = b.user();
      S.me = j.user; S.bytes = j.bytes || 0;
      if (!local || justLoggedIn) { await b.signIn({ email: j.user.email, name: j.user.name, provider: 'cloud' }); }   // new device / just came back from Google
      local = b.user(); S.signedIn = !!local && local.email === j.user.email; render();
      if (S.signedIn) cycle(justLoggedIn || !local ? 'login' : 'start');
    } catch (e) { render(); }
  }
  async function cloudSignOut() {
    S.signedIn = false; S.me = null; clearTimeout(S.timer); render();
    try { await api('/auth/logout', { method: 'POST' }); ls.del('den.cloud.pendingLogout'); } catch (e) { ls.set('den.cloud.pendingLogout', '1'); }   // offline: finish it when back online
  }

  /* ---------- email + password accounts (the same cloud account and storage as Google; the booth's own log-in form calls these) ---------- */
  var AUTH_WHY = { exists: 'exists', google_account: 'google_account', google_only: 'google_only', invalid: 'invalid', too_many: 'too_many', bad_email: 'bad_email', bad_password: 'bad_password', wrong_current: 'wrong_current', forbidden: 'invalid' };
  async function authCall(path, body) {
    if (!S.storage) return { ok: false, code: 'unavailable' };
    try {
      var r = await api('/auth/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), timeout: 20000 });
      var j = await jsonOf(r);
      if (r.ok && j.ok) return { ok: true, user: j.user };
      if (r.status === 503 || r.status >= 500) return { ok: false, code: 'unavailable' };
      return { ok: false, code: AUTH_WHY[j.error] || 'invalid', status: r.status };
    } catch (e) { return { ok: false, code: 'offline' }; }
  }
  var cloudAuth = {
    available: function () { return !!S.storage; },
    register: function (email, password, name) { return authCall('register', { email: email, password: password, name: name }); },
    login: function (email, password) { return authCall('login', { email: email, password: password }); },
    setPassword: function (password, current) { return authCall('password', { password: password, current: current || '' }); },
    /** After the booth accepted a password on this device: makes sure the same email + password exists in the cloud too, so every other device can use it (older device-only accounts move over the first time they log in). */
    ensure: async function (email, password, name) {
      if (!S.storage) return { ok: false, code: 'unavailable' };
      var r = await cloudAuth.login(email, password);
      if (!r.ok && r.code === 'invalid') r = await cloudAuth.register(email, password, name);
      if (r.ok) { await checkSession(false); }
      return r;
    },
    session: function () { return checkSession(true); }
  };
  function pwDialog() {
    if ($('dcPwDlg')) return;
    var has = !!(S.me && S.me.hasPassword), d = document.createElement('div'); d.id = 'dcPwDlg';
    d.style.cssText = 'position:fixed;inset:0;z-index:2147483200;display:grid;place-items:center;background:rgba(63,75,92,.45);padding:16px';
    d.innerHTML = '<form style="width:min(92vw,380px);display:grid;gap:10px;padding:16px;border:2px solid var(--ink);border-radius:18px;background:var(--paper);color:var(--ink);box-shadow:0 6px 0 var(--ink)" novalidate><b style="font-size:1.1rem">' + (has ? 'Change password' : 'Set a password') + '</b>' +
      '<p style="margin:0;font-size:.9rem;color:var(--ink-soft)">' + (has ? '' : 'Add a password so you can also log in with your email, on any device. Google sign-in keeps working.') + '</p>' +
      (has ? '<input id="dcPwCur" type="password" placeholder="Current password" autocomplete="current-password" maxlength="100" style="min-height:46px;padding:8px 12px;font:inherit;font-size:16px;border:2px solid var(--ink);border-radius:12px;background:#fff;color:var(--ink)">' : '') +
      '<input id="dcPwNew" type="password" placeholder="New password (6+ characters)" autocomplete="new-password" maxlength="100" style="min-height:46px;padding:8px 12px;font:inherit;font-size:16px;border:2px solid var(--ink);border-radius:12px;background:#fff;color:var(--ink)">' +
      '<p id="dcPwMsg" role="status" style="margin:0;min-height:1.2em;font-size:.9rem;color:#b3261e"></p>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end"><button type="button" id="dcPwNo" class="btn" style="min-height:44px;padding:6px 14px;border:2px solid var(--ink);border-radius:12px;background:var(--paper);color:var(--ink);font:inherit">Cancel</button><button type="submit" id="dcPwGo" class="btn btn--primary" style="min-height:44px;padding:6px 14px;border:2px solid var(--ink);border-radius:12px;background:var(--blue-soft);color:var(--ink);font:inherit">Save</button></div></form>';
    document.body.appendChild(d);
    var close = function () { d.remove(); }, msg = function (t) { d.querySelector('#dcPwMsg').textContent = t; };
    d.querySelector('#dcPwNo').addEventListener('click', close);
    d.addEventListener('click', function (e) { if (e.target === d) close(); });
    d.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault(); var np = d.querySelector('#dcPwNew').value, cur = has ? d.querySelector('#dcPwCur').value : '';
      if (np.length < 6) return msg('New password needs at least 6 characters.');
      var go = d.querySelector('#dcPwGo'); go.disabled = true; msg('Saving...');
      var r = await cloudAuth.setPassword(np, cur);
      go.disabled = false;
      if (!r.ok) return msg(r.code === 'wrong_current' ? 'The current password is not right.' : r.code === 'too_many' ? 'Too many tries. Please wait a few minutes.' : r.code === 'offline' ? 'You are offline. Try again when you are connected.' : 'Could not save right now. Please try again.');
      try { var b = bridge(); if (b && b.setLocalPassword && S.me) await b.setLocalPassword(S.me.email, np); } catch (x) { /* the cloud copy is what counts */ }
      if (S.me) S.me.hasPassword = true; close(); render(); say('Password saved. You can now log in with your email too.');
    });
    setTimeout(function () { var i = d.querySelector(has ? '#dcPwCur' : '#dcPwNew'); if (i) i.focus({ preventScroll: true }); }, 60);
  }

  /* ---------- UI (added to the existing menu, uses the theme colours) ---------- */
  var ICON = { google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23 12.3c0-.8-.1-1.5-.2-2.3H12v4.4h6.2a5.3 5.3 0 0 1-2.3 3.5v2.9h3.7c2.2-2 3.4-5 3.4-8.5z"/><path fill="#34A853" d="M12 24c3.1 0 5.7-1 7.6-2.8l-3.7-2.9c-1 .7-2.3 1.1-3.9 1.1-3 0-5.5-2-6.4-4.7H1.8v3A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.6 14.7a7.2 7.2 0 0 1 0-4.6v-3H1.8a12 12 0 0 0 0 10.6l3.8-3z"/><path fill="#EA4335" d="M12 4.8c1.7 0 3.2.6 4.4 1.7l3.3-3.3A12 12 0 0 0 1.8 7.1l3.8 3c.9-2.7 3.4-5.3 6.4-5.3z"/></svg>' };
  /* Plain-language explanations for every reason code the server can send back (the codes are listed in CLOUD-SETUP.md). The generic message is only the very last fallback. */
  function explain(reason, detail) {
    reason = String(reason || ''); detail = String(detail || '');
    var m = {
      not_configured: 'Google sign-in is not set up on this website yet.',
      cancelled: 'Sign-in was cancelled.',
      google_invalid_client: 'Google did not accept this app\'s Client ID or Client Secret. The site owner needs to re-copy them into Cloudflare.',
      google_redirect_uri_mismatch: 'Google does not recognise this web address. The site owner needs to add the callback address in Google Cloud.',
      google_invalid_grant: 'Google refused the sign-in code (already used, expired, or the address did not match). Please try again.',
      google_unauthorized_client: 'This Google app is not allowed to use sign-in. The site owner needs to check the OAuth settings in Google Cloud.',
      google_invalid_request: 'Google could not understand the sign-in request. Please try again.',
      google_network: 'The website could not reach Google. Check the internet connection and try again.',
      db: 'The cloud database refused the sign-in' + (detail ? ' (' + detail + ')' : '') + '. The site owner should open /api/health?check=1 to see what is missing.',
      login_failed: 'Google accepted you, but the website could not start your session. Please try again.',
      token_wrong_audience: 'The Google Client ID on the server does not match the one used to sign in. The site owner needs to re-check GOOGLE_CLIENT_ID.',
      token_expired: 'The Google sign-in expired before it finished. Please try again.'
    };
    var st = { no_cookie: 'Your browser did not keep the sign-in cookie. Allow cookies for this site and open it at the same web address you started from, then try again.', expired: 'The sign-in took too long. Please try again.', mismatch: 'That sign-in link was already used. Please start again.' };
    var text = reason === 'state' ? (st[detail] || 'The sign-in could not be matched to this browser. Please try again.') : m[reason];
    if (!text && /^google_/.test(reason)) text = 'Google reported a problem (' + reason.slice(7).replace(/_/g, ' ') + '). Please try again.';
    if (!text && /^token_/.test(reason)) text = 'Google sent back a sign-in that could not be verified (' + reason.slice(6).replace(/_/g, ' ') + '). Please try again.';
    return (text || 'Google sign-in could not finish.') + ' (code: ' + (reason || 'unknown') + '). You can also sign in with email and password.';
  }
  function css() {
    if ($('den-cloud-css')) return; var s = document.createElement('style'); s.id = 'den-cloud-css';
    s.textContent = '.den-social{display:grid;gap:8px;width:100%}.den-social[hidden]{display:none}.ds-or{font-size:.95rem;color:var(--ink-soft);text-align:center;margin:2px 0 0}.ds-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px}' +
      '.ds-btn{display:flex;align-items:center;justify-content:center;gap:10px;min-height:50px;padding:8px 12px;border:2px solid var(--ink);border-radius:14px;background:var(--paper);color:var(--ink);font:inherit;font-weight:600;font-size:1.05rem;text-decoration:none;box-shadow:2px 3px 0 var(--beige-deep);cursor:pointer;-webkit-tap-highlight-color:transparent;transition:background-color .15s,transform .1s,box-shadow .15s}' +
      '.ds-btn:hover{background:var(--blue-soft)}.ds-btn:active{transform:translate(1px,2px);box-shadow:none}.ds-btn svg{width:22px;height:22px;flex:none}.ds-btn[hidden]{display:none}' +
      '.ds-msg{margin:0;font-size:.9rem;color:var(--ink-soft);text-align:center;min-height:0}.ds-msg:empty{display:none}.ds-note{margin:0;font-size:.85rem;color:var(--ink-soft);text-align:center}' +
      '.den-cloudrow{order:5;grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:8px 12px;border:2px dashed var(--ink);border-radius:14px;background:var(--paper);color:var(--ink);font-size:1rem}.den-cloudrow b{font-weight:700}.den-cloudrow .dc-s{flex:1 1 140px;color:var(--ink-soft)}' +
      '.den-cloudrow button{font:inherit;font-size:.95rem;padding:6px 12px;min-height:38px;border:2px solid var(--ink);border-radius:12px;background:var(--paper);color:var(--ink);cursor:pointer}.den-cloudrow button:hover{background:var(--blue-soft)}.den-cloudrow .dc-del{border-style:dashed;border-color:var(--ink-soft);color:var(--ink-soft)}' +
      '.den-cloudrow #dcSync{display:inline-flex;align-items:center;justify-content:center;min-width:112px}.dc-spin{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;display:inline-block;margin-right:7px;animation:dcspin .8s linear infinite}@keyframes dcspin{to{transform:rotate(360deg)}}html.reduce-motion .dc-spin{animation-duration:2.4s}' +
      '.den-cloudrow #dcSync.dc-ok{background:var(--blue-soft)}.den-cloudrow #dcSync.dc-err{border-color:#b3261e;color:#b3261e}.den-cloudrow #dcSync:disabled{opacity:.75;cursor:progress}.den-cloudrow .dc-s.dc-err{color:#b3261e}' +
      'body.den-cloud #acBackup,body.den-cloud #acRestore,body.den-cloud #acRecover{display:none!important}';
    document.head.appendChild(s);
  }
  function social() {
    var host = document.querySelector('#acctGuest .acct-guest-auth'); if (!host) return;
    var box = $('denSocial');
    if (!box) {
      box = document.createElement('div'); box.id = 'denSocial'; box.className = 'den-social'; box.hidden = true;
      box.innerHTML = '<div class="ds-or">Sign in with Google to keep your photos and templates on every device</div><div class="ds-row">' +
        '<a class="ds-btn" data-p="google" href="/api/auth/google/start" hidden>' + ICON.google + '<span>Continue with Google</span></a>' +
        '</div><p class="ds-msg" id="dsMsg" role="status"></p><p class="ds-note">or use an email and password below. The booth always works without an account.</p>';
      var note = host.querySelector('.acct-note'); if (note && note.nextSibling) host.insertBefore(box, note.nextSibling); else host.insertBefore(box, host.firstChild);
      box.addEventListener('click', function (e) {
        var a = e.target.closest && e.target.closest('.ds-btn'); if (!a) return;
        if (!navigator.onLine) { e.preventDefault(); $('dsMsg').textContent = 'You are offline. Sign in again when you have internet, or use the email login.'; return; }
        a.href = '/api/auth/' + a.dataset.p + '/start?return=' + encodeURIComponent(location.pathname || '/');
      });
    }
    var any = false; box.querySelectorAll('.ds-btn').forEach(function (a) { var on = !!S.providers[a.dataset.p]; a.hidden = !on; any = any || on; });
    box.hidden = !(S.storage && any);
    var dm = $('dsMsg'); if (dm && S.err) dm.textContent = S.err;
  }
  var mbText = function (n) { return n >= 1073741824 ? (n / 1073741824).toFixed(1) + ' GB' : Math.max(0.1, n / 1048576).toFixed(n >= 10485760 ? 0 : 1) + ' MB'; };
  var plural = function (n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); };
  function statusText() {
    var r = S.res || {};
    if (S.busy || S.status === 'syncing') return S.prog && S.prog.total ? 'Syncing ' + Math.min(S.prog.done, S.prog.total) + ' of ' + S.prog.total + '...' : 'Syncing... checking what is new';
    if (S.status === 'offline') return 'Offline. Will sync when you are back online.';
    if (S.status === 'auth') return 'Your cloud login ended. Sign in with Google again. Everything on this device is safe.';
    if (S.status === 'error') return 'Could not reach the cloud. Will retry automatically.';
    if (S.status === 'partial') return plural(r.failed || 0, 'item') + (r.total ? ' of ' + r.total : '') + ' could not sync: ' + (WHY[r.why] || WHY.other) + '. Tap Try again (it also retries by itself).';
    if (S.status === 'ok' && S.flash) return (r.up || r.down || r.gone ? 'Merged: ' + [r.up ? r.up + ' uploaded' : '', r.down ? r.down + ' downloaded' : '', r.gone ? r.gone + ' removed' : ''].filter(Boolean).join(', ') : 'Already in sync') + (r.items ? ' · ' + r.items + ' items (' + (r.photos || 0) + ' photos) on this device and in the cloud' : '') + '.';
    var ago = S.last ? (Date.now() - S.last < 90000 ? 'just now' : Math.round((Date.now() - S.last) / 60000) + ' min ago') : '';
    return 'Up to date' + (ago ? ' · ' + ago : '') + (S.bytes ? ' · ' + mbText(S.bytes) + ' used' : '');
  }
  function row() {
    var vm = $('viewMain'), r = $('denCloudRow');
    if (!S.signedIn) { if (r) r.remove(); return; }
    if (!vm) return;
    if (!r) {
      r = document.createElement('div'); r.id = 'denCloudRow'; r.className = 'den-cloudrow';
      r.innerHTML = '<span aria-hidden="true">☁</span> <b>Cloud sync</b> <span class="dc-s" id="dcState" role="status" aria-live="polite"></span><button type="button" id="dcSync"><span class="dc-spin" hidden></span><span class="dc-t">Sync now</span></button><button type="button" id="dcPw">Set password</button><button type="button" id="dcDel" class="dc-del">Delete cloud data</button>';
      vm.insertBefore(r, vm.firstChild);
      r.querySelector('#dcSync').addEventListener('click', function () {
        if (S.busy) return;
        if (S.status === 'auth') { location.href = '/api/auth/google/start?return=' + encodeURIComponent(location.pathname || '/'); return; }   // the normal Google sign-in again; nothing is cleared first
        clearTimeout(S.timer); cycle('manual');
      });
      r.querySelector('#dcPw').addEventListener('click', pwDialog);
      r.querySelector('#dcDel').addEventListener('click', async function () {
        if (!confirm('Delete everything stored in your cloud account (photos, templates, layouts)? Copies on your devices are kept.')) return;
        try { var x = await api('/me', { method: 'DELETE' }); if (x.ok) { ls.del(baseKey()); ls.del(setKey()); S.signedIn = false; S.me = null; render(); say('Your cloud data was deleted.'); } else say('Could not delete right now. Please try again.'); } catch (e) { say('Could not delete right now. Please try again.'); }
      });
    }
    var pb = $('dcPw'); if (pb) pb.textContent = S.me && S.me.hasPassword ? 'Change password' : 'Set password';
    var st = $('dcState'), sb = $('dcSync'), busy = S.busy || S.status === 'syncing', bad = !busy && (S.status === 'partial' || S.status === 'error' || S.status === 'auth');
    st.textContent = statusText(); st.classList.toggle('dc-err', bad);
    var label = busy ? 'Syncing...' : S.status === 'auth' ? 'Sign in again' : bad ? 'Try again' : S.status === 'ok' && S.flash ? '✓ Synced' : 'Sync now';
    sb.querySelector('.dc-t').textContent = label; sb.querySelector('.dc-spin').hidden = !busy;
    sb.disabled = busy; sb.setAttribute('aria-busy', busy ? 'true' : 'false'); sb.classList.toggle('dc-err', bad); sb.classList.toggle('dc-ok', !busy && S.status === 'ok' && !!S.flash);
  }
  function render() { try { document.body.classList.toggle('den-cloud', !!S.signedIn); social(); row(); } catch (e) { /* UI is optional */ } }
  function setStatus(s) { S.status = s; if (s === 'ok') { S.flash = true; clearTimeout(S.flashT); S.flashT = setTimeout(function () { S.flash = false; render(); }, 4500); } else S.flash = false; render(); }

  /* prints the server self-check to the browser console (F12): which secret / binding is missing, and the exact callback address Google needs */
  async function diagnose() {
    try {
      var d = await jsonOf(await api('/health?check=1', { timeout: 8000 }));
      console.info('[DenCloud] server check (ok=' + d.ok + ')'); (d.checks || []).forEach(function (c) { console[c.ok ? 'info' : 'warn']('  ' + (c.ok ? 'OK     ' : 'FIX    ') + c.name + (c.ok ? '' : ' -> ' + c.hint)); });
      if (d.addThisRedirectUriInGoogleCloud) console.info('  Google Cloud > Authorized redirect URI must be exactly: ' + d.addThisRedirectUriInGoogleCloud);
      return d;
    } catch (e) { console.warn('[DenCloud] could not run the server check (offline?)'); return null; }
  }

  /* ---------- start ---------- */
  async function init() {
    css();
    var b = bridge(); if (!b) return;
    var q = new URLSearchParams(location.search), flag = q.get('cloud'), reason = q.get('reason'), detail = q.get('detail');
    if (flag) { q.delete('cloud'); q.delete('reason'); q.delete('detail'); try { history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); } catch (e) { /* ignore */ } }
    try {
      var h = await jsonOf(await api('/health', { timeout: 8000 }));
      S.storage = !!h.storage; S.providers = h.providers || {};
    } catch (e) { S.storage = false; }                                       // offline or no backend: the booth simply stays a normal booth
    S.ready = true; render();
    if (flag === 'error') {
      S.err = explain(reason, detail); render(); say(S.err);
      try { console.error('[DenCloud] Google sign-in failed. reason=' + reason + (detail ? ' detail=' + detail : '')); diagnose(); } catch (e) { /* console help only */ }
    }
    if (ls.get('den.cloud.pendingLogout') && navigator.onLine) { try { await api('/auth/logout', { method: 'POST' }); ls.del('den.cloud.pendingLogout'); } catch (e) { /* retry later */ } }
    else if (S.storage) await checkSession(flag === 'ok');
    if (flag === 'ok' && S.signedIn) say('Signed in. Restoring your photos and templates...');
    if (flag === 'ok' && !S.signedIn) {                                       // Google said yes, but we could not find the login afterwards
      S.err = 'Google accepted you, but this browser did not keep the login. Allow cookies for this site (in Safari: turn off "Block all cookies"), then try again.'; render(); say(S.err);
      try { console.error('[DenCloud] Sign-in finished on the server, but /api/me did not see the session cookie. Check cookies, and that the site is opened at the same address you signed in from.'); diagnose(); } catch (e) { /* ignore */ }
    }
    window.addEventListener('den:user', function (ev) {
      if (ev.detail && ev.detail.email) { if (!S.signedIn || !S.me || S.me.email !== ev.detail.email) checkSession(false); render(); }
      else if (S.signedIn || S.me) cloudSignOut(); else render();            // the person pressed Log out
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { cycle('visible'); } });
    window.addEventListener('online', function () { if (ls.get('den.cloud.pendingLogout')) { api('/auth/logout', { method: 'POST' }).then(function () { ls.del('den.cloud.pendingLogout'); }, function () {}); } else { checkSession(false); } });
    window.addEventListener('offline', function () { if (S.signedIn) setStatus('offline'); });
    setInterval(function () { if (!document.hidden) cycle('tick'); else render(); }, 60000);
    var acct = $('acctPanel'); if (acct) new MutationObserver(function () { render(); }).observe(acct, { attributes: true, attributeFilter: ['hidden'] });
  }
  window.DenCloud = { v: 1, auth: cloudAuth, state: S, syncNow: function () { return cycle('manual'); }, diagnose: diagnose, explain: explain, pack: pack, unpack: unpack };
  var go = function () { try { init(); } catch (e) { /* never break the page */ } };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else setTimeout(go, 0);
})();
