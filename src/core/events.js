/**
 * A minimal synchronous event emitter. Listener order is insertion order, and a
 * listener added during dispatch does not receive the event in flight — both so
 * that a state transition observed by the runtime, the studio and a test looks
 * the same everywhere.
 *
 * @module core/events
 */

export class Emitter {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this.handlers = new Map();
  }

  /**
   * @param {string} type
   * @param {Function} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    let list = this.handlers.get(type);
    if (!list) { list = []; this.handlers.set(type, list); }
    list.push(fn);
    return () => this.off(type, fn);
  }

  /**
   * @param {string} type
   * @param {Function} fn
   */
  once(type, fn) {
    const off = this.on(type, (...args) => { off(); fn(...args); });
    return off;
  }

  /**
   * @param {string} type
   * @param {Function} fn
   */
  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    if (list.length === 0) this.handlers.delete(type);
  }

  /**
   * @param {string} type
   * @param {...unknown} args
   */
  emit(type, ...args) {
    const list = this.handlers.get(type);
    if (!list || list.length === 0) return;
    for (const fn of list.slice()) fn(...args);
  }

  /** Drop every listener. */
  clear() { this.handlers.clear(); }
}
