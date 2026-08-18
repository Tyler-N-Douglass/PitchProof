/**
 * A tiny Result type. Ingest, import and emit all have failure paths that are
 * expected rather than exceptional — a CORS refusal is not a bug — and §6
 * requires those to degrade quietly rather than dead-end.
 *
 * @module core/result
 * @template T
 * @typedef {{ ok: true, value: T } | { ok: false, error: string, detail?: unknown }} Result
 */

/**
 * @template T
 * @param {T} value
 * @returns {{ok: true, value: T}}
 */
export const ok = (value) => ({ ok: true, value });

/**
 * @param {string} error
 * @param {unknown} [detail]
 * @returns {{ok: false, error: string, detail?: unknown}}
 */
export const err = (error, detail) => (detail === undefined ? { ok: false, error } : { ok: false, error, detail });

/**
 * Run a function, converting a thrown error into an `err`.
 * @template T
 * @param {() => T} fn
 * @returns {{ok: true, value: T} | {ok: false, error: string, detail?: unknown}}
 */
export function attempt(fn) {
  try { return ok(fn()); } catch (e) { return err(e instanceof Error ? e.message : String(e), e); }
}

/**
 * Async variant.
 * @template T
 * @param {() => Promise<T>} fn
 */
export async function attemptAsync(fn) {
  try { return ok(await fn()); } catch (e) { return err(e instanceof Error ? e.message : String(e), e); }
}
