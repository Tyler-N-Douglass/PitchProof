import { readFileSync } from 'node:fs';
const api = readFileSync('API.md', 'utf8');
const part3 = api.slice(api.indexOf('## Part 3'), api.indexOf('## Part 4'));
const re = /^### (L\d+)[^\n]*—\s*`([^`]+)`\s*$/gm;
const heads = [...part3.matchAll(re)].map(m => ({ lane: m[1], module: m[2], at: m.index }));
const out = {};
heads.forEach((h, i) => {
  const body = part3.slice(h.at, i + 1 < heads.length ? heads[i+1].at : part3.length);
  const fence = body.match(/```js\n([\s\S]*?)```/);
  if (!fence) return;
  const names = new Set();
  for (const line of fence[1].split('\n')) {
    const m = line.match(/^([A-Za-z_$][\w$]*)\s*[(:=]/);
    if (m) names.add(m[1]);
  }
  out[h.module] = [...names];
});
const svc = readFileSync('src/ui/services.js', 'utf8');
const imports = [...svc.matchAll(/^import \* as (\w+) from '\.\.\/(.+?)';$/gm)].map(m => ({ ns: m[1], module: 'src/' + m[2] }));
for (const { ns, module } of imports) {
  const declared = out[module] || [];
  const used = declared.filter(n => new RegExp(`\\b${ns}\\.${n}\\b`).test(svc));
  const unused = declared.filter(n => !used.includes(n));
  console.log(`${module}  (${ns})  declared ${declared.length}  used ${used.length}`);
  if (unused.length) console.log('    NOT CONSUMED:', unused.join(', '));
}
