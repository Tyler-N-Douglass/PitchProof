/**
 * Deterministic median-cut colour quantisation.
 *
 * PNG is lossless, so `EmitOptions.imageQuality` has nothing to act on the way
 * it does for JPEG. Rather than let the quality control silently do nothing for
 * PNG sources — which would make the emitter's size budget (§13) a fiction —
 * the lower quality tiers reduce the palette instead, which is the honest
 * lossy lever a lossless format has (D-L6-8).
 *
 * No dithering: dithering trades flat regions for noise, and noise is exactly
 * what DEFLATE cannot compress, so it costs bytes while making UI screenshots
 * look worse. The palette is built from the actual colour histogram, so flat
 * brand colours survive intact.
 */

/**
 * @param {Uint8Array} rgba
 * @param {number} maxColors 2..256
 * @returns {{colors: number[][], indices: Uint8Array, exact: boolean}}
 */
export function medianCut(rgba, maxColors) {
  const limit = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const pixels = rgba.length >> 2;

  /** @type {Map<number, number>} histogram: packed colour → count */
  const hist = new Map();
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const key = pack(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
    hist.set(key, (hist.get(key) || 0) + 1);
  }

  // Sorted so the palette does not depend on Map iteration order for anything
  // that could ever change.
  const entries = [...hist.entries()]
    .map(([key, count]) => ({ c: unpack(key), count }))
    .sort((a, b) => cmpColor(a.c, b.c));

  /** @type {number[][]} */
  let colors;
  let exact = false;
  if (entries.length <= limit) {
    colors = entries.map((e) => e.c);
    exact = true;
  } else {
    /** @type {{items: typeof entries}[]} */
    let boxes = [{ items: entries }];
    while (boxes.length < limit) {
      let bestIndex = -1;
      let bestScore = 0;
      let bestChannel = 0;
      for (let i = 0; i < boxes.length; i++) {
        const { channel, range } = widestChannel(boxes[i].items);
        const weight = range * Math.log2(1 + totalCount(boxes[i].items));
        if (boxes[i].items.length > 1 && weight > bestScore) {
          bestScore = weight; bestIndex = i; bestChannel = channel;
        }
      }
      if (bestIndex < 0) break;
      const box = boxes[bestIndex];
      const sorted = box.items.slice().sort((a, b) => (a.c[bestChannel] - b.c[bestChannel]) || cmpColor(a.c, b.c));
      const half = totalCount(sorted) / 2;
      let acc = 0;
      let split = 1;
      for (let i = 0; i < sorted.length - 1; i++) {
        acc += sorted[i].count;
        if (acc >= half) { split = i + 1; break; }
        split = i + 2;
      }
      boxes = [
        ...boxes.slice(0, bestIndex),
        { items: sorted.slice(0, split) },
        { items: sorted.slice(split) },
        ...boxes.slice(bestIndex + 1),
      ];
    }
    colors = boxes.map((box) => averageColor(box.items)).sort(cmpColor);
  }

  // Fully transparent entries first so `tRNS` stays as short as possible.
  colors = colors.slice().sort((a, b) => (a[3] - b[3]) || cmpColor(a, b));

  /** @type {Map<number, number>} colour → palette index */
  const lookup = new Map();
  colors.forEach((c, i) => { lookup.set(pack(c[0], c[1], c[2], c[3]), i); });

  const indices = new Uint8Array(pixels);
  /** @type {Map<number, number>} */
  const cache = new Map();
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const key = pack(rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
    let idx = lookup.get(key);
    if (idx === undefined) {
      idx = cache.get(key);
      if (idx === undefined) {
        idx = nearest(colors, rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]);
        cache.set(key, idx);
      }
    }
    indices[i] = idx;
  }
  return { colors, indices, exact };
}

/** @param {number[][]} colors */
function nearest(colors, r, g, b, a) {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    // Alpha difference weighted heavily: a wrong opacity is far more visible
    // than a slightly wrong hue.
    const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2 + 4 * (c[3] - a) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

function pack(r, g, b, a) { return ((r * 256 + g) * 256 + b) * 256 + a; }

function unpack(key) {
  const a = key % 256;
  const b = Math.floor(key / 256) % 256;
  const g = Math.floor(key / 65536) % 256;
  const r = Math.floor(key / 16777216) % 256;
  return [r, g, b, a];
}

function cmpColor(a, b) {
  return (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]) || (a[3] - b[3]);
}

function totalCount(items) {
  let n = 0;
  for (const it of items) n += it.count;
  return n;
}

function widestChannel(items) {
  let channel = 0;
  let range = -1;
  for (let ch = 0; ch < 4; ch++) {
    let lo = 255;
    let hi = 0;
    for (const it of items) {
      const v = it.c[ch];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const r = hi - lo;
    if (r > range) { range = r; channel = ch; }
  }
  return { channel, range: Math.max(0, range) };
}

function averageColor(items) {
  let r = 0; let g = 0; let b = 0; let a = 0; let n = 0;
  for (const it of items) {
    r += it.c[0] * it.count;
    g += it.c[1] * it.count;
    b += it.c[2] * it.count;
    a += it.c[3] * it.count;
    n += it.count;
  }
  if (n === 0) return [0, 0, 0, 255];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n), Math.round(a / n)];
}
