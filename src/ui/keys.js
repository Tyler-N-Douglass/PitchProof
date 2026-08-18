/**
 * The studio's keyboard vocabulary.
 *
 * §20.10 has a critic assembling a proof end to end and reporting "every place
 * the flow stalls, requires a mouse where a key would do, or loses work". This
 * module is the answer to the middle clause: a binding is a string on an action,
 * one function turns a `KeyboardEvent` into that string, and the keyboard
 * reference is generated from the same table the router reads — so the help can
 * never describe a key that does not work, and a key can never exist that the
 * help does not describe.
 *
 * `Mod` means Control or Command, so one binding covers both platforms without
 * sniffing one.
 *
 * @module ui/keys
 */

/** Keys whose `event.key` is already the canonical name. */
const NAMED = new Set([
  'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ',
]);

/**
 * Canonical combo string for a keyboard event, or null when the event carries
 * no key (an IME composition, a dead key).
 * @param {any} event
 * @returns {string|null}
 */
export function keyStringOf(event) {
  if (!event || typeof event.key !== 'string' || !event.key) return null;
  if (event.key === 'Dead' || event.isComposing) return null;
  const parts = [];
  if (event.ctrlKey || event.metaKey) parts.push('Mod');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(normalizeKey(event.key));
  return parts.join('+');
}

/**
 * @param {string} key
 * @returns {string}
 */
export function normalizeKey(key) {
  if (key === ' ') return 'Space';
  if (NAMED.has(key)) return key;
  if (key.length === 1) return key.toLowerCase();
  return key;
}

/**
 * Does a combo match any of an action's bindings? Shift is compared only when
 * the binding asks for it, because a binding on a shifted character (`?`) has
 * already had Shift folded into the character by the browser.
 * @param {string} combo
 * @param {string[]|undefined} bindings
 * @returns {boolean}
 */
export function matchesBinding(combo, bindings) {
  if (!bindings || !bindings.length) return false;
  if (bindings.includes(combo)) return true;
  // `Shift+/` arrives as `Shift+/` on some layouts and `?` on others.
  if (combo.endsWith('+/') && bindings.includes(combo.replace(/\+\/$/, '+?'))) return true;
  return false;
}

/**
 * A binding rendered for a human: `Mod+Shift+z` → `['Ctrl', 'Shift', 'Z']`.
 * @param {string} binding
 * @returns {string[]}
 */
export function keyLabel(binding) {
  return String(binding).split('+').map((part) => {
    if (part === 'Mod') return 'Ctrl';
    if (part === 'Alt') return 'Alt';
    if (part === 'Shift') return 'Shift';
    if (part === 'ArrowUp') return '↑';
    if (part === 'ArrowDown') return '↓';
    if (part === 'ArrowLeft') return '←';
    if (part === 'ArrowRight') return '→';
    if (part === 'Space') return 'Space';
    return part.length === 1 ? part.toUpperCase() : part;
  });
}

/**
 * The one-line note that keeps the `Mod` abbreviation honest on a Mac without
 * sniffing the platform.
 */
export const MOD_NOTE = 'Ctrl is Command on macOS.';

/**
 * Group the bound actions for the keyboard reference, preserving the order the
 * registry declares so the reference reads like the flow.
 * @param {{id: string, label: string, group: string, keys?: string[]}[]} actions
 * @returns {{group: string, bindings: {label: string, keys: string[]}[]}[]}
 */
export function bindingGroups(actions) {
  /** @type {Map<string, {label: string, keys: string[]}[]>} */
  const groups = new Map();
  for (const action of actions) {
    if (!action.keys || !action.keys.length) continue;
    if (!groups.has(action.group)) groups.set(action.group, []);
    groups.get(action.group).push({ label: action.label, keys: action.keys });
  }
  return [...groups.entries()].map(([group, bindings]) => ({ group, bindings }));
}
