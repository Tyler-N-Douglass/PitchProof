/**
 * §4 / §20.1: the frozen contracts cannot drift.
 *
 * `test/fixtures/frozen-contracts.txt` is the spec's §4 `ts` block extracted
 * byte-for-byte. `src/core/contracts.d.ts` must reproduce it exactly inside its
 * FROZEN REGION markers. A lane that renames, retypes or removes a field fails
 * here, which is what turns "frozen" from a social rule into a build failure
 * (DECISIONS D2).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const dts = readFileSync(resolve(ROOT, 'src/core/contracts.d.ts'), 'utf8');
const frozen = readFileSync(resolve(ROOT, 'test/fixtures/frozen-contracts.txt'), 'utf8');
const spec = readFileSync(resolve(ROOT, 'PITCHPROOF-BUILD-SPEC-v1.0.md'), 'utf8');

/** @param {string} s @returns {string} */
const norm = (s) => s.replace(/\r\n/g, '\n').trim();

test('the fixture is the spec §4 block, byte for byte', () => {
  const start = spec.indexOf('```ts');
  const end = spec.indexOf('```', start + 5);
  assert.ok(start > 0 && end > start, 'spec §4 ts block not found');
  const fromSpec = spec.slice(start + 6, end);
  assert.equal(norm(fromSpec), norm(frozen));
});

test('contracts.d.ts frozen region matches the fixture', () => {
  const begin = dts.indexOf('FROZEN REGION BEGIN');
  const endMarker = dts.indexOf('FROZEN REGION END');
  assert.ok(begin > 0, 'FROZEN REGION BEGIN marker missing');
  assert.ok(endMarker > begin, 'FROZEN REGION END marker missing');
  const afterBegin = dts.indexOf('\n', dts.indexOf('*/', begin));
  const region = dts.slice(afterBegin + 1, dts.lastIndexOf('/*', endMarker));
  assert.equal(norm(region), norm(frozen));
});

test('extensions below the END marker add nothing required', () => {
  const endMarker = dts.indexOf('FROZEN REGION END');
  const tail = dts.slice(endMarker);
  // Every field an extension adds to a frozen interface must be optional.
  const reopened = [...tail.matchAll(/export interface (\w+)/g)].map((m) => m[1]);
  const frozenNames = [...frozen.matchAll(/export interface (\w+)/g)].map((m) => m[1]);
  for (const name of reopened) {
    assert.ok(!frozenNames.includes(name), `extension re-declares frozen interface ${name}`);
  }
});

test('the runtime companions enumerate exactly the frozen unions', async () => {
  const c = await import('../../src/core/contracts.js');
  /** @param {string} typeName @returns {string[]} */
  const unionOf = (typeName) => {
    const m = frozen.match(new RegExp(`export type ${typeName} =([\\s\\S]*?);`));
    assert.ok(m, `union ${typeName} not found in frozen contracts`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  assert.deepEqual([...c.COLOR_ROLES].sort(), unionOf('ColorRole').sort());
  assert.deepEqual([...c.SPECIMEN_KINDS].sort(), unionOf('SpecimenKind').sort());
  assert.deepEqual([...c.SCENE_LAYOUTS].sort(), unionOf('SceneLayout').sort());
  assert.deepEqual([...c.PROVENANCE_VALUES].sort(), unionOf('Provenance').sort());
  assert.deepEqual([...c.FINDING_CODES].sort(), unionOf('FindingCode').sort());
});

test('every ColorRole has a declared pair and every foreground role is covered', async () => {
  const c = await import('../../src/core/contracts.js');
  for (const role of c.COLOR_ROLES) {
    assert.ok(role in c.ROLE_PAIR, `ROLE_PAIR is missing ${role}`);
  }
  for (const fg of c.FOREGROUND_ROLES) {
    const bg = c.ROLE_PAIR[fg];
    assert.ok(c.BACKGROUND_ROLES.includes(bg), `${fg} must pair with a background role, got ${bg}`);
  }
});
