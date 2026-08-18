/**
 * Panel dispatch.
 *
 * One function from the rail's section id to the panel that renders it. Kept
 * separate from `ui/layout.js` so the shell does not import eight panels
 * directly and the bundler's acyclic-graph rule stays easy to satisfy.
 *
 * @module ui/panels/index
 */

import { h } from '../../core/vdom.js';
import { renderProjectPanel } from './project.js';
import { renderBrandPanel } from './brand.js';
import { renderSpecimensPanel } from './specimens.js';
import { renderRecipesPanel } from './recipes.js';
import { renderScenesPanel } from './scenes.js';
import { renderBranchesPanel } from './branches.js';
import { renderRehearsePanel } from './rehearse.js';
import { renderEmitPanel } from './emit.js';
import { renderSettingsPanel } from './settings.js';

export { renderProjectPanel } from './project.js';
export { renderBrandPanel } from './brand.js';
export { renderSpecimensPanel } from './specimens.js';
export { renderRecipesPanel } from './recipes.js';
export { renderScenesPanel } from './scenes.js';
export { renderBranchesPanel } from './branches.js';
export { renderRehearsePanel } from './rehearse.js';
export { renderEmitPanel } from './emit.js';
export { renderSettingsPanel } from './settings.js';

/** Section id → panel renderer. */
export const PANELS = {
  project: renderProjectPanel,
  brand: renderBrandPanel,
  specimens: renderSpecimensPanel,
  recipes: renderRecipesPanel,
  scenes: renderScenesPanel,
  branches: renderBranchesPanel,
  rehearse: renderRehearsePanel,
  emit: renderEmitPanel,
  settings: renderSettingsPanel,
};

/**
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderPanel(app) {
  const fn = PANELS[app.ui.section] || PANELS.project;
  return fn(app);
}

/**
 * Render every panel once, for the keyboard-reachability test: it needs the
 * full set of controls the studio can put on screen, not just the section that
 * happens to be open.
 * @param {any} app
 * @returns {import('../../core/vdom.js').VNode}
 */
export function renderAllPanels(app) {
  const section = app.ui.section;
  const trees = [];
  for (const id of Object.keys(PANELS)) {
    app.ui.section = id;
    trees.push(h('div', { 'data-st-panel': id }, PANELS[id](app)));
  }
  app.ui.section = section;
  return trees;
}
