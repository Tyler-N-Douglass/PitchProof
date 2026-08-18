/**
 * The artifact's brand variables, when the caller does not supply them.
 *
 * L5's `compileTheme(brand)` is the real theme compiler and `emit()` prefers it
 * whenever the caller passes its output as `deps.themeCss`. This module exists
 * because the emitter cannot ship an artifact with no theme: §15 says the
 * artifact wears the prospect's brand, never the studio's, and §22.6's contrast
 * check has to run against the stylesheet the artifact will actually use. A
 * mapping from the already-solved `ColorToken[]` to `--pp-*` names needs no
 * colour science — L4 did that work when it solved the roles — so doing it here
 * duplicates nothing.
 *
 * Every custom property is `--pp-*` (D11). Not one `--st-*` name is emitted.
 *
 * @module emit/theme
 */

/** ColorRole → CSS custom property. */
export const ROLE_VARS = Object.freeze({
  primary: '--pp-primary',
  onPrimary: '--pp-on-primary',
  secondary: '--pp-secondary',
  onSecondary: '--pp-on-secondary',
  surface: '--pp-surface',
  onSurface: '--pp-on-surface',
  surfaceAlt: '--pp-surface-alt',
  onSurfaceAlt: '--pp-on-surface-alt',
  accent: '--pp-accent',
  onAccent: '--pp-on-accent',
  border: '--pp-border',
  success: '--pp-success',
  warning: '--pp-warning',
  danger: '--pp-danger',
});

const SHADOWS = [
  'none',
  '0 1px 2px rgba(0,0,0,0.08)',
  '0 4px 12px rgba(0,0,0,0.12)',
  '0 12px 32px rgba(0,0,0,0.18)',
];

/**
 * Quote a family name when CSS needs it quoted.
 * @param {string} family
 * @returns {string}
 */
export function quoteFamily(family) {
  const name = String(family).trim();
  if (!name) return '';
  if (/^[a-zA-Z][\w-]*$/.test(name)) return name;
  return `"${name.replace(/["\\]/g, '')}"`;
}

/**
 * A font stack, requested face first, then its metric-compatible fallbacks.
 * @param {import('../core/contracts.d.ts').TypeFace|null} face
 * @param {string} generic
 * @returns {string}
 */
export function stackFor(face, generic) {
  if (!face) return generic;
  const parts = [face.family, ...(face.fallbackStack || [])]
    .map((f) => String(f || '').trim())
    .filter(Boolean);
  /** @type {string[]} */
  const seen = [];
  for (const p of parts) if (!seen.includes(p)) seen.push(p);
  if (!seen.some((p) => /^(sans-serif|serif|monospace|system-ui|ui-monospace|cursive|fantasy)$/i.test(p))) seen.push(generic);
  return seen.map(quoteFamily).filter(Boolean).join(', ');
}

/**
 * Compile a brand system to `--pp-*` declarations.
 *
 * @param {import('../core/contracts.d.ts').BrandSystem} brand
 * @returns {{css: string, vars: Record<string, string>}}
 */
export function compileFallbackTheme(brand) {
  /** @type {Record<string, string>} */
  const vars = {};
  for (const token of (brand && brand.colors) || []) {
    const name = ROLE_VARS[token.role];
    if (name && typeof token.hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(token.hex)) vars[name] = token.hex.toLowerCase();
  }

  const faces = (brand && brand.faces) || [];
  const byRole = (role) => faces.find((f) => f.role === role) || null;
  vars['--pp-font-display'] = stackFor(byRole('display') || byRole('body'), 'sans-serif');
  vars['--pp-font-body'] = stackFor(byRole('body') || byRole('display'), 'sans-serif');
  vars['--pp-font-mono'] = stackFor(byRole('mono'), 'ui-monospace, monospace');

  const shape = (brand && brand.shape) || { radiusPx: 8, borderWidthPx: 1, shadowLevel: 0 };
  vars['--pp-radius'] = `${Number(shape.radiusPx) || 0}px`;
  vars['--pp-border-width'] = `${Number(shape.borderWidthPx) || 0}px`;
  vars['--pp-shadow'] = SHADOWS[Math.max(0, Math.min(3, Number(shape.shadowLevel) || 0))];

  const body = Object.keys(vars)
    .sort()
    .map((k) => `  ${k}: ${vars[k]};`)
    .join('\n');

  const css = `/* brand theme — compiled by src/emit/theme.js from the proof's BrandSystem */\n:root {\n${body}\n}\n`;
  return { css, vars };
}

/**
 * `@font-face` rules for faces the user supplied and asserted a licence for.
 *
 * §7 and §13 are unambiguous: a foundry's webfont is never fetched and never
 * embedded on the tool's initiative. A face reaches this function only when the
 * caller passes it explicitly with `licenseAsserted: true` and a `data:` URI it
 * already holds. Note that the frozen `TypeFace` contract has nowhere to carry
 * font bytes — see `docs/disputes/L10-emit.md` — so this is fed from `deps`.
 *
 * @param {{family: string, dataUri: string, weight?: number, style?: string, licenseAsserted?: boolean}[]} fonts
 * @returns {string}
 */
export function compileFontFaces(fonts) {
  const usable = (fonts || []).filter((f) => f
    && f.licenseAsserted === true
    && typeof f.dataUri === 'string'
    && f.dataUri.toLowerCase().startsWith('data:')
    && typeof f.family === 'string'
    && f.family.trim());
  if (!usable.length) return '';
  const rules = usable.map((f) => [
    '@font-face {',
    `  font-family: ${quoteFamily(f.family)};`,
    `  font-weight: ${Number(f.weight) || 400};`,
    `  font-style: ${f.style === 'italic' ? 'italic' : 'normal'};`,
    '  font-display: block;',
    `  src: url(${f.dataUri});`,
    '}',
  ].join('\n'));
  return `/* user-supplied, licence-asserted faces (§7, §13) */\n${rules.join('\n')}\n`;
}
