/**
 * Constants shared by the app object, the layout and the action registry.
 *
 * They live in their own module for one mechanical reason: `scripts/lib/bundler.mjs`
 * refuses import cycles, and the app imports the layout, the layout imports the
 * panels, and all three need the section list. Anything both a writer and a
 * renderer needs belongs here.
 *
 * @module ui/constants
 */

/** Settings that live on this machine only and never travel with a project. */
export const SETTING_KEYS = {
  proxyBase: 'ingest.proxyBase',
  adapterEndpoint: 'adapter.endpoint',
  adapterKey: 'adapter.key',
  lastProject: 'studio.lastProject',
  operator: 'studio.operator',
};

/**
 * The rail, in the order §15 fixes: project → brand → specimens → recipes →
 * scenes → branches → rehearse → emit. Settings is appended because the proxy
 * and the adapter have to live somewhere and they are not a step in the flow.
 */
export const SECTIONS = [
  { id: 'project', label: 'Project', step: '1', hint: 'Name, seed, open, save, export' },
  { id: 'brand', label: 'Brand', step: '2', hint: 'Extract and review their system' },
  { id: 'specimens', label: 'Specimens', step: '3', hint: 'Their real content, captured' },
  { id: 'recipes', label: 'Recipes', step: '4', hint: 'Renditions, aligned, with provenance' },
  { id: 'scenes', label: 'Scenes', step: '5', hint: 'The spine, its layouts, its beats' },
  { id: 'branches', label: 'Branches', step: '6', hint: 'Objections in their words' },
  { id: 'rehearse', label: 'Rehearse', step: '7', hint: 'Sweep, fixes, dry run' },
  { id: 'emit', label: 'Emit', step: '8', hint: 'Budget, preflight, the file' },
  { id: 'settings', label: 'Settings', step: '·', hint: 'Proxy, adapter, this machine' },
];

/** Sections whose working surface needs more than the rail's default column. */
export const WIDE_SECTIONS = new Set(['recipes', 'rehearse', 'emit', 'scenes']);

/** The breakpoints the preview can be sized to, from `core/contracts.js`. */
export const PREVIEW_BREAKPOINTS = [
  { value: 'sm', label: 'Small · 390' },
  { value: 'md', label: 'Medium · 1024' },
  { value: 'lg', label: 'Large · 1600' },
];

/** Provenance values with the sentence the studio shows for each (§9). */
export const PROVENANCE_COPY = {
  'client-supplied': {
    label: 'Client supplied',
    tone: 'ok',
    describe: 'Their own material. Shown without a label.',
  },
  illustrative: {
    label: 'Illustrative',
    tone: 'warn',
    describe: 'Carries a visible label in the artifact that cannot be removed or styled away.',
  },
  'verified-by-user': {
    label: 'Verified by you',
    tone: 'ok',
    describe: 'You have checked this against what the client would actually publish. Recorded with who and when.',
  },
};
