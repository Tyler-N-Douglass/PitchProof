/**
 * Display formatting for the studio.
 *
 * Everything here is a pure string/number function. Nothing reads a clock: an
 * ISO timestamp is formatted by slicing the string, never by parsing it into a
 * `Date` and asking the host for a locale, because two machines must render the
 * same project identically (§5) and `test/ui/*` asserts that the same state
 * renders byte-identical HTML twice.
 *
 * @module ui/format
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Byte counts the way a seller reads them: three significant figures, decimal
 * steps, never a bare number of bytes above a kilobyte.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const neg = n < 0;
  let v = Math.abs(n);
  if (v < 1000) return `${neg ? '-' : ''}${Math.round(v)} B`;
  // Decimal, not binary. §4 sets the size budget as `maxBytes: 25_000_000`, the
  // emit panel takes it in MB, and browsers report storage quotas the same way.
  // Showing 25,000,000 as "23.8 MB" next to a field the user typed 25 into is a
  // small lie that costs trust for nothing.
  const units = ['kB', 'MB', 'GB', 'TB'];
  let u = -1;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u += 1; }
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${neg ? '-' : ''}${v.toFixed(digits)} ${units[u]}`;
}

/**
 * A signed byte delta, for degradation line items.
 * @param {number} n
 * @returns {string}
 */
export function formatDelta(n) {
  if (!Number.isFinite(n) || n === 0) return '0 B';
  return `${n > 0 ? '+' : '−'}${formatBytes(Math.abs(n))}`;
}

/**
 * A contrast ratio, always two decimals so a column of them lines up.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatRatio(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}:1`;
}

/**
 * A 0..1 confidence or fraction as a percentage.
 * @param {number|null|undefined} n
 * @param {number} [digits]
 * @returns {string}
 */
export function formatPercent(n, digits = 0) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * A metric delta (1.0 means the fallback matches the requested face exactly).
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function formatMetric(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `×${n.toFixed(3)}`;
}

/**
 * `2026-02-01T09:00:00.000Z` → `1 Feb 2026`. String slicing only.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatDate(iso) {
  if (typeof iso !== 'string' || iso.length < 10) return '—';
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  if (!MONTHS[m - 1] || !Number.isFinite(d)) return iso;
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/**
 * `2026-02-01T09:00:00.000Z` → `1 Feb 2026, 09:00`.
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatDateTime(iso) {
  if (typeof iso !== 'string' || iso.length < 16) return formatDate(iso);
  return `${formatDate(iso)}, ${iso.slice(11, 16)}`;
}

/**
 * Whole days between two ISO instants, floor. Used for `STALE_CAPTURE` display;
 * both ends are supplied, so nothing here reads a clock.
 * @param {string} fromIso
 * @param {string} toIso
 * @returns {number|null}
 */
export function daysBetween(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.floor((b - a) / 86400000);
}

/**
 * Shorten for a list row without cutting mid-word when it can be helped.
 * @param {string|null|undefined} s
 * @param {number} max
 * @returns {string}
 */
export function truncate(s, max) {
  const text = String(s ?? '');
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * `n item` / `n items`.
 * @param {number} n
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many || `${one}s`}`;
}

/**
 * `splitBeforeAfter` → `Split before/after`, for layout and role labels.
 * @param {string} s
 * @returns {string}
 */
export function humanize(s) {
  const spaced = String(s || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim();
  if (!spaced) return '';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase()
    .replace(/\bbefore after\b/, 'before/after');
}

/**
 * A short, stable display form of an id: the prefix and the first six hex
 * digits, which is enough to tell two rows apart without eating the column.
 * @param {string|null|undefined} id
 * @returns {string}
 */
export function shortId(id) {
  if (typeof id !== 'string' || !id) return '—';
  const i = id.indexOf('_');
  if (i < 0) return id.slice(0, 8);
  return `${id.slice(0, i)}_${id.slice(i + 1, i + 7)}`;
}

/**
 * Severity as the word a person reads, not the integer.
 * @param {1|2|3} severity
 * @returns {string}
 */
export function severityLabel(severity) {
  return severity === 1 ? 'Blocking' : severity === 2 ? 'Warning' : 'Note';
}

/**
 * The single sentence explaining what a severity means for the emit.
 * @param {1|2|3} severity
 * @returns {string}
 */
export function severityMeaning(severity) {
  if (severity === 1) return 'Blocks the emit. There is no override.';
  if (severity === 2) return 'Does not block the emit. Fix it if you can.';
  return 'Informational.';
}

/**
 * A percentage bar width clamped to 0..100 for inline meters.
 * @param {number} ratio
 * @returns {string}
 */
export function barWidth(ratio) {
  const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0;
  return `${(r * 100).toFixed(1)}%`;
}
