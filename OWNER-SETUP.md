# Owner Panel – Setup (Part 1)  ·  Taglish, step by step

Para lang ito sa **densprem02@gmail.com**. Walang bagong server. Walang kailangang i-paste na SQL: gumagawa ng sarili ang bagong table (`den_visits`).

## A. Ano ang ia-upload sa GitHub / Cloudflare Pages
Palitan ang mga file na ito (parehong lugar sa repo):
1. `index.html`
2. `sw.js`
3. `_worker.js`  ← may bagong "Owner access" section (additive lang; hindi ginalaw ang login/session code)
4. `OWNER-SETUP.md` (optional, para sa reference)

Maghintay matapos ang deploy (Cloudflare → Workers & Pages → den project → **Deployments**).

## B. Ang isang kailangan mo: ang SECRET na `DEN_SIGN_JWK`
Ang Den+ key, reset code at restore link ay pini-pirmahan ng **private key** mo (yung gamit ng key maker mo). Hindi ito puwedeng ilagay sa website (kasi makakagawa ng key ang kahit sino). Kaya ilalagay ito bilang **Secret** sa Cloudflare, na ang Worker lang ang nakakabasa.

1. Buksan ang `den-plus-key-maker-PRIVATE.html` mo sa text editor at hanapin ang linyang nagsisimula sa `const JWK={...}`. Kopyahin **ang buong `{ ... }`** (yung may `"kty":"EC","crv":"P-256","x":…,"y":…,"d":…`). Iyon ang private key (JWK). **Huwag itong ibigay kaninuman.**
   - Puwede rin ang PKCS8 na naka-base64 (isang mahabang linya).
   - **Dapat ito ang private key na tugma sa public key ng website** (`BDG-UjAPDeC…`). Kapag mali, sasabihin ng panel: *"The secret key does not match the website key."* Walang masisira.
2. Cloudflare dashboard → **Workers & Pages** → piliin ang **den** project → **Settings** → **Variables and Secrets** → **Add**.
3. **Type: Secret** (hindi Text). **Variable name:** `DEN_SIGN_JWK` (eksakto, malalaking letra).
4. **Value:** i-paste ang buong private key. → **Save**.
5. Pumunta sa **Deployments** → sa pinakabagong deployment, **⋯ → Retry deployment** (para magamit ng Worker ang bagong secret).

Kung hindi mo ilalagay ang secret: gumagana pa rin ang lahat, pati ang "Who visited". Ang tatlong code-maker lang ang may paalalang "not switched on yet".

## C. Paano gamitin
1. Mag-sign in gamit ang **Continue with Google** sa `densprem02@gmail.com` (kailangan Google, hindi password).
2. Buksan ang menu (profile button, kanang itaas) → i-tap ang **pangalan / email mo**.
3. Bubukas ang **Owner panel**:
   - **Who visited**: pangalan, email, huling bisita, ilang beses. Walang litrato o archive, kahit kailan.
   - **Den+ key maker**: email + haba → **Make Den+ key** → **Copy** (o **Copy message** para may kasamang instructions).
   - **Password reset code**: email + tagal → **Make reset code** → Copy.
   - **Account recovery link (no file needed)**: email + pangalan + temporary password (may **Make a password** button) + Den+ days (0 = wala) + oras → **Make recovery link** → Copy link / code / message. Parehong-pareho ito sa private key maker mo: bumabalik ang login at Den+, pero **hindi** ang photos, templates at layouts. Gumagana nang isang beses bawat device.

## D. Proteksyon
- Ang `/api/owner/*` ay sumasagot ng **404** sa lahat maliban sa verified owner (Google login + verified email). Hindi nakikita ng ibang user, kahit tingnan ang network.
- Hindi makakagawa ng account ang sinuman gamit ang `densprem02@gmail.com` sa password sign-up (Worker at app). Google lang.
- Ang owner ay may **lifetime Den+** (hindi na kailangan ng key), basta verified ng server.
- Walang cookies, JWT o Google login na binura o binago.
