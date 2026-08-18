import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1720, height: 1000 } });
await page.goto(pathToFileURL('/home/user/PitchProof/.tmp-studio-fixed.html').href);
await page.waitForSelector('.st-app');
await page.waitForTimeout(600);
console.log(await page.evaluate(() => {
  const q = (s) => { const e = document.querySelector(s); return e ? `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)}` : 'none'; };
  return {
    scrollH: document.documentElement.scrollHeight,
    body: q('body'), app: q('.st-app'), bodyGrid: q('.st-body'),
    rail: q('.st-rail'), work: q('.st-work'), canvas: q('.st-canvas'),
    stage: q('.st-canvas-stage'), host: q('.st-preview-host'), inspector: q('.st-inspector'),
    status: q('.st-status'),
  };
}));
await browser.close();
