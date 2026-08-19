import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { registerAllLayouts } from '/home/user/PitchProof/src/scene/index.js';
import { emit } from '/home/user/PitchProof/src/emit/index.js';
import { buildRuntime } from '/home/user/PitchProof/scripts/build.mjs';
import { buildCorpusProof } from '/home/user/PitchProof/test/fixtures/corpus/proof.mjs';
import { corpusClock } from '/home/user/PitchProof/test/fixtures/corpus/index.mjs';
import { BREAKPOINTS } from '/home/user/PitchProof/src/core/contracts.js';
registerAllLayouts();
const proof = await buildCorpusProof();
const rt = buildRuntime();
const result = await emit(proof, proof.emitOptions, { runtimeJs: rt.js, runtimeCss: rt.css, clock: corpusClock() });
const file = '/tmp/claude-0/-home-user-PitchProof/4f4867db-5fdf-5b7b-bf15-0e36c8d8a775/scratchpad/artifact.html';
writeFileSync(file, result.value.html);
console.log('emitted', result.ok, result.value.html.length);

const { chromium } = await import('playwright');
const browser = await chromium.launch();
for (const bp of BREAKPOINTS) {
  const ctx = await browser.newContext({ viewport: { width: bp.width, height: bp.height } });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => !!(window.__PITCHPROOF__ && window.__PITCHPROOF__.runtime), null, { timeout: 20000 });
  const positions = await page.evaluate(() => window.PitchProofRuntime.allPositions(window.__PITCHPROOF__.runtime.deck).map(p => ({ sceneId: p.sceneId, beatIndex: p.beatIndex })));
  for (const pos of positions) {
    if (pos.sceneId !== 'sc_aedb0357bcb3') continue;
    await page.evaluate((p) => window.__PITCHPROOF__.runtime.go({ type: 'goToBeat', sceneId: p.sceneId, beatIndex: p.beatIndex }), pos);
    const out = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.pp-scene [data-pp-tx="deco"]')];
      return els.map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const parent = el.parentElement;
        const pcs = getComputedStyle(parent);
        const range = document.createRange(); range.selectNodeContents(el);
        const rr = range.getBoundingClientRect();
        return { text: el.textContent, clientW: el.clientWidth, scrollW: el.scrollWidth, clientH: el.clientHeight, scrollH: el.scrollHeight,
          rectW: +r.width.toFixed(2), rectH: +r.height.toFixed(2), inkW: +rr.width.toFixed(2),
          display: cs.display, overflow: cs.overflow, minWidth: cs.minWidth, ff: cs.fontFamily, fs: cs.fontSize,
          parentCols: pcs.gridTemplateColumns, parentDisplay: pcs.display };
      });
    });
    const seen = new Set();
    for (const o of out) { const k = o.text; if (seen.has(k)) continue; seen.add(k);
      console.log(bp.id, JSON.stringify(o)); }
    break;
  }
  await ctx.close();
}
await browser.close();
