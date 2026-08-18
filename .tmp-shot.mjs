import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', e => errs.push(e.message));
page.on('console', m => { if (m.type()==='error') errs.push(m.text()); });
await page.goto(pathToFileURL('/home/user/PitchProof/.tmp-studio-fixed.html').href);
await page.waitForSelector('.st-app');
await page.waitForTimeout(400);
// build something worth looking at
await page.fill('input[data-st-act="project.setProspect"]', 'Northwind Industrial');
await page.keyboard.press('Alt+Digit3');
await page.waitForTimeout(150);
await page.fill('textarea[data-st-act="specimen.pasteDraft"]', '<!doctype html><html lang=en><head><title>Industrial coatings that hold</title><style>body{color:#16181D;background:#fff;font-family:Inter,Arial,sans-serif}h1{color:#123A8C}a{color:#E2574C}.btn{background:#123A8C;color:#fff;border-radius:6px}</style></head><body><header><nav><a href=/a>Products</a><a href=/b>Services</a><a href=/c>About</a></nav></header><main><h1>Industrial coatings that hold</h1><p>Forty years of protecting steel in places nobody wants to go twice.</p><ul><li>Offshore platforms</li><li>Rail infrastructure</li><li>Bridge spans</li></ul></main><footer><p>Northwind Industrial. All rights reserved.</p></footer></body></html>');
await page.waitForTimeout(150);
await page.getByRole('button', { name: 'Capture from the paste' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: '.tmp-shot-specimens.png' });

await page.keyboard.press('Alt+Digit4');
await page.waitForTimeout(150);
await page.locator('[data-st-act="recipe.loadSeed"]').first().click();
await page.waitForTimeout(250);
await page.fill('textarea[data-st-act="rendition.pasteDraft"]', '# Industrielle Beschichtungen, die halten\n\nVierzig Jahre Stahlschutz an Orten, an die niemand zweimal möchte.\n\n- Offshore-Plattformen\n- Schieneninfrastruktur');
await page.fill('input[data-st-act="rendition.labelDraft"]', 'de-DE');
await page.waitForTimeout(250);
await page.screenshot({ path: '.tmp-shot-recipes.png' });
await page.getByRole('button', { name: 'Create rendition' }).click();
await page.waitForTimeout(300);

await page.keyboard.press('Alt+Digit5');
await page.waitForTimeout(150);
await page.selectOption('select[data-st-act="scene.add"]', 'splitBeforeAfter');
await page.waitForTimeout(500);
const sceneId = await page.getAttribute('[data-st-act="scene.select"]', 'data-st-arg');
await page.fill(`input[data-st-key^="scene-headline"]`, 'Your own page, in nine markets');
await page.waitForTimeout(400);
// attach the rendition
const chip = page.locator('[data-st-act="scene.toggleRendition"]').first();
if (await chip.count()) await chip.click();
await page.waitForTimeout(600);
await page.screenshot({ path: '.tmp-shot-scenes.png' });

await page.keyboard.press('Alt+Digit7');
await page.waitForTimeout(150);
await page.locator('[data-st-act="rehearse.sweep"]').first().click();
await page.waitForTimeout(2500);
await page.screenshot({ path: '.tmp-shot-rehearse.png' });

await page.keyboard.press('Alt+Digit8');
await page.waitForTimeout(300);
await page.screenshot({ path: '.tmp-shot-emit.png' });
console.log('errors:', errs.slice(0,8));
await browser.close();
