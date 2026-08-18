/**
 * Row alignment between a specimen and its renditions.
 *
 * `splitBeforeAfter` is the workhorse of the whole product, and what makes it
 * persuasive is not that two panels sit next to each other — it is that the
 * client's own H1 sits on the same line as its rendition's H1, so the eye
 * compares like with like without being told to. That is the job here: turn
 * two (or more) block lists into an ordered set of *rows*, each row holding at
 * most one block per column.
 *
 * The method is a longest-common-subsequence over block *signatures* (type plus
 * heading level), which anchors the structural landmarks — headings, tables,
 * media — and then zips the runs between anchors positionally so a paragraph
 * lines up with the paragraph that replaced it. Nothing is dropped: a block
 * with no counterpart gets a row with an empty cell opposite it.
 *
 * This is not L7's `alignBlocks`. That one aligns for *authoring* — it scores a
 * pasted rendition against its source so the studio can show the user how well
 * their paste matched. This one aligns for *rendering*, produces rows rather
 * than pairs, handles more than two columns, and must be deterministic and
 * dependency-free because it runs inside the artifact. See
 * docs/decisions/L8-scenes.md.
 *
 * @module scene/align
 */

/**
 * @typedef {object} AlignedRow
 * @property {(number|null)[]} cells   one entry per column: the block index, or null
 * @property {string} key              a stable, structural key for the row
 */

/**
 * The signature two blocks must share to be considered the same landmark.
 * @param {import('../core/contracts.d.ts').ContentBlock} block
 * @returns {string}
 */
export function signatureOf(block) {
  if (!block || typeof block !== 'object') return 'none';
  switch (block.type) {
    case 'heading': return `heading:${Math.min(6, Math.max(1, Number(block.level) || 1))}`;
    case 'list': return `list:${block.ordered ? 'ol' : 'ul'}`;
    case 'table': return `table:${block.header ? 'h' : 'p'}`;
    default: return String(block.type);
  }
}

/**
 * Longest common subsequence over two signature lists, as index pairs.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {[number, number][]}
 */
export function lcsPairs(a, b) {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  /** @type {[number, number][]} */
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return out;
}

/**
 * Align two block lists into rows.
 * @param {import('../core/contracts.d.ts').ContentBlock[]} left
 * @param {import('../core/contracts.d.ts').ContentBlock[]} right
 * @returns {[number|null, number|null][]}
 */
export function alignPair(left, right) {
  const a = (left || []).map(signatureOf);
  const b = (right || []).map(signatureOf);
  const anchors = lcsPairs(a, b);

  /** @type {[number|null, number|null][]} */
  const rows = [];
  let i = 0;
  let j = 0;
  const flushGap = (untilA, untilB) => {
    // Zip the unmatched runs positionally: the second paragraph of a rewrite
    // belongs opposite the second paragraph of the original far more often
    // than it belongs three rows down.
    while (i < untilA || j < untilB) {
      const l = i < untilA ? i++ : null;
      const r = j < untilB ? j++ : null;
      rows.push([l, r]);
    }
  };
  for (const [ai, bj] of anchors) {
    flushGap(ai, bj);
    rows.push([ai, bj]);
    i = ai + 1;
    j = bj + 1;
  }
  flushGap(a.length, b.length);
  return rows;
}

/**
 * Align a source block list against any number of rendition block lists.
 *
 * Every rendition is aligned against the source, and the per-rendition rows are
 * merged onto the source's row order, so all columns share one row sequence.
 *
 * @param {import('../core/contracts.d.ts').ContentBlock[]} source
 * @param {import('../core/contracts.d.ts').ContentBlock[][]} columns
 * @returns {AlignedRow[]}
 */
export function alignColumns(source, columns) {
  const src = Array.isArray(source) ? source : [];
  const cols = Array.isArray(columns) ? columns : [];

  // Row skeleton: one row per source block, plus rows for the extras each
  // column contributes where the source has nothing.
  /** @type {{source: number|null, cells: (number|null)[]}[]} */
  const rows = src.map((_, index) => ({ source: index, cells: cols.map(() => null) }));

  cols.forEach((colBlocks, colIndex) => {
    const pairs = alignPair(src, colBlocks || []);
    /** @type {{after: number, index: number}[]} */
    const extras = [];
    let lastSourceRow = -1;
    for (const [s, r] of pairs) {
      if (s !== null) lastSourceRow = s;
      if (r === null) continue;
      if (s !== null) rows[s].cells[colIndex] = r;
      else extras.push({ after: lastSourceRow, index: r });
    }
    // Extras land immediately after the source row they follow, in order, in
    // their own rows — never merged into a row that already holds a pairing.
    for (let k = extras.length - 1; k >= 0; k--) {
      const extra = extras[k];
      const at = rows.findIndex((row, idx) => row.source === extra.after && idx >= 0);
      const insertAt = at < 0 ? 0 : at + 1;
      const cells = cols.map(() => null);
      cells[colIndex] = extra.index;
      rows.splice(insertAt, 0, { source: null, cells });
    }
  });

  return rows.map((row, index) => ({
    cells: [row.source, ...row.cells],
    key: `row/${index}`,
  }));
}
