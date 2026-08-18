/**
 * Deterministic image resampling (§8: "downscaled to a max edge of 2400px").
 *
 * There is no canvas in Node and the studio may not depend on one either, so
 * this is a real resampler over decoded pixels: a separable **area-average box
 * filter**, which is the correct reconstruction for downscaling — every source
 * pixel contributes to exactly the destination pixels it overlaps, weighted by
 * the overlapped area. Lanczos is the better choice when *upscaling* or when
 * resampling by a small ratio, and this pipeline never upscales, so the box
 * filter's freedom from ringing on flat UI screenshots wins (D-L6-7).
 *
 * Alpha is premultiplied for the duration of the filter so that fully
 * transparent pixels cannot bleed their (undefined) colour into their
 * neighbours, then unpremultiplied on the way out.
 *
 * Determinism: the accumulation order is fixed by the loop structure, so the
 * same input always produces bit-identical output on any machine.
 */

/**
 * Fit `w`×`h` inside a square of `maxEdge`, preserving aspect ratio.
 * @param {number} w
 * @param {number} h
 * @param {number} maxEdge
 * @returns {{w: number, h: number, scaled: boolean}}
 */
export function fitWithin(w, h, maxEdge) {
  if (!(maxEdge > 0) || (w <= maxEdge && h <= maxEdge)) return { w, h, scaled: false };
  const ratio = maxEdge / Math.max(w, h);
  return {
    w: Math.max(1, Math.round(w * ratio)),
    h: Math.max(1, Math.round(h * ratio)),
    scaled: true,
  };
}

/**
 * Area-average resample of straight 8-bit RGBA.
 * @param {Uint8Array} rgba
 * @param {number} sw source width
 * @param {number} sh source height
 * @param {number} dw destination width
 * @param {number} dh destination height
 * @returns {Uint8Array} destination RGBA
 */
export function resizeRgba(rgba, sw, sh, dw, dh) {
  if (sw === dw && sh === dh) return rgba.slice();
  if (dw <= 0 || dh <= 0) throw new Error('resample: destination must be at least 1×1');

  // Pass 1 — horizontal, into premultiplied floats.
  const mid = new Float64Array(dw * sh * 4);
  const xScale = sw / dw;
  for (let dx = 0; dx < dw; dx++) {
    const x0 = dx * xScale;
    const x1 = (dx + 1) * xScale;
    const first = Math.floor(x0);
    const last = Math.min(sw - 1, Math.ceil(x1) - 1);
    for (let y = 0; y < sh; y++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let sx = first; sx <= last; sx++) {
        const weight = Math.min(x1, sx + 1) - Math.max(x0, sx);
        if (weight <= 0) continue;
        const o = (y * sw + sx) * 4;
        const alpha = rgba[o + 3] / 255;
        r += rgba[o] * alpha * weight;
        g += rgba[o + 1] * alpha * weight;
        b += rgba[o + 2] * alpha * weight;
        a += rgba[o + 3] * weight;
        wsum += weight;
      }
      const o = (y * dw + dx) * 4;
      const inv = wsum > 0 ? 1 / wsum : 0;
      mid[o] = r * inv; mid[o + 1] = g * inv; mid[o + 2] = b * inv; mid[o + 3] = a * inv;
    }
  }

  // Pass 2 — vertical, back to straight 8-bit RGBA.
  const out = new Uint8Array(dw * dh * 4);
  const yScale = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yScale;
    const y1 = (dy + 1) * yScale;
    const first = Math.floor(y0);
    const last = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let dx = 0; dx < dw; dx++) {
      let r = 0; let g = 0; let b = 0; let a = 0; let wsum = 0;
      for (let sy = first; sy <= last; sy++) {
        const weight = Math.min(y1, sy + 1) - Math.max(y0, sy);
        if (weight <= 0) continue;
        const o = (sy * dw + dx) * 4;
        r += mid[o] * weight;
        g += mid[o + 1] * weight;
        b += mid[o + 2] * weight;
        a += mid[o + 3] * weight;
        wsum += weight;
      }
      const inv = wsum > 0 ? 1 / wsum : 0;
      const alpha = a * inv;
      const o = (dy * dw + dx) * 4;
      const unpremul = alpha > 0 ? 255 / alpha : 0;
      out[o] = clamp8(r * inv * unpremul);
      out[o + 1] = clamp8(g * inv * unpremul);
      out[o + 2] = clamp8(b * inv * unpremul);
      out[o + 3] = clamp8(alpha);
    }
  }
  return out;
}

/** @param {number} v @returns {number} */
function clamp8(v) {
  const r = Math.round(v);
  return r < 0 ? 0 : (r > 255 ? 255 : r);
}
