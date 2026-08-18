// Local proof that the studio is sound once the marker substitution is done
// safely. Identical to scripts/build.mjs `buildStudio`, except each `.replace`
// takes a FUNCTION so `$'`, `$&` and `$\`` in the bundled sources are inserted
// literally instead of being expanded by String.prototype.replace.
import { readFileSync, writeFileSync } from 'node:fs';
import { bundle } from './scripts/lib/bundler.mjs';
import { cssFiles, concatCss, jsStringLiteral, SRC, ROOT } from './scripts/build.mjs';
import { join } from 'node:path';

const runtimeJs = readFileSync(join(ROOT, 'dist', 'pitchproof-runtime.js'), 'utf8');
const runtimeCss = readFileSync(join(ROOT, 'dist', 'pitchproof-runtime.css'), 'utf8');
const { code } = bundle({ entry: join(SRC, 'ui', 'index.js'), root: SRC, global: 'PitchProofStudio' });
const css = concatCss(cssFiles(join(SRC, 'ui')));
const shell = readFileSync(join(SRC, 'ui', 'shell.html'), 'utf8');
const embedded = [
  '<script>',
  'window.__PITCHPROOF_RUNTIME_JS__ = ' + jsStringLiteral(runtimeJs) + ';',
  'window.__PITCHPROOF_RUNTIME_CSS__ = ' + jsStringLiteral(runtimeCss) + ';',
  '</script>',
].join('\n');
const out = shell
  .replace('<!--PITCHPROOF_STYLES-->', () => `<style>\n${css}\n</style>`)
  .replace('<!--PITCHPROOF_RUNTIME-->', () => embedded)
  .replace('<!--PITCHPROOF_SCRIPT-->', () => `<script>\n${code}\n</script>`);
writeFileSync('.tmp-studio-fixed.html', out);
console.log('wrote .tmp-studio-fixed.html', out.length, 'bytes');
