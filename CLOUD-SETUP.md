# Den Collective: Google Sign-In + Cloud Sync (Super Easy Guide)

Google at email/password na lang ang login. (Inalis na ang Facebook at Apple.)
Isang beses mo lang ito gagawin. Pagkatapos, **hindi na ito masisira ng mga susunod na update ng website.**

---------------------------------------------------------------------------------------------------

## A. FIX MUNA: "Could not sign in. Please try again."  (gawin ito ngayon, ≈ 5 minuto)

Kung nakapag-setup ka na dati at ito ang lumalabas, sundan ang 6 na hakbang na ito:

**1. I-upload ang bagong zip.** I-extract, tapos i-upload ang buong folder sa Cloudflare Pages (parang dati).
   Yung bagong `_worker.js` ang nag-aayos ng error, at nagbibigay na ito ng **eksaktong dahilan** sa halip na "Could not sign in".

**2. Buksan ito sa browser:**

```
https://denphotobooth.online/api/health?check=1
```

May lalabas na listahan. Bawat linya ay may `"ok": true` (okay) o `"ok": false` na may **"hint"** (ito ang gagawin mo).
Ayusin lahat ng `false` hanggang `"ok": true` na ang lahat sa taas.
Makikita mo rin doon ang **eksaktong Redirect URI** (`addThisRedirectUriInGoogleCloud`) na kailangan ng Google.

**3. Sa Google Cloud:** https://console.cloud.google.com → **APIs & Services → Credentials** → i-click ang **OAuth 2.0 Client ID** mo.
   Sa **Authorized redirect URIs**, dapat **eksaktong ito** (kopyahin, huwag i-type):

```
https://denphotobooth.online/api/auth/google/callback
```

   Walang dagdag na `/` sa dulo, `https`, at tamang domain. Kung minsan nagbubukas ka rin gamit ang `www.denphotobooth.online`, idagdag din ang:
   `https://www.denphotobooth.online/api/auth/google/callback`. Pindutin ang **Save** (hintayin ng 1-5 minuto bago umepekto).

**4. Sa Google Cloud → OAuth consent screen:** siguraduhing **Publishing status = "In production"** (pindutin ang **Publish app**).
   Kung "Testing" ito, mga test users lang ang makaka-login.

**5. Sa Cloudflare Pages → Settings → Variables and Secrets**, i-**paste ulit nang malinis** (kahit okay na ang tingin mo):

| Name | Saan kukunin |
|---|---|
| `GOOGLE_CLIENT_ID` | Google Credentials → "Client ID" (nagtatapos sa `.apps.googleusercontent.com`) |
| `GOOGLE_CLIENT_SECRET` | Google Credentials → "Client secret" (nagsisimula sa `GOCSPX-`) |
| `SESSION_SECRET` | kahit anong 32+ random na letters/numbers (tingnan ang Part B3) |

   Maling spaces, line breaks, o quotes (`"`) sa paste ay awtomatiko nang binabalewala ng bagong code.

**6. Cloudflare → Deployments → ang pinakabago → "Retry deployment"** (para umepekto ang secrets). Buksan ulit ang `/api/health?check=1`: dapat puro `true`.
   Subukan ang **Continue with Google**. Kung may problema pa rin, **ang mensahe na sa app ay may kasamang `code`**. Hanapin ang code sa Part D.

---------------------------------------------------------------------------------------------------

## B. Unang beses na setup (kung wala pa)

**B1. Database (D1)**: Cloudflare → **Storage & Databases → D1 SQL Database → Create database** → name `den-db` → Create.
   (Hindi mo na kailangang mag-paste ng SQL. Ang mga table ay **kusang nagagawa** ng worker.)

**B2. File storage (R2)**: **R2 Object Storage → Create bucket** → name `den-files` → Create. (Huwag i-public.)

**B3. SESSION_SECRET**: buksan ang kahit anong website, F12 → **Console**, i-paste, Enter, kopyahin ang lumabas:

```js
Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
```

**B4. I-upload ang site**: Pages project → **Deployments → Create new deployment** → i-drag ang buong folder (nasa pinakaugat ang `index.html`, `_worker.js`, `_routes.json`, at `cloud/`).

**B5. Bindings**: Pages project → **Settings → Bindings**:
   - **Add → D1 database** → Variable name `DB` → piliin `den-db`
   - **Add → R2 bucket** → Variable name `FILES` → piliin `den-files`

**B6. Google OAuth client** (isang beses lang):
   1. https://console.cloud.google.com → **New Project** ("Den Collective").
   2. **OAuth consent screen** → **External** → App name *Den Collective*, email mo, Authorized domain `denphotobooth.online`,
      **Application privacy policy link = `https://denphotobooth.online/privacy.html`** (kasama na sa zip),
      **Application terms of service link = `https://denphotobooth.online/terms.html`** (kasama na rin sa zip) → Save → **Publish app**.
   3. **Credentials → Create credentials → OAuth client ID → Web application** → sa **Authorized redirect URIs** ilagay ang callback sa A3 → Create.
   4. Kopyahin ang **Client ID** at **Client secret** → ilagay sa Cloudflare (Part A5).

**B7.** **Retry deployment** (isang beses), tapos buksan ang `/api/health?check=1` → dapat puro `true`.

**B8. Test (2 devices):** Sa phone: menu (arrow) → **Continue with Google**. Gumawa ng photo/template, hintayin ≤1 minuto (o **Sync now**).
   Sa iPad/laptop: Continue with Google gamit ang parehong account → lalabas lahat. Walang backup file na kailangan.

---------------------------------------------------------------------------------------------------

## C. Saan makikita kung ano ang mali (logs)

1. **Sa mismong app:** may mensahe na ngayon na nagsasabi ng dahilan at ng `code`.
2. **Sa browser console (F12):** `[DenCloud] Google sign-in failed. reason=...` at kasunod ang listahan ng **OK / FIX** mula sa server check,
   kasama ang eksaktong Redirect URI na kailangan ng Google. Pwede mo ring i-type: `DenCloud.diagnose()`.
3. **Sa Cloudflare:** Pages project → **Logs → Begin log stream** → subukan ulit mag-login. Hanapin ang linyang `"event":"oauth_error"`.
   Nandoon ang `reason`, `detail` (kung ano ang sinabi ng Google), ang `redirectUri` na ginamit, at ang huling bahagi ng Client ID (`clientIdTail`).

## D. Ano ang ibig sabihin ng bawat `code`

| code | Ibig sabihin | Ayusin |
|---|---|---|
| `google_invalid_client` | Hindi tinanggap ng Google ang Client ID o Secret | I-paste ulit ang `GOOGLE_CLIENT_ID` at `GOOGLE_CLIENT_SECRET` (A5), tapos Retry deployment. Dapat **iisang** OAuth client ang pinagkunan ng dalawa. |
| `google_redirect_uri_mismatch` | Hindi kilala ng Google ang address | Idagdag ang eksaktong callback sa Google Cloud (A3). |
| `google_invalid_grant` | Ginamit na / nag-expire ang code, o hindi tugma ang address | Subukan ulit. Kung paulit-ulit, ikumpara ang address (A3). |
| `token_wrong_audience` | Ibang Client ID ang nasa server kaysa sa ginamit sa Google | Ayusin ang `GOOGLE_CLIENT_ID`. |
| `token_wrong_nonce` / `token_expired` / `token_*` | Hindi na-verify ang sign-in token | Subukan ulit; kung paulit-ulit, tingnan ang orasan ng device. |
| `state` + `no_cookie` | Hindi nai-save ng browser ang sign-in cookie | I-allow ang cookies; buksan ang site sa **iisang address** (hal. laging `denphotobooth.online`, hindi halo ng `www`). |
| `state` + `expired` / `mismatch` | Natagalan (10 min) o nagamit na ang link | Ulitin mula sa umpisa. |
| `db` | Tinanggap ka na ng Google, pero **tinanggihan ng database** ang pag-save. Nasa loob ng panaklong ng mensahe ang totoong dahilan (hal. *table users has no column named epoch*) | Ang bagong `_worker.js` ay **kusang nagdadagdag ng kulang na columns**. I-upload ito at subukan ulit. Kung may natitira pang error: D1 → Console → `DROP TABLE users; DROP TABLE identities; DROP TABLE records;` (ligtas kung wala pang nag-sync; kusang ibabalik ng worker ang tamang tables), tapos subukan ulit. |
| `not_configured` | Kulang ang secrets/bindings | Tingnan ang `/api/health?check=1`. |
| `cancelled` | Pinindot ang Cancel sa Google | Normal. |
| `login_failed` | Tinanggap ng Google pero hindi nagawa ang session | Subukan ulit; tingnan ang Cloudflare Logs. |
| `google_*` (iba pa) | Ibang sabi ng Google (nasa `detail` sa log) | Basahin ang `detail` sa Cloudflare Logs. |

**Hindi pa rin?** Kung `access_denied` / "Error 403" ang lumalabas sa mismong Google page: Publishing status pa rin ay *Testing* (A4) o hindi nakalista ang email mo bilang test user.

---------------------------------------------------------------------------------------------------

## E. Ano ang nasa zip (huwag burahin)

| File | Para saan |
|---|---|
| `_worker.js` | Buong backend (isang file, walang build). Hawak lang ang `/api/*`. |
| `_routes.json` | Sinasabing `/api/*` lang ang dadaan sa worker. Hindi dumadaan ang website, kaya **tuloy ang booth kahit may problema ang cloud**. |
| `cloud/den-cloud.js` | Ang Google button, mensahe ng error, at ang sync (browser side). |
| `cloud/schema.sql` | Tala ng mga table (kusang ginagawa na ng worker; hindi mo na kailangang i-run). |
| `cloud/tests/` | Self-tests (optional): `sh cloud/tests/run-tests.sh` |

## F. Future-proofing

- Ang **D1, R2, at secrets ay nasa Cloudflare**, hindi sa zip. Hindi sila nabubura ng bagong upload.
- Pwede mong palitan ang `index.html` ng bagong design anumang oras. Siguraduhin lang na nandoon ang 3 bagay na ito (hanapin sa file):
  1. `<script src="/cloud/den-cloud.js" defer></script>`
  2. `window.DenBridge = {`
  3. `new CustomEvent('den:user'` (dalawang beses)
  Kung may mawala, **walang masisira**; hindi lang lalabas ang Google button hanggang maibalik.
- Sa mga susunod na AI/developer: *"Panatilihin ang DenBridge v1 at ang den:user events; huwag galawin ang `_worker.js`, `_routes.json`, `cloud/`."*
- Sa bawat bagong `index.html` upload, itaas ang `VERSION` sa `sw.js` (gaya ng dati).

## G. Ano ang naka-sync

| Sini-sync | Hindi (device lang) |
|---|---|
| Photo sessions, custom layouts, custom templates | Camera settings, tunog, motion, flash |
| Event name / Welcome screen, Print settings, Theme, Look, Logo | Password ng email-account |
| **Den+ key** (signed code; chine-check pa rin sa device kaya gumagana offline) | |

- Burado sa isang device = burado sa lahat. Parehong na-edit = ang mas bago ang panalo. Ang unang login sa bagong device ay **nagsasama**, walang binubura.
- Hindi nagsi-sync habang nagsho-shoot (Capture page). Offline: tuloy ang booth, mag-sync pagbalik ng internet.
- Guest mode at email/password ay buo pa rin. Ang "Back up / Restore from backup file" ay para sa guest at offline accounts (nakatago lang kapag naka-Google login).
- **Den+ at email:** nakatali ang Den+ key sa **email**. I-issue ang key sa **eksaktong email na nakalagay sa menu** ng customer (ang Google email nila).

## H. Seguridad

- Walang password na iniimbak para sa Google login. Cookie: `HttpOnly`, `Secure`, 30 araw. Lahat ng pagbabago sa data ay may custom header + same-origin check.
- Hiwalay ang data ng bawat user. May **Delete cloud data** button sa menu.
- Mag-logout sa lahat ng device: D1 Console → `UPDATE users SET epoch = epoch + 1 WHERE email = 'tao@example.com';`

## I. Privacy Policy

- Ang file na `privacy.html` (nasa pinakaugat ng zip) ang opisyal na policy: `https://denphotobooth.online/privacy.html`. Ito ang ilalagay sa Google consent screen.
- Ang `terms.html` (nasa pinakaugat din) ang Terms of Service: `https://denphotobooth.online/terms.html`. Ilagay ito sa **Application terms of service link** ng consent screen.
- Sa app, ang link na **Privacy Policy** ay lumalabas sa tabi ng *Show password* (login at create account) at sa kanang-ibaba ng menu kapag naka-login. Nagbubukas ito ng popup.
- Kapag i-edit mo ang `privacy.html`, kusang nag-a-update ang popup kapag may internet (may built-in na kopya para gumana kahit offline).


---------------------------------------------------------------------------------------------------

## E. Sync Now: paano gumagana (bagong ayos)

- **Lahat ng items** (photos, templates, layouts) ay isa-isang ina-upload/dina-download, 3 sabay-sabay, at **bawat matagumpay** ay agad na sine-save. Kung maputol ang internet, ang natitira lang ang uulitin.
- **Nakikita na ang edits** kahit hindi nagbago ang oras ng record (dati, hindi umaabot sa ibang device ang edit).
- Pagkatapos mag-upload, **tinatanong ulit ang cloud** kung nandoon talaga lahat (check-up).
- Ang **Sync now** button: `Syncing...` (may bilang, hal. "4 of 10") → `✓ Synced` → o `Try again` na may dahilan kung may hindi pumasok. Kusa rin itong nagre-retry.
- Kapag **natapos ang login session (401)**: lalabas ang "Sign in again". **Walang binubura** na cookie o local login, at walang logout na tinatawag.
- Ang `bytes` counter ng cloud ay **kusang itinatama** (para hindi magkamali ng "storage full").
- Self-test: `sh cloud/tests/run-tests.sh` (46 worker + 30 browser-module tests).

## F. Google "no_cookie" at "connection dropped" (bagong ayos)

- **Sign-in state (`reason=state detail=no_cookie`):** sa iPhone/iPad na naka-install na app o Private mode, madalas magkaiba ang cookie jar ng app at ng Google page, kaya nawawala ang cookie pagbalik. Ngayon, ang sign-in details ay nasa **cookie AT sa signed `state`** mismo. Kung walang cookie, tinatanggap ang signed state **kung galing sa parehong network** (coarse IP) — kaya protektado pa rin. Ang cookie ay `Secure; HttpOnly; SameSite=Lax; Path=/`.
- **Upload:** ang records ay ipinapadala mula sa memory (hindi file-backed Blob na nagpapa-"Load failed" sa Safari). Ang malalaki (>1.5 MB) ay hinahati sa 1 MB na parts (`/api/sync/chunk/...`); ang pumalyang part lang ang inuulit (hanggang 5 beses). Ang tunay na error ay nasa console (`[DenCloud] upload of ... failed`).
- Walang kailangang baguhin sa Cloudflare dashboard o database.

### G. Staying signed in
The login cookie (`den_session`) now lasts 180 days and is renewed automatically (at most about once a day) whenever the booth checks `/api/me`, so anyone who keeps using the booth is never signed out by the clock. Only "Log out" (or "Delete my cloud data") clears it. A 401 answer is never turned into a cookie change, and the page treats a server hiccup (500 / 503 / 429) as "try again later", not as a logout.

### H. Email + password accounts (nothing to set up)
Email + password accounts now live in the same `users` table and use the same cloud storage and sessions as Google, so a person gets the same photos, layouts and templates on every device. There is nothing new to configure in Cloudflare or Google: the D1 columns (`password_hash`, `auth_provider`, `email_verified`) and the `auth_throttle` table are added automatically the first time the Worker runs, and the existing secrets are reused. The Google sign-in code, its redirect address, ID and secret are not touched.

- Passwords are stored only as salted PBKDF2-SHA256 hashes (100,000 rounds, the most Cloudflare Workers allows). Emails are matched case-insensitively.
- Same email as a Google account: a stranger can NOT attach a password to it. The owner signs in with Google once and taps "Set password" in the menu; after that both log-ins open the same account (`auth_provider = hybrid`).
- If somebody pre-registered an email with a password and the real owner later signs in with Google, that password is cleared and the old log-ins are signed out (nobody ever verified that email).
- Device-only accounts made before this update are moved to the cloud automatically the first time their owner logs in with the password.
- 10 wrong passwords in 15 minutes pauses that email (and network) for a while.
- The photos, layouts and templates themselves stay in R2 with an index in the existing `records` table (this is what the sync already uses).

## I. Long-distance booth ("Join a Booth")

Nothing new to set up. It uses the same D1 database you already bound (`DB`); the two small tables it needs (`booth_rooms`, `booth_msgs`) create themselves the first time someone opens a booth.
The Worker only passes short connection notes between the two phones. Video, voice, chat and the countdown go straight between the devices (WebRTC), and rooms are deleted automatically after 8 hours.
It never reads, sets or clears a login cookie, so Google and email/password sessions are not affected.
Limit to know about: it uses free public STUN servers (Cloudflare and Google). On a very strict network (some offices, schools, mobile carriers) two devices may not be able to reach each other without a TURN relay; Cloudflare Calls/TURN can be added later if that ever shows up.


---------------------------------------------------------------------------------------------------

## E. QR ng event: 24 oras na gumagana kahit lumabas na sa final page (bago)

Dati, **direct sa booth screen** dumadaan ang QR, kaya namamatay ito pag umalis o nag-reset ang booth.
Ngayon, ina-upload ang strip, photos at GIF sa **sarili mong Cloudflare (R2 + D1)** at may **expires_at = 24 oras (86,400 segundo)** mula nang magawa.
Bukas ito ng guest kahit bumalik na ang booth sa welcome screen o may bago nang guest. Pagkalipas ng 24 oras, lalabas ang **"Link expired after 24 hours"**.
**Hindi ginagalaw** nito ang Photo Archive ng host, login, cookies o Google sign-in. Ang pansamantalang share link at mga file nito lang ang nabubura.

**Walang bagong binding, walang bagong secret, walang SQL na ipa-paste.** Gamit pa rin ang `DB` (D1) at `FILES` (R2) na meron ka na.
Ang dalawang bagong table (`shares`, `share_files`) ay **kusang nagagawa** sa unang QR.

### Mga hakbang (≈ 3 minuto)

**1.** Palitan ang mga file sa GitHub (o i-upload ang buong folder sa Cloudflare Pages kung doon ka nag-a-upload): `index.html`, `sw.js`, `_worker.js` at `CLOUD-SETUP.md`.
   Maghintay na matapos ang **Deployment** (Cloudflare Pages → Deployments → dapat "Success").

**2.** Buksan ito sa browser. Dapat puro `"ok": true`:

```
https://denphotobooth.online/api/health?check=1
```

**3. Subukan (1 minuto):** i-launch ang event, kumuha ng photo, pindutin ang **QR**. Dapat may nakasulat na **"Active for 24 hours, until ..."**.
   I-scan gamit ang phone. Pagkatapos, **pindutin ang Restart** sa booth at i-scan ulit ang parehong QR. Dapat bukas pa rin at makaka-download pa rin.

**4. (Optional pero maganda) Panlinis na backup sa R2:** Cloudflare → **R2 Object Storage** → `den-files` → **Settings** → **Object lifecycle rules** → **Add rule**
   - Rule name: `delete-guest-shares`
   - **Prefix: `share/`** (siguraduhing eksakto ito. **Huwag** burahin ang `u/`, nandoon ang Photo Archive ng mga account)
   - Action: **Delete objects after 2 days** → Save

   Kusa nang nagbubura ang worker ng mga expired na file, itong rule ay pangalawang proteksyon lang.

### Kung may problema
- **Walang "Active for 24 hours" sa QR window** → hindi pa na-deploy ang bagong `_worker.js`, o walang internet ang booth. Gagana pa rin ang QR (lumang direct na paraan), pero kailangang bukas ang booth screen.
- **"Link not found"** → mali o putol ang link. I-scan ulit ang QR.
- **"Link expired after 24 hours"** → lumagpas na ng 24 oras. Normal ito. Ang Photo Archive ng host ay buo pa rin.
- Mga limit (para hindi maabuso): hanggang 40 MB bawat file, 150 MB bawat share, at 300 bagong share kada oras bawat network.
