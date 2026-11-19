const { chromium } = require('playwright');
(async()=>{const b=await chromium.launch();const pg=await (await b.newContext({viewport:{width:400,height:850}})).newPage();
await pg.addInitScript(()=>{try{localStorage.setItem('den.accounts',JSON.stringify({'a@b.co':{name:'T',email:'a@b.co'}}));localStorage.setItem('den.session',JSON.stringify('a@b.co'));}catch(e){}});
await pg.goto('file:///home/claude/den4/index.html');await pg.waitForTimeout(1800);await pg.click('#profileBtn');await pg.click('#menuTheme').catch(async()=>{await pg.evaluate(()=>document.getElementById('menuTheme').click())});await pg.waitForTimeout(500);await pg.screenshot({path:'th.png'});await b.close();})();
