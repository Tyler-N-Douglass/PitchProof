/**
 * The studio's component vocabulary.
 *
 * Every one of these is a pure function to a VNode. They carry no state, no
 * handlers and no ids of their own: interaction is declared with
 * `data-st-act` (see `ui/render.js`), which is what keeps `toHtml(render(state))`
 * a deterministic string and what lets the keyboard-reachability test enumerate
 * the interface mechanically instead of trusting a list someone maintained.
 *
 * Two rules hold across the file, and both are load-bearing:
 *
 *   - **Only `--st-*` custom properties.** The artifact's `--pp-*` namespace
 *     never appears in `src/ui/**`; `test/ui/theme-isolation.test.mjs` makes
 *     that a build failure rather than a habit (D11, §15).
 *   - **Every control is focusable and labelled.** A control that only a mouse
 *     can reach is a §20.10 finding, so buttons are `<button>`, fields are
 *     `<label>`+control pairs, and anything clickable that is not a control
 *     carries an explicit `tabindex` and `role`.
 *
 * @module ui/components
 */

import { h, cx } from '../core/vdom.js';
import { ACT_ATTR, ARG_ATTR, ENTER_ATTR, EVENT_ATTR, KEY_ATTR, RAW_ATTR } from './render.js';
import { fnv1a32 } from '../core/hash.js';

/**
 * @typedef {object} ActionRef
 * @property {string} act        action id
 * @property {string} [arg]      action argument
 * @property {string} [on]       DOM event, when it is not the element default
 */

/**
 * Spread an action reference into attributes.
 * @param {ActionRef|null|undefined} ref
 * @returns {Record<string, string|null>}
 */
export function actAttrs(ref) {
  if (!ref || !ref.act) return {};
  /** @type {Record<string, string|null>} */
  const out = { [ACT_ATTR]: ref.act };
  if (ref.arg !== undefined && ref.arg !== null) out[ARG_ATTR] = String(ref.arg);
  if (ref.on) out[EVENT_ATTR] = ref.on;
  return out;
}

/**
 * A button. `variant` is one of primary | ghost | danger | quiet.
 * @param {object} props
 * @param {string} props.act
 * @param {string} [props.arg]
 * @param {string} [props.variant]
 * @param {boolean} [props.disabled]
 * @param {string} [props.title]
 * @param {string} [props.keyHint]     keyboard shortcut shown in the button
 * @param {string} [props.pressed]     'true' | 'false' for a toggle
 * @param {string} [props.className]
 * @param {import('../core/vdom.js').VNode} label
 * @returns {import('../core/vdom.js').VNode}
 */
export function button(props, label) {
  return h('button', {
    type: 'button',
    class: cx('st-btn', props.variant ? `st-btn--${props.variant}` : null, props.className),
    ...actAttrs(props),
    disabled: props.disabled ? true : null,
    'aria-disabled': props.disabled ? 'true' : null,
    'aria-pressed': props.pressed === undefined ? null : props.pressed,
    title: props.title || null,
  }, label, props.keyHint ? h('kbd', { class: 'st-btn-key' }, props.keyHint) : null);
}

/**
 * A labelled single-line text field.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.act
 * @param {string} [props.arg]
 * @param {string} [props.value]
 * @param {string} [props.placeholder]
 * @param {string} [props.hint]
 * @param {string} [props.type]
 * @param {boolean} [props.mono]
 * @param {boolean} [props.disabled]
 * @param {string} [props.key]
 * @param {string} [props.enter]   action id Enter runs from inside this field
 * @returns {import('../core/vdom.js').VNode}
 */
export function field(props) {
  return h('label', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, props.label),
    h('input', {
      class: cx('st-input', props.mono && 'st-mono'),
      type: props.type || 'text',
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder || null,
      disabled: props.disabled ? true : null,
      [KEY_ATTR]: props.key || null,
      [ENTER_ATTR]: props.enter || null,
      ...actAttrs(props),
    }),
    props.hint ? h('span', { class: 'st-field-hint' }, props.hint) : null);
}

/**
 * A labelled multi-line field.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.act
 * @param {string} [props.arg]
 * @param {string} [props.value]
 * @param {string} [props.placeholder]
 * @param {string} [props.hint]
 * @param {number} [props.rows]
 * @param {boolean} [props.mono]
 * @param {string} [props.key]
 * @returns {import('../core/vdom.js').VNode}
 */
export function textarea(props) {
  return h('label', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, props.label),
    h('textarea', {
      class: cx('st-input', 'st-textarea', props.mono && 'st-mono'),
      rows: String(props.rows || 4),
      value: props.value === undefined || props.value === null ? '' : String(props.value),
      placeholder: props.placeholder || null,
      [KEY_ATTR]: props.key || null,
      ...actAttrs(props),
    }),
    props.hint ? h('span', { class: 'st-field-hint' }, props.hint) : null);
}

/**
 * A labelled `<select>`.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.act
 * @param {string} [props.arg]
 * @param {string} props.value
 * @param {{value: string, label: string}[]} props.options
 * @param {string} [props.hint]
 * @param {boolean} [props.disabled]
 * @param {string} [props.key]
 * @returns {import('../core/vdom.js').VNode}
 */
export function select(props) {
  return h('label', { class: 'st-field' },
    h('span', { class: 'st-field-label' }, props.label),
    // Selection is carried by the options' `selected` property rather than the
    // select's `value`, because the patcher writes attributes before it walks
    // children and a `value` set before its options exist would be discarded.
    h('select', {
      class: 'st-input st-select',
      disabled: props.disabled ? true : null,
      [KEY_ATTR]: props.key || null,
      ...actAttrs(props),
    }, props.options.map((o) => h('option', {
      value: o.value,
      selected: o.value === props.value ? true : null,
    }, o.label))),
    props.hint ? h('span', { class: 'st-field-hint' }, props.hint) : null);
}

/**
 * A checkbox with its explanation.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.act
 * @param {string} [props.arg]
 * @param {boolean} props.checked
 * @param {string} [props.hint]
 * @param {boolean} [props.disabled]
 * @returns {import('../core/vdom.js').VNode}
 */
export function checkbox(props) {
  return h('label', { class: cx('st-check', props.disabled && 'st-check--disabled') },
    h('input', {
      type: 'checkbox',
      class: 'st-checkbox',
      checked: !!props.checked,
      disabled: props.disabled ? true : null,
      ...actAttrs(props),
    }),
    h('span', { class: 'st-check-body' },
      h('span', { class: 'st-check-label' }, props.label),
      props.hint ? h('span', { class: 'st-field-hint' }, props.hint) : null));
}

/**
 * A group of radio-like segmented buttons.
 * @param {object} props
 * @param {string} props.label
 * @param {string} props.act
 * @param {string} props.value
 * @param {{value: string, label: string}[]} props.options
 * @param {string} [props.hint]
 * @returns {import('../core/vdom.js').VNode}
 */
export function segmented(props) {
  return h('div', { class: 'st-field', role: 'group', 'aria-label': props.label },
    h('span', { class: 'st-field-label' }, props.label),
    h('div', { class: 'st-segmented' }, props.options.map((o) => button({
      act: props.act,
      arg: o.value,
      variant: o.value === props.value ? 'primary' : 'ghost',
      pressed: o.value === props.value ? 'true' : 'false',
      className: 'st-segment',
    }, o.label))),
    props.hint ? h('span', { class: 'st-field-hint' }, props.hint) : null);
}

/**
 * A panel section with a heading and optional trailing controls.
 * @param {object} props
 * @param {string} props.title
 * @param {string} [props.subtitle]
 * @param {import('../core/vdom.js').VNode} [props.actions]
 * @param {string} [props.id]
 * @param {...import('../core/vdom.js').VNode} children
 * @returns {import('../core/vdom.js').VNode}
 */
export function section(props, ...children) {
  return h('section', { class: 'st-section', id: props.id || null },
    h('header', { class: 'st-section-head' },
      h('div', null,
        h('h3', { class: 'st-section-title' }, props.title),
        props.subtitle ? h('p', { class: 'st-section-sub' }, props.subtitle) : null),
      props.actions ? h('div', { class: 'st-section-actions' }, props.actions) : null),
    h('div', { class: 'st-section-body' }, children));
}

/**
 * A small labelled value, for the dense metric rows.
 * @param {string} label
 * @param {import('../core/vdom.js').VNode} value
 * @param {string} [tone]  ok | warn | bad | dim
 * @returns {import('../core/vdom.js').VNode}
 */
export function stat(label, value, tone) {
  return h('div', { class: cx('st-stat', tone && `st-stat--${tone}`) },
    h('span', { class: 'st-stat-label' }, label),
    h('span', { class: 'st-stat-value st-mono' }, value));
}

/**
 * A status pill.
 * @param {string} text
 * @param {string} [tone]  ok | warn | bad | info | dim
 * @param {string} [title]
 * @returns {import('../core/vdom.js').VNode}
 */
export function badge(text, tone, title) {
  return h('span', { class: cx('st-badge', tone && `st-badge--${tone}`), title: title || null }, text);
}

/**
 * A selectable row in a library list. Rows are buttons so the whole row is one
 * tab stop and Enter selects it.
 * @param {object} props
 * @param {string} props.act
 * @param {string} props.arg
 * @param {boolean} [props.selected]
 * @param {string} [props.key]
 * @param {import('../core/vdom.js').VNode} [props.trailing]
 * @param {import('../core/vdom.js').VNode} props.title
 * @param {import('../core/vdom.js').VNode} [props.meta]
 * @returns {import('../core/vdom.js').VNode}
 */
export function row(props) {
  return h('div', { class: cx('st-row', props.selected && 'st-row--selected'), [KEY_ATTR]: props.key || props.arg },
    h('button', {
      type: 'button',
      class: 'st-row-main',
      'aria-current': props.selected ? 'true' : null,
      ...actAttrs(props),
    },
    h('span', { class: 'st-row-title' }, props.title),
    props.meta ? h('span', { class: 'st-row-meta' }, props.meta) : null),
    props.trailing ? h('div', { class: 'st-row-trailing' }, props.trailing) : null);
}

/**
 * The empty state for a library that has nothing in it yet. It always names the
 * next action rather than describing the absence.
 * @param {string} message
 * @param {import('../core/vdom.js').VNode} [action]
 * @returns {import('../core/vdom.js').VNode}
 */
export function empty(message, action) {
  return h('div', { class: 'st-empty' }, h('p', { class: 'st-empty-text' }, message), action || null);
}

/**
 * An inline notice. `tone` drives colour and the icon glyph; the text is always
 * a full sentence saying what happened and what to do.
 * @param {string} tone   ok | warn | bad | info
 * @param {import('../core/vdom.js').VNode} body
 * @param {import('../core/vdom.js').VNode} [actions]
 * @returns {import('../core/vdom.js').VNode}
 */
export function notice(tone, body, actions) {
  return h('div', { class: cx('st-notice', `st-notice--${tone}`), role: tone === 'bad' ? 'alert' : 'status' },
    h('div', { class: 'st-notice-body' }, body),
    actions ? h('div', { class: 'st-notice-actions' }, actions) : null);
}

/**
 * A horizontal meter, used for storage pressure and the size budget.
 * @param {object} props
 * @param {number} props.ratio
 * @param {string} [props.tone]
 * @param {string} [props.label]
 * @returns {import('../core/vdom.js').VNode}
 */
export function meter(props) {
  const pct = Math.max(0, Math.min(1, Number.isFinite(props.ratio) ? props.ratio : 0));
  return h('div', {
    class: cx('st-meter', props.tone && `st-meter--${props.tone}`),
    role: 'meter',
    'aria-valuemin': '0',
    'aria-valuemax': '100',
    'aria-valuenow': String(Math.round(pct * 100)),
    'aria-label': props.label || 'usage',
  }, h('div', { class: 'st-meter-fill', style: { width: `${(pct * 100).toFixed(1)}%` } }));
}

/**
 * A swatch showing a colour with its own hex written on it in the colour that
 * will actually sit on it — so the contrast number and the eye agree.
 * @param {string} hex
 * @param {string} onHex
 * @param {string} label
 * @returns {import('../core/vdom.js').VNode}
 */
export function swatch(hex, onHex, label) {
  return h('div', {
    class: 'st-swatch',
    style: { background: hex, color: onHex },
    title: `${label} ${hex}`,
  }, h('span', { class: 'st-swatch-text st-mono' }, label));
}

/**
 * Inline markup the studio did not author — a logo's SVG, a specimen's raw HTML
 * preview. Keyed by a digest so the patcher replaces it only when it changes,
 * and always wrapped so it cannot escape its box.
 * @param {string} html
 * @param {string} [className]
 * @returns {import('../core/vdom.js').VNode}
 */
export function rawBox(html, className) {
  const text = String(html || '');
  return h('div', {
    class: cx('st-raw', className),
    [RAW_ATTR]: fnv1a32(text).toString(16),
  }, text);
}

/**
 * A definition row: term on the left, value on the right, both selectable.
 * @param {string} term
 * @param {import('../core/vdom.js').VNode} value
 * @param {string} [tone]
 * @returns {import('../core/vdom.js').VNode}
 */
export function pair(term, value, tone) {
  return h('div', { class: cx('st-pair', tone && `st-pair--${tone}`) },
    h('dt', { class: 'st-pair-term' }, term),
    h('dd', { class: 'st-pair-value' }, value));
}

/**
 * Wrap definition rows.
 * @param {...import('../core/vdom.js').VNode} children
 * @returns {import('../core/vdom.js').VNode}
 */
export function pairs(...children) {
  return h('dl', { class: 'st-pairs' }, children);
}

/**
 * A toolbar strip.
 * @param {...import('../core/vdom.js').VNode} children
 * @returns {import('../core/vdom.js').VNode}
 */
export function toolbar(...children) {
  return h('div', { class: 'st-toolbar' }, children);
}

/**
 * A keyboard hint rendered as a `<kbd>` sequence. Takes the output of
 * `keys.keyLabel(binding)`, so a hint can never name a key the router does not
 * answer to.
 * @param {string[]} parts
 * @returns {import('../core/vdom.js').VNode}
 */
export function keyHint(parts) {
  return h('span', { class: 'st-keys' }, parts.map((k) => h('kbd', { class: 'st-kbd' }, k)));
}
