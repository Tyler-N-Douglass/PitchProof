/**
 * The keyboard model (§12).
 *
 * Keyboard-first is the whole interaction design: a presenter's hands are on a
 * clicker or a laptop keyboard, and every second spent hunting for a control is
 * a second the room spends watching them hunt. So the bindings are a table, not
 * a switch buried in an event handler, and the table is exported — the help
 * overlay renders it, the studio's rehearsal panel renders it, and a test
 * asserts that every key §12 names is bound.
 *
 * Resolution is context-sensitive in exactly two ways, both necessary:
 *   - while a text input has focus (the jump-index search), **only bindings
 *     marked `whileTyping` resolve at all** — which is Escape, and nothing
 *     else. Arrow keys belong to whatever list the field drives; handing them
 *     to the deck would walk the presentation behind the overlay while the
 *     presenter is still typing;
 *   - while an overlay is open, Escape closes it before anything else sees it.
 *
 * @module runtime/keymap
 */

/**
 * @typedef {object} Binding
 * @property {string[]} keys        `KeyboardEvent.key` values that trigger it
 * @property {string} command
 * @property {string} label         shown in the help overlay
 * @property {string} group
 * @property {boolean} [whileTyping] usable while a text input has focus
 */

/** Every runtime binding. The order here is the order the help overlay shows. */
export const BINDINGS = /** @type {Binding[]} */ ([
  { keys: ['ArrowRight', ' ', 'Spacebar', 'PageDown'], command: 'nextBeat', label: 'Next beat', group: 'Navigate' },
  { keys: ['ArrowLeft', 'PageUp'], command: 'prevBeat', label: 'Previous beat', group: 'Navigate' },
  { keys: ['ArrowDown'], command: 'nextScene', label: 'Next scene', group: 'Navigate' },
  { keys: ['ArrowUp'], command: 'prevScene', label: 'Previous scene', group: 'Navigate' },
  { keys: ['Home'], command: 'firstScene', label: 'First scene', group: 'Navigate' },
  { keys: ['End'], command: 'lastScene', label: 'Last scene', group: 'Navigate' },
  { keys: ['/'], command: 'openJump', label: 'Jump to an objection', group: 'Branch' },
  { keys: ['m', 'M'], command: 'toggleMap', label: 'Branch map', group: 'Branch' },
  { keys: ['r', 'R'], command: 'returnToSpine', label: 'Return to the spine', group: 'Branch' },
  // §11 keeps a return stack so nested jumps unwind correctly, and the reducer
  // has always supported popping one frame — but nothing in the product could
  // reach it, so a presenter two branches deep could only unwind all the way or
  // not at all. Backspace pops one level, which is what "unwind correctly"
  // means when you are inside a branch that was reached from another branch.
  { keys: ['Backspace'], command: 'returnOnce', label: 'Back one branch level', group: 'Branch' },
  { keys: ['b', 'B'], command: 'toggleBlank', label: 'Blank the screen', group: 'Present' },
  { keys: ['p', 'P'], command: 'togglePresenter', label: 'Presenter view', group: 'Present' },
  { keys: ['c', 'C'], command: 'toggleContents', label: 'Contents', group: 'Present' },
  { keys: ['?'], command: 'toggleHelp', label: 'Keyboard help', group: 'Present' },
  { keys: ['f', 'F'], command: 'toggleFullscreen', label: 'Full screen', group: 'Present' },
  { keys: ['Escape', 'Esc'], command: 'escape', label: 'Close overlay', group: 'Present', whileTyping: true },
]);

/** @type {Map<string, Binding>} */
const INDEX = (() => {
  const m = new Map();
  for (const b of BINDINGS) for (const k of b.keys) if (!m.has(k)) m.set(k, b);
  return m;
})();

/**
 * @typedef {object} KeyContext
 * @property {string|null} overlay      the open overlay id, if any
 * @property {boolean} typing           a text input has focus
 * @property {boolean} [blanked]
 */

/**
 * Resolve a keyboard event to a runtime command.
 *
 * Returns null when the runtime should not act — which is not the same as
 * "unbound". A modified keypress (Ctrl, Meta, Alt) is always the browser's or
 * the operating system's; intercepting Cmd-R in a proof someone is presenting
 * from would be a memorable way to lose a room.
 *
 * @param {{key: string, ctrlKey?: boolean, metaKey?: boolean, altKey?: boolean, shiftKey?: boolean}} event
 * @param {KeyContext} [context]
 * @returns {{command: string, binding: Binding}|null}
 */
export function resolveKey(event, context = { overlay: null, typing: false }) {
  if (!event || typeof event.key !== 'string') return null;
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const binding = INDEX.get(event.key);
  if (!binding) return null;

  // While a text field has focus the runtime keeps only what it must: Escape.
  // Everything else — including the arrows — belongs to the control the field
  // drives. L9's jump overlay intercepts them in the capture phase as well, so
  // this is the inner of two defences rather than the only one.
  if (context.typing && !binding.whileTyping) return null;

  // While the screen is blanked, only the keys that can un-blank it or open the
  // presenter view respond. A stray arrow key must not advance the deck behind
  // a blank screen, or the presenter un-blanks onto a slide nobody expected.
  if (context.blanked && !['toggleBlank', 'escape', 'togglePresenter', 'toggleHelp'].includes(binding.command)) {
    return null;
  }

  return { command: binding.command, binding };
}

/**
 * Bindings grouped for the help overlay, in declaration order.
 * @returns {{group: string, bindings: Binding[]}[]}
 */
export function bindingGroups() {
  /** @type {{group: string, bindings: Binding[]}[]} */
  const out = [];
  for (const b of BINDINGS) {
    let g = out.find((x) => x.group === b.group);
    if (!g) { g = { group: b.group, bindings: [] }; out.push(g); }
    g.bindings.push(b);
  }
  return out;
}

/**
 * A human-readable rendering of a binding's keys, for the help overlay.
 * @param {Binding} binding
 * @returns {string}
 */
export function keyLabel(binding) {
  const pretty = {
    ArrowRight: '→', ArrowLeft: '←', ArrowUp: '↑', ArrowDown: '↓',
    ' ': 'Space', Spacebar: 'Space', Escape: 'Esc', Esc: 'Esc',
    PageDown: 'PgDn', PageUp: 'PgUp',
  };
  const seen = [];
  for (const k of binding.keys) {
    const label = pretty[k] || (k.length === 1 ? k.toUpperCase() : k);
    if (!seen.includes(label)) seen.push(label);
  }
  return seen.join(' / ');
}

/**
 * Every command the keymap can produce. The runtime asserts it handles all of
 * them, so adding a binding without wiring it fails a test rather than doing
 * nothing on stage.
 * @returns {string[]}
 */
export function allCommands() {
  return [...new Set(BINDINGS.map((b) => b.command))];
}
