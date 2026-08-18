/**
 * §15: undo/redo across all model mutations. "Required, not optional, because
 * scene assembly is destructive editing under time pressure" — so the stack has
 * to be exact, not approximate, and grouped edits have to undo as one act.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandStack, editCommand, replaceCommand } from '../../src/core/command.js';

const inc = (stack, by = 1, opts) => stack.run(editCommand(`+${by}`, stack.state, (s) => ({ ...s, n: s.n + by }), opts));

test('run/undo/redo restores exact prior states', () => {
  const s = new CommandStack({ n: 0 });
  inc(s, 1); inc(s, 10); inc(s, 100);
  assert.equal(s.state.n, 111);
  s.undo(); assert.equal(s.state.n, 11);
  s.undo(); assert.equal(s.state.n, 1);
  s.undo(); assert.equal(s.state.n, 0);
  assert.equal(s.canUndo, false);
  s.undo(); assert.equal(s.state.n, 0, 'undo on an empty stack is a no-op');
  s.redo(); s.redo(); s.redo();
  assert.equal(s.state.n, 111);
  assert.equal(s.canRedo, false);
});

test('a new command clears the redo stack', () => {
  const s = new CommandStack({ n: 0 });
  inc(s, 1); inc(s, 2);
  s.undo();
  assert.equal(s.canRedo, true);
  inc(s, 5);
  assert.equal(s.canRedo, false);
  assert.equal(s.state.n, 6);
});

test('adjacent commands with the same coalesce key merge into one undo step', () => {
  const s = new CommandStack({ title: '' });
  for (const ch of 'Northwind') {
    s.run(editCommand('Edit headline', s.state, (v) => ({ title: v.title + ch }), { coalesceKey: 'headline:sc_1' }));
  }
  assert.equal(s.state.title, 'Northwind');
  assert.equal(s.history().length, 1, 'nine keystrokes must be one undo step');
  s.undo();
  assert.equal(s.state.title, '');
  s.redo();
  assert.equal(s.state.title, 'Northwind', 'redo must replay to the final coalesced state');
});

test('a different coalesce key breaks the merge', () => {
  const s = new CommandStack({ a: '', b: '' });
  s.run(editCommand('A', s.state, (v) => ({ ...v, a: 'x' }), { coalesceKey: 'a' }));
  s.run(editCommand('A', s.state, (v) => ({ ...v, a: 'xy' }), { coalesceKey: 'a' }));
  s.run(editCommand('B', s.state, (v) => ({ ...v, b: 'z' }), { coalesceKey: 'b' }));
  assert.equal(s.history().length, 2);
  s.undo();
  assert.deepEqual(s.state, { a: 'xy', b: '' });
});

test('undo does not coalesce with the command that follows it', () => {
  const s = new CommandStack({ n: 0 });
  inc(s, 1, { coalesceKey: 'k' });
  inc(s, 1, { coalesceKey: 'k' });
  s.undo();
  assert.equal(s.state.n, 0);
  inc(s, 5, { coalesceKey: 'k' });
  assert.equal(s.state.n, 5);
  s.undo();
  assert.equal(s.state.n, 0);
});

test('a transaction is one undo entry and is atomic on throw', () => {
  const s = new CommandStack({ n: 0, scenes: [] });
  s.transaction('Add scene with beats', () => {
    s.run(editCommand('scene', s.state, (v) => ({ ...v, scenes: [...v.scenes, 'sc_1'] })));
    s.run(editCommand('beat', s.state, (v) => ({ ...v, n: v.n + 3 })));
  });
  assert.deepEqual(s.state, { n: 3, scenes: ['sc_1'] });
  assert.deepEqual(s.history().map((e) => e.label), ['Add scene with beats']);
  s.undo();
  assert.deepEqual(s.state, { n: 0, scenes: [] });
  s.redo();
  assert.deepEqual(s.state, { n: 3, scenes: ['sc_1'] });

  assert.throws(() => s.transaction('Broken', () => {
    s.run(editCommand('half', s.state, (v) => ({ ...v, n: 99 })));
    throw new Error('boom');
  }), /boom/);
  assert.deepEqual(s.state, { n: 3, scenes: ['sc_1'] }, 'a failed transaction leaves no trace');
  assert.equal(s.history().length, 1);
});

test('an empty transaction adds nothing', () => {
  const s = new CommandStack({ n: 1 });
  s.transaction('Nothing', () => {});
  assert.equal(s.history().length, 0);
  assert.deepEqual(s.state, { n: 1 });
});

test('nested transactions collapse into the outermost entry', () => {
  const s = new CommandStack({ n: 0 });
  s.transaction('Outer', () => {
    inc(s, 1);
    s.transaction('Inner', () => { inc(s, 2); inc(s, 4); });
  });
  assert.equal(s.state.n, 7);
  assert.deepEqual(s.history().map((e) => e.label), ['Outer']);
  s.undo();
  assert.equal(s.state.n, 0);
});

test('the stack reports labels and emits change events', () => {
  const s = new CommandStack({ n: 0 });
  const events = [];
  s.on('change', (e) => events.push(e.kind));
  inc(s, 1);
  assert.equal(s.undoLabel, '+1');
  assert.equal(s.redoLabel, null);
  s.undo();
  assert.equal(s.redoLabel, '+1');
  s.redo();
  s.reset({ n: 0 });
  assert.deepEqual(events, ['run', 'undo', 'redo', 'reset']);
  assert.equal(s.canUndo, false, 'a project load is not an edit');
});

test('the history carries the metadata the auto-fix log needs (§14)', () => {
  const s = new CommandStack({ colors: [] });
  s.run(replaceCommand('Derive onPrimary for contrast', s.state, { colors: ['#fff'] }, {
    scope: 'brand',
    meta: { autoFix: true, finding: 'CONTRAST_FAIL', role: 'onPrimary' },
  }));
  const [entry] = s.history();
  assert.equal(entry.scope, 'brand');
  assert.deepEqual(entry.meta, { autoFix: true, finding: 'CONTRAST_FAIL', role: 'onPrimary' });
  s.undoUntil((e) => !(e.meta && e.meta.autoFix));
  assert.deepEqual(s.state, { colors: [] }, 'every auto-fix must be undoable');
});

test('the stack honours its retention limit', () => {
  const s = new CommandStack({ n: 0 }, { limit: 5 });
  for (let i = 0; i < 20; i++) inc(s, 1);
  assert.equal(s.history().length, 5);
  assert.equal(s.state.n, 20);
});

test('a command missing apply or revert is rejected at the boundary', () => {
  const s = new CommandStack({ n: 0 });
  assert.throws(() => s.run(/** @type {any} */ ({ label: 'bad', apply: (x) => x })), /apply and revert/);
});
