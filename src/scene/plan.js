/**
 * `buildScene` and `sceneTemplates` — turning a specimen and its renditions
 * into a contract-valid `Scene` with a beat plan a presenter can actually walk.
 *
 * The beat plan is **derived from the render**, not written alongside it. The
 * layout is rendered once, the tree is walked, and every revealable element it
 * produced is collected with the `data-pp-group` its layout gave it. Beats are
 * those groups in document order. Two things follow, and both are properties
 * §17 asks for rather than promises:
 *
 *   - every id in `beats[n].reveals` names an element the layout actually
 *     renders, because it was read off the rendered tree;
 *   - the reveal order is the reading order, because document order is what the
 *     walk returns.
 *
 * The grouping — a column at a time in `splitBeforeAfter`, a wave of cards in
 * `fanOut`, a state at a time in `stack` — is the layout's own judgement about
 * how its content is talked through, expressed where the content is built.
 *
 * @module scene/plan
 */

import { contentId } from '../core/ids.js';
import { renderSceneTree } from './measure.js';
import { neutralBrand } from './brand-access.js';

/**
 * @typedef {object} BuildSceneArgs
 * @property {import('../core/contracts.d.ts').SceneLayout} layout
 * @property {import('../core/contracts.d.ts').Specimen|null} [specimen]
 * @property {import('../core/contracts.d.ts').Rendition[]} [renditions]
 * @property {string|null} [headline]
 * @property {string|null} [subhead]
 * @property {import('../core/ids.js').IdMinter} [idMinter]
 * @property {import('../core/contracts.d.ts').BrandSystem} [brand]
 * @property {string[]} [branchAnchors]
 * @property {string} [id]                     an explicit scene id, for a rebuild in place
 */

/**
 * Build a scene.
 * @param {BuildSceneArgs} args
 * @returns {import('../core/contracts.d.ts').Scene}
 */
export function buildScene(args) {
  const layout = args && args.layout;
  if (!layout) throw new Error('scene/plan: buildScene needs a layout');

  const specimen = args.specimen || null;
  const renditions = (args.renditions || []).filter(Boolean);
  const headline = args.headline === undefined ? null : args.headline;
  const subhead = args.subhead === undefined ? null : args.subhead;

  const id = args.id || (args.idMinter
    ? args.idMinter.next('scene')
    : contentId('scene', {
      layout,
      specimenId: specimen ? specimen.id : null,
      renditionIds: renditions.map((r) => r.id),
      headline,
      subhead,
    }));

  /** @type {import('../core/contracts.d.ts').Scene} */
  const scene = {
    id,
    layout,
    headline,
    subhead,
    specimenId: specimen ? specimen.id : null,
    renditionIds: renditions.map((r) => r.id),
    beats: [],
    branchAnchors: Array.isArray(args.branchAnchors) ? args.branchAnchors.slice() : [],
  };

  const tree = renderSceneTree(scene, {
    specimen,
    renditions,
    brand: args.brand || neutralBrand(),
    media: mediaMap(specimen, renditions),
    labelIllustrative: true,
    mode: 'presenter',
  });

  const groups = collectGroups(tree);
  scene.beats = groups.length === 0
    ? [beat(scene, args.idMinter, 'still', [], 0)]
    : groups.map((group, index) => beat(scene, args.idMinter, group.key, group.ids, index, layout));

  return scene;
}

/**
 * Every revealable element in a rendered tree, bucketed by its beat group, in
 * document order.
 * @param {import('../core/vdom.js').VNode} node
 * @returns {{key: string, ids: string[]}[]}
 */
export function collectGroups(node) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const seen = new Set();

  const visit = (n) => {
    if (n === null || n === undefined || n === false) return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    if (typeof n !== 'object' || 'raw' in n) return;
    const attrs = n.a || {};
    const id = attrs['data-pp-el'];
    if (typeof id === 'string' && !seen.has(id)) {
      seen.add(id);
      const key = typeof attrs['data-pp-group'] === 'string' ? attrs['data-pp-group'] : id;
      if (!groups.has(key)) { groups.set(key, []); order.push(key); }
      groups.get(key).push(id);
    }
    (n.c || []).forEach(visit);
  };
  visit(node);
  return order.map((key) => ({ key, ids: groups.get(key) }));
}

/**
 * @param {import('../core/contracts.d.ts').Scene} scene
 * @param {import('../core/ids.js').IdMinter|undefined} minter
 * @param {string} key
 * @param {string[]} ids
 * @param {number} index
 * @param {string} [layout]
 * @returns {import('../core/contracts.d.ts').Beat}
 */
function beat(scene, minter, key, ids, index, layout) {
  return {
    id: minter ? minter.next('beat') : contentId('beat', { scene: scene.id, key, index }),
    reveals: ids.slice(),
    presenterNote: presenterNote(layout || scene.layout, key, index),
    dwellHintMs: dwellHint(key),
  };
}

/**
 * The note the presenter view shows for a beat.
 *
 * These are coaching prompts about *delivery* — how to hold the room while the
 * beat is on screen. They say nothing about the client's business, quote no
 * numbers and name no outcomes, because §18.2 forbids the tool inventing any of
 * that and a presenter note that shipped a fabricated claim would be exactly
 * that violation with a friendlier name.
 * @param {string} layout
 * @param {string} key
 * @param {number} index
 * @returns {string|null}
 */
export function presenterNote(layout, key, index) {
  const prefix = String(key).split('/')[0];
  const exact = NOTES[`${layout}:${key}`] || NOTES[`${layout}:${prefix}`] || NOTES[prefix] || null;
  if (exact) return exact;
  return index === 0 ? NOTES.head : null;
}

/** Delivery prompts, keyed by `layout:group`, then by `layout:prefix`, then by prefix. */
const NOTES = {
  head: 'Say the point of this scene in one sentence, then stop talking and let them read it.',
  still: 'Nothing staged here — say the point and move when the room is ready.',

  'splitBeforeAfter:before': 'Read one line of their own page aloud. It is theirs; give them a second to recognise it.',
  'splitBeforeAfter:after': 'Point at the same block on the right. Name what changed — not how it was made.',
  before: 'Start on their side. The proof is that it is theirs.',
  after: 'Move across one block at a time. Same row, same claim, different execution.',

  'fanOut:source': 'Hold on the source for a beat, so what follows reads as a multiple of something real.',
  fan: 'Let the count land on its own. Do not narrate every card — name the pattern and stop.',
  source: 'Establish what everything else came from before you show what it became.',

  stack: 'Walk the states in order and name the thing that held constant across all of them.',

  media: 'Say nothing for two seconds. Let them look first.',

  main: 'Their content, unedited. Read a line from it before you annotate anything.',
  notes: 'Take the margin notes in order. Each one should answer a question they already had.',

  'systemMap:map/source': 'Start at the input. Name where it comes from in their own stack.',
  'systemMap:map/transform': 'One sentence on what happens here. Resist the architecture tour.',
  'systemMap:map/outputs': 'Trace one path end to end, then let the fan speak for the rest.',
  map: 'Trace the flow: in, through, out. One pass, then stop.',

  quote: 'Read it once, slowly, and then wait. The silence is doing the work.',
  attribution: 'Name the source. Whose words these are is the whole point of the scene.',

  index: 'Say what you are going to cover and roughly how long it takes. Then move.',
};

/** Pacing hints for the presenter view. Never a timer (§10). */
function dwellHint(key) {
  const prefix = String(key).split('/')[0];
  return DWELL[prefix] ?? DWELL[key] ?? 20000;
}

const DWELL = {
  head: 15000,
  still: 15000,
  before: 25000,
  after: 30000,
  source: 15000,
  fan: 20000,
  stack: 25000,
  media: 12000,
  main: 30000,
  notes: 25000,
  map: 25000,
  quote: 12000,
  attribution: 8000,
  index: 20000,
};

/**
 * Every media reference a scene can resolve, keyed by id — the same map the
 * runtime builds for `LayoutContext.media`.
 * @param {import('../core/contracts.d.ts').Specimen|null} specimen
 * @param {import('../core/contracts.d.ts').Rendition[]} renditions
 * @returns {Map<string, import('../core/contracts.d.ts').MediaRef>}
 */
export function mediaMap(specimen, renditions) {
  /** @type {Map<string, import('../core/contracts.d.ts').MediaRef>} */
  const map = new Map();
  for (const m of (specimen && Array.isArray(specimen.media) ? specimen.media : [])) map.set(m.id, m);
  for (const r of renditions || []) for (const m of (Array.isArray(r.media) ? r.media : [])) map.set(m.id, m);
  return map;
}

/**
 * The layouts the studio offers, in the order they are offered: the ones that
 * carry a proof first, the ones that frame it after.
 * @returns {{layout: import('../core/contracts.d.ts').SceneLayout, name: string, describe: string}[]}
 */
export function sceneTemplates() {
  return [
    {
      layout: 'splitBeforeAfter',
      name: 'Before and after',
      describe: 'Their page on the left, the rendition on the right, aligned block to block so the comparison needs no narration.',
    },
    {
      layout: 'fanOut',
      name: 'Fan out',
      describe: 'One source and every variant it produced, sized so the count is felt rather than claimed.',
    },
    {
      layout: 'stack',
      name: 'State by state',
      describe: 'The same asset at each state it passes through, stacked so what held constant is visible.',
    },
    {
      layout: 'fullBleed',
      name: 'Full bleed',
      describe: 'One visual filling the frame, with the headline over it — for the moment the picture is the argument.',
    },
    {
      layout: 'sideNote',
      name: 'Annotated content',
      describe: 'Their content down the middle with your notes in the margin, each note anchored to the block it is about.',
    },
    {
      layout: 'systemMap',
      name: 'System map',
      describe: 'The flow drawn as a diagram: what comes in, what acts on it, what comes out.',
    },
    {
      layout: 'quoteCard',
      name: 'Quote card',
      describe: 'One line, given the whole screen, with its attribution — for their words, never invented ones.',
    },
    {
      layout: 'contentsIndex',
      name: 'Contents',
      describe: 'A numbered index of what the proof covers — the scene a forwarded recipient opens on.',
    },
  ];
}
