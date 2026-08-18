/**
 * The undo/redo command stack (§15).
 *
 * §15 calls undo/redo "required, not optional, because scene assembly is
 * destructive editing under time pressure". That framing sets the design:
 *
 *   - Every model mutation goes through `CommandStack.run`. There is no other
 *     writer. The studio holds no second path to the model.
 *   - A command carries `apply` and `revert` as pure state → state functions,
 *     so undo is exact rather than approximate, and a command can be replayed
 *     against a rebuilt state (which is what makes the auto-fix log in §14
 *     reversible).
 *   - Commands may coalesce. Typing a headline one character at a time must not
 *     bury the previous real edit under forty undo steps, so a command declares
 *     a `coalesceKey`, and two adjacent commands with the same key merge into
 *     one entry whose `revert` restores the state before the first.
 *
 * Nothing here reads a clock or a random source; a stack replays identically.
 *
 * @module core/command
 */

import { Emitter } from './events.js';

/**
 * @template S
 * @typedef {object} Command
 * @property {string} label            shown in the undo menu, imperative ("Add scene")
 * @property {(state: S) => S} apply
 * @property {(state: S) => S} revert
 * @property {string} [coalesceKey]    adjacent commands sharing a key merge
 * @property {string} [scope]          which panel produced it, for the UI
 * @property {unknown} [meta]          lane-specific payload (auto-fix records use this)
 */

/**
 * @template S
 * @typedef {object} StackEntry
 * @property {string} label
 * @property {string|undefined} coalesceKey
 * @property {string|undefined} scope
 * @property {unknown} meta
 * @property {(state: S) => S} apply
 * @property {(state: S) => S} revert
 * @property {number} seq
 */

/**
 * An undo/redo stack over an immutable state value.
 * @template S
 */
export class CommandStack extends Emitter {
  /**
   * @param {S} initialState
   * @param {object} [options]
   * @param {number} [options.limit]  maximum retained undo entries
   */
  constructor(initialState, options = {}) {
    super();
    /** @type {S} */
    this.state = initialState;
    /** @type {StackEntry<S>[]} */
    this.undoStack = [];
    /** @type {StackEntry<S>[]} */
    this.redoStack = [];
    this.limit = options.limit ?? 500;
    this.seq = 0;
    /** @type {number} nesting depth of `transaction` */
    this.txDepth = 0;
    /** @type {Command<S>[] | null} */
    this.txBuffer = null;
    /** True while an undo/redo is executing; suppresses coalescing. */
    this.replaying = false;
  }

  /** @returns {boolean} */
  get canUndo() { return this.undoStack.length > 0; }
  /** @returns {boolean} */
  get canRedo() { return this.redoStack.length > 0; }
  /** @returns {string|null} */
  get undoLabel() { return this.canUndo ? this.undoStack[this.undoStack.length - 1].label : null; }
  /** @returns {string|null} */
  get redoLabel() { return this.canRedo ? this.redoStack[this.redoStack.length - 1].label : null; }

  /**
   * Execute a command, push it onto the undo stack, and clear redo.
   * @param {Command<S>} command
   * @returns {S} the new state
   */
  run(command) {
    if (typeof command?.apply !== 'function' || typeof command?.revert !== 'function') {
      throw new Error('CommandStack.run: command needs apply and revert');
    }
    if (this.txBuffer) { this.txBuffer.push(command); this.state = command.apply(this.state); return this.state; }

    const before = this.state;
    const after = command.apply(before);
    this.state = after;
    this.redoStack.length = 0;

    const top = this.undoStack[this.undoStack.length - 1];
    if (
      !this.replaying
      && command.coalesceKey
      && top
      && top.coalesceKey === command.coalesceKey
    ) {
      // Merge: keep the earlier revert (back to before the first of the run),
      // adopt the later apply, so redo replays straight to the final state.
      const firstRevert = top.revert;
      const lastApply = command.apply;
      top.apply = lastApply;
      top.revert = firstRevert;
      top.label = command.label;
      top.meta = command.meta;
      this.emit('change', { kind: 'coalesce', label: top.label, state: after });
      return after;
    }

    this.undoStack.push({
      label: command.label,
      coalesceKey: command.coalesceKey,
      scope: command.scope,
      meta: command.meta,
      apply: command.apply,
      revert: command.revert,
      seq: ++this.seq,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.emit('change', { kind: 'run', label: command.label, state: after });
    return after;
  }

  /**
   * Group several commands into one undo entry. The group is atomic: if the
   * body throws, the state is restored and nothing lands on the stack.
   * @param {string} label
   * @param {() => void} body
   * @param {{scope?: string, meta?: unknown}} [options]
   * @returns {S}
   */
  transaction(label, body, options = {}) {
    if (this.txDepth > 0) { this.txDepth++; try { body(); } finally { this.txDepth--; } return this.state; }
    const before = this.state;
    this.txBuffer = [];
    this.txDepth = 1;
    let buffered;
    try {
      body();
      buffered = this.txBuffer;
    } catch (e) {
      this.state = before;
      this.txBuffer = null;
      this.txDepth = 0;
      throw e;
    } finally {
      if (this.txBuffer) { buffered = this.txBuffer; }
      this.txBuffer = null;
      this.txDepth = 0;
    }
    if (!buffered || buffered.length === 0) { this.state = before; return before; }
    const after = this.state;
    this.state = before;
    // A grouped entry deliberately has no coalesceKey: merging two groups would
    // make the label lie about what a single undo actually reverses.
    return this.run({
      label,
      scope: options.scope,
      meta: options.meta,
      apply: () => after,
      revert: () => before,
    });
  }

  /**
   * Undo one entry.
   * @returns {S}
   */
  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return this.state;
    this.replaying = true;
    try { this.state = entry.revert(this.state); } finally { this.replaying = false; }
    this.redoStack.push(entry);
    this.emit('change', { kind: 'undo', label: entry.label, state: this.state });
    return this.state;
  }

  /**
   * Redo one entry.
   * @returns {S}
   */
  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return this.state;
    this.replaying = true;
    try { this.state = entry.apply(this.state); } finally { this.replaying = false; }
    this.undoStack.push(entry);
    this.emit('change', { kind: 'redo', label: entry.label, state: this.state });
    return this.state;
  }

  /**
   * Undo repeatedly until a predicate is satisfied or the stack empties. Used
   * by "revert all auto-fixes".
   * @param {(entry: StackEntry<S>) => boolean} stopBefore
   */
  undoUntil(stopBefore) {
    while (this.undoStack.length) {
      const top = this.undoStack[this.undoStack.length - 1];
      if (stopBefore(top)) break;
      this.undo();
    }
    return this.state;
  }

  /**
   * Replace the state without touching history. Used when a project is loaded
   * from storage — a load is not an edit.
   * @param {S} state
   */
  reset(state) {
    this.state = state;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.emit('change', { kind: 'reset', label: null, state });
    return state;
  }

  /**
   * The undo history as plain data, newest last. The studio renders this and
   * the auto-fix log reads `meta` from it.
   * @returns {{label: string, scope: string|undefined, meta: unknown, seq: number}[]}
   */
  history() {
    return this.undoStack.map((e) => ({ label: e.label, scope: e.scope, meta: e.meta, seq: e.seq }));
  }
}

/**
 * Build a command that replaces the whole state with the result of a producer.
 * The common case: a reducer over an immutable proof.
 * @template S
 * @param {string} label
 * @param {S} before
 * @param {S} after
 * @param {{coalesceKey?: string, scope?: string, meta?: unknown}} [options]
 * @returns {Command<S>}
 */
export function replaceCommand(label, before, after, options = {}) {
  return {
    label,
    apply: () => after,
    revert: () => before,
    coalesceKey: options.coalesceKey,
    scope: options.scope,
    meta: options.meta,
  };
}

/**
 * Build a command from a pure updater by capturing the prior state. This is the
 * ergonomic form lanes use: `stack.run(editCommand('Rename scene', s => ({...})))`
 * is not possible without the current state, so the helper takes it.
 * @template S
 * @param {string} label
 * @param {S} current
 * @param {(state: S) => S} updater
 * @param {{coalesceKey?: string, scope?: string, meta?: unknown}} [options]
 * @returns {Command<S>}
 */
export function editCommand(label, current, updater, options = {}) {
  const after = updater(current);
  return replaceCommand(label, current, after, options);
}
