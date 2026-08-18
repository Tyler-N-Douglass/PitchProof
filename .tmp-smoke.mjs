import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const requests = [];
await page.route('**/*', (route) => {
  const u = route.request().url();
  if (!u.startsWith('file://')) { requests.push(u); return route.abort(); }
  return route.continue();
});
await page.goto(pathToFileURL('/home/user/PitchProof/.tmp-studio-fixed.html').href);
await page.waitForTimeout(2500);
console.log('root text:', (await page.locator('#pp-studio-root').innerText()).slice(0,300));
console.log('errors so far:', errors.slice(0,6));
await page.waitForSelector('.st-app', { timeout: 8000 });
console.log('mounted:', await page.locator('.st-rail-btn').count(), 'rail buttons');

// walk every section by keyboard
for (const k of ['1','2','3','4','5','6','7','8','9']) {
  await page.keyboard.press(`Alt+Digit${k}`);
  await page.waitForTimeout(60);
}
console.log('section after Alt+9:', await page.getAttribute('.st-app', 'data-st-section'));

// type a prospect name
await page.keyboard.press('Alt+Digit1');
await page.waitForTimeout(80);
const prospect = page.locator('input[data-st-act="project.setProspect"]');
await prospect.click();
await prospect.type('Northwind Industrial', { delay: 8 });
await page.waitForTimeout(120);
console.log('prospect value:', await prospect.inputValue());
console.log('caret preserved (focused):', await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('data-st-act')));

// undo should be one step
await page.keyboard.press('Control+z');
await page.waitForTimeout(120);
console.log('after undo:', await prospect.inputValue());

// paste a page and capture a specimen
await page.keyboard.press('Alt+Digit3');
await page.waitForTimeout(80);
const paste = page.locator('textarea[data-st-act="specimen.pasteDraft"]');
await paste.fill('<!doctype html><html lang=en><head><title>Coatings</title><style>body{color:#16181D;background:#fff}h1{color:#123A8C}</style></head><body><header><nav><a href=/a>Products</a><a href=/b>Services</a></nav></header><main><h1>Industrial coatings that hold</h1><p>Forty years of protecting steel.</p></main><footer><p>Northwind Industrial</p></footer></body></html>');
await page.waitForTimeout(120);
await page.getByRole('button', { name: 'Capture from the paste' }).click();
await page.waitForTimeout(400);
console.log('specimen rows:', await page.locator('[data-st-act="specimen.select"]').count());

// add scenes, check the preview iframe renders
await page.keyboard.press('Alt+Digit5');
await page.waitForTimeout(120);
await page.selectOption('select[data-st-act="scene.add"]', 'splitBeforeAfter');
await page.waitForTimeout(500);
const frames = page.frames();
console.log('frames:', frames.length);
const inner = frames.find(f => f !== page.mainFrame());
if (inner) {
  console.log('stage present:', await inner.locator('#pp-stage-root .pp-stage').count());
  console.log('scene html length:', (await inner.locator('#pp-stage-root').innerHTML()).length);
  console.log('artifact vars leaked studio?', (await inner.locator('#pp-stage-root').innerHTML()).includes('--st-'));
}
const box = await page.locator('.st-preview-host').boundingBox();
const fbox = inner ? await page.locator('iframe.st-preview-frame').boundingBox() : null;
console.log('host box', box && `${Math.round(box.width)}x${Math.round(box.height)}`, 'frame box', fbox && `${Math.round(fbox.width)}x${Math.round(fbox.height)}`);

// command palette
await page.keyboard.press('Control+k');
await page.waitForTimeout(120);
await page.keyboard.type('rehearse');
await page.waitForTimeout(120);
console.log('palette matches:', await page.locator('.st-palette-btn').count());
await page.keyboard.press('Escape');

// keyboard reference
await page.keyboard.press('Alt+Slash');
await page.waitForTimeout(120);
console.log('keysheet groups:', await page.locator('.st-keysheet-group').count());
await page.keyboard.press('Escape');

console.log('network attempts:', requests.length, requests.slice(0,5));
console.log('errors:', errors.slice(0, 10));
await page.screenshot({ path: '/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/studio.png', fullPage: false });
await browser.close();
