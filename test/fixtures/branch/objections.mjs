/**
 * The objection corpus L9 searches against.
 *
 * These are the phrasings a room actually produces — the six §11/§22 name plus
 * the ones that follow them — because a fuzzy search tuned on invented strings
 * ("branch one", "branch two") tells you nothing about whether three characters
 * of "approvals" lands where the presenter needs it to.
 */

import { branch, scene, brand } from '../make-proof.mjs';
import { defaultEmitOptions } from '../../../src/core/contracts.js';
import { contentId } from '../../../src/core/ids.js';

/** The six realistic objections, with the aliases a seller would wire. */
export const OBJECTIONS = [
  {
    id: 'bn_approvals',
    objection: 'Our approvals process would never allow this',
    aliases: ['sign-off chain', 'review chain', 'legal sign off', 'governance'],
    returnPolicy: 'anchor',
  },
  {
    id: 'bn_scale',
    objection: 'That works for one page, not four hundred',
    aliases: ['volume', 'at scale', 'four hundred pages'],
    returnPolicy: 'nextSpineScene',
  },
  {
    id: 'bn_legal',
    objection: 'Legal has to see every claim',
    aliases: ['claims review', 'compliance', 'regulated language'],
    returnPolicy: 'anchor',
  },
  {
    id: 'bn_dam',
    objection: 'We already have a DAM',
    aliases: ['digital asset management', 'asset library', 'existing stack'],
    returnPolicy: 'anchor',
  },
  {
    id: 'bn_brand',
    objection: 'Our brand rules are stricter than that',
    aliases: ['brand governance', 'guidelines', 'tone of voice'],
    returnPolicy: 'nextSpineScene',
  },
  {
    id: 'bn_replatform',
    objection: "We're mid-replatform",
    aliases: ['migration', 'platform change', 'CMS move'],
    returnPolicy: 'anchor',
  },
];

/** A larger pool, used to grow a synthetic index for the performance test. */
export const OBJECTION_POOL = [
  ...OBJECTIONS.map((o) => ({ objection: o.objection, aliases: o.aliases })),
  { objection: 'Who owns this once your team leaves', aliases: ['handover', 'ownership'] },
  { objection: 'Our agency does this already', aliases: ['agency relationship', 'incumbent'] },
  { objection: 'Security will never approve a new vendor', aliases: ['infosec', 'vendor review'] },
  { objection: 'We tried something like this and it failed', aliases: ['previous attempt', 'burned before'] },
  { objection: 'That looks like a template, not our site', aliases: ['generic demo', 'not our brand'] },
  { objection: 'Translation quality is the whole problem', aliases: ['localisation quality', 'transcreation'] },
  { objection: 'Our product data is a mess', aliases: ['pim', 'data quality'] },
  { objection: 'Procurement takes nine months', aliases: ['purchasing', 'contract cycle'] },
  { objection: 'We have no budget until next year', aliases: ['budget cycle', 'capex'] },
  { objection: 'The team is already at capacity', aliases: ['bandwidth', 'headcount'] },
  { objection: 'How does this fit our design system', aliases: ['components', 'tokens'] },
  { objection: 'Accessibility has to hold at volume', aliases: ['wcag', 'a11y'] },
  { objection: 'Our channels each want something different', aliases: ['channel variants', 'omnichannel'] },
  { objection: 'Nobody will maintain another tool', aliases: ['tool sprawl', 'adoption'] },
  { objection: 'Legal owns claim language, not marketing', aliases: ['claims ownership', 'regulatory'] },
  { objection: 'We publish in nine markets with three people', aliases: ['market coverage', 'small team'] },
];

/**
 * A proof whose branches are the six realistic objections, anchored along a
 * short spine, with one nested inside another and one reachable only from the
 * jump index.
 * @returns {import('../../../src/core/contracts.d.ts').Proof}
 */
export function objectionProof() {
  const spine = Array.from({ length: 6 }, (_, i) => scene(`sc_spine_${i}`, i % 3 === 0 ? 1 : 3));
  const branches = OBJECTIONS.map((o, i) => branch(
    o.id,
    o.objection,
    Array.from({ length: 1 + (i % 2) }, (_, k) => scene(`${o.id}_s${k}`, 2)),
    o.returnPolicy,
    o.aliases,
  ));

  // Anchors: four off the spine, one nested inside the approvals branch, and
  // `bn_replatform` deliberately left reachable only from the jump index.
  spine[1].branchAnchors = ['bn_approvals'];
  spine[2].branchAnchors = ['bn_scale'];
  spine[3].branchAnchors = ['bn_dam'];
  spine[4].branchAnchors = ['bn_brand'];
  branches[0].scenes[0].branchAnchors = ['bn_legal'];

  return {
    schemaVersion: 1,
    id: contentId('proof', 'objections'),
    prospectName: 'Northwind Industrial',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches,
    emitOptions: defaultEmitOptions(),
  };
}

/**
 * A proof with `count` branches, cycled out of the pool with a distinguishing
 * suffix, for measuring search cost at a size no real deck reaches.
 * @param {number} count
 * @returns {import('../../../src/core/contracts.d.ts').Proof}
 */
export function wideProof(count) {
  const spine = Array.from({ length: 4 }, (_, i) => scene(`sc_wide_${i}`, 2));
  const branches = Array.from({ length: count }, (_, i) => {
    const src = OBJECTION_POOL[i % OBJECTION_POOL.length];
    const suffix = Math.floor(i / OBJECTION_POOL.length);
    return branch(
      `bn_wide_${String(i).padStart(3, '0')}`,
      suffix ? `${src.objection} (${MARKETS[suffix % MARKETS.length]})` : src.objection,
      [scene(`sc_wide_b${i}`, 2)],
      i % 2 ? 'anchor' : 'nextSpineScene',
      src.aliases,
    );
  });
  spine[1].branchAnchors = branches.slice(0, Math.min(branches.length, 12)).map((b) => b.id);

  return {
    schemaVersion: 1,
    id: contentId('proof', `wide-${count}`),
    prospectName: 'Wide Corp',
    createdAt: '2026-02-01T09:00:00.000Z',
    brand: brand(),
    specimens: [],
    renditions: [],
    recipes: [],
    spine,
    branches,
    emitOptions: defaultEmitOptions(),
  };
}

const MARKETS = ['DACH', 'Nordics', 'Benelux', 'Iberia', 'ANZ', 'Japan', 'Brazil', 'Gulf', 'India', 'Canada'];
