const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const pg = await (await b.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
  const errs = []; pg.on('pageerror', e => errs.push(e.message));
  await pg.goto('file:///home/claude/den4/index.html'); await pg.waitForTimeout(2000);
  // count oscillator/buffer-source starts to prove sounds fire
  await pg.evaluate(() => { window.__n = 0; const AC = window.AudioContext; const o = AC.prototype.createOscillator; AC.prototype.createOscillator = function () { const x = o.call(this); const st = x.start.bind(x); x.start = (...a) => { window.__n++; return st(...a); }; return x; }; const bs = AC.prototype.createBufferSource; AC.prototype.createBufferSource = function () { const x = bs.call(this); const st = x.start.bind(x); x.start = (...a) => { window.__n++; return st(...a); }; return x; }; });
  await pg.mouse.click(600, 450); await pg.waitForTimeout(300);
  const fire = async (id, label) => { const before = await pg.evaluate(() => window.__n); await pg.evaluate((id) => { const el = document.getElementById(id); el.hidden = false; el.disabled = false; el.click(); }, id).catch(()=>{}); await pg.waitForTimeout(250); console.log(label, 'nodes started:', (await pg.evaluate(() => window.__n)) - before); };
  await fire('toEditBtn', 'edit'); await fire('printBtn', 'print'); await fire('captureBack', 'back'); await fire('thBack', 'sub-back');
  const b4 = await pg.evaluate(() => window.__n); await pg.evaluate(() => DenSfx.printing(4800)); await pg.waitForTimeout(300); console.log('printing sound nodes:', (await pg.evaluate(() => window.__n)) - b4);
  console.log(errs.join('\n') || 'no page errors'); await b.close();
})();
