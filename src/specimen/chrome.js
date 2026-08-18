/**
 * Chrome stripping — §8, §22.3, PLAN §4.3.
 *
 * Enterprise sites are hostile: nested mega-nav, cookie walls, personalization
 * shells, sticky bars, chat widgets, related-content rails. Under-stripping
 * poisons every specimen downstream, so this is not a single rule. Four
 * independent signals are combined by a scored classifier:
 *
 *   (a) landmark roles and semantic elements     `landmarkSignal`
 *   (b) link-density ratio, short-text guarded   `linkSignal`
 *   (c) boilerplate lexicon + structural signatures  `boilerplateSignal`
 *   (d) repeated-across-pages detection          `repeatSignal`  ← strongest
 *
 * A negative content signal (`contentSignal`) pushes back: prose with real
 * paragraphs, headings and low link density is content even when it sits in a
 * container whose class name looks like furniture.
 *
 * A main-content locator (`locateMainRoot`) sets the extraction root before any
 * scoring runs, so the classifier is only ever asked to judge blocks that
 * survived the landmark cut.
 *
 * Nothing is destroyed: `stripChrome` works on a clone and hands back every
 * removed subtree with its reason, its score and the exact position it came
 * from, which is what makes restoration exact rather than approximate.
 */

import {
  ancestors, attrOf, bodyOf, childrenOf, cloneTree, closest, contains, detach,
  elements, firstElement, identityString, indexPath, isElement, linkParents,
  NON_RENDERED, reattach, selectorPath, tagOf, textOf, textStats, walk,
} from './dom.js';

/** Score at or above which a block is chrome. Calibrated on the §17.5 corpus. */
export const CHROME_THRESHOLD = 1.0;

/**
 * A block holding at least this share of the root's non-link text has to clear
 * a much higher bar before it can be stripped. Losing the body of a page to one
 * confident mistake is the worst failure this classifier can have.
 */
export const DOMINANT_SHARE = 0.5;
export const DOMINANT_THRESHOLD = 1.7;

/**
 * A block that contains the page's own headline is presumed to be content: the
 * title of the page is the one thing that cannot be furniture. It can still be
 * stripped, but only on overwhelming evidence — a site header whose logo is
 * marked up as the `h1` still goes, because it scores far above this.
 */
export const HEADLINE_THRESHOLD = 2.0;

/**
 * Elements whose descendants are structural parts of one content block rather
 * than independent blocks. A `<footer>` inside a `<blockquote>` is the
 * attribution, not a page footer; a `<th>` is not a block that can be chrome.
 */
export const ATOMIC_CONTAINERS = new Set(['blockquote', 'figure', 'table', 'pre', 'dl', 'p']);

/** Landmark tags that are chrome by definition when they are page-level. */
const LANDMARK_TAGS = {
  nav: 1.25,
  footer: 1.15,
  aside: 1.05,
  header: 1.05,
  dialog: 1.2,
  menu: 1.0,
};

/** ARIA landmark roles, §8's list plus the ones enterprise shells actually use. */
const LANDMARK_ROLES = {
  navigation: 1.25,
  banner: 1.15,
  contentinfo: 1.2,
  search: 1.1,
  dialog: 1.25,
  alertdialog: 1.25,
  complementary: 1.05,
  menubar: 1.2,
  menu: 1.0,
  toolbar: 1.0,
  tablist: 0.6,
  region: 0.0,
  main: 0.0,
  article: 0.0,
};

/**
 * (c) Structural signatures — identity tokens that name furniture. Weights are
 * evidence strengths, not probabilities: 1.0 is "decisive on its own".
 */
export const CHROME_LEXICON = [
  { name: 'cookie', w: 1.2, re: /\b(cookie|cookies|consent|gdpr|ccpa|privacy-(?:banner|bar|prefs|preferences)|onetrust|truste|cmp)\b/ },
  { name: 'cookie', w: 1.2, re: /(cookiebanner|cookiebar|cookieconsent|consentbanner|consentmanager)/ },
  { name: 'nav', w: 1.05, re: /\b(nav|navbar|navigation|megamenu|mega-menu|menu|submenu|dropdown|topbar|utility|masthead)\b/ },
  { name: 'nav', w: 1.05, re: /(meganav|mainnav|primarynav|globalnav|sitenav|navlist)/ },
  { name: 'header', w: 0.85, re: /\b(header|site-header|global-header|page-header|banner)\b/ },
  { name: 'footer', w: 1.05, re: /\b(footer|site-footer|global-footer|colophon|legal|copyright)\b/ },
  { name: 'sidebar', w: 0.95, re: /\b(sidebar|side-nav|sidenav|rail|toc|tree|left-nav|secondary-nav)\b/ },
  { name: 'breadcrumb', w: 1.1, re: /\b(breadcrumb|breadcrumbs|crumbs)\b/ },
  { name: 'newsletter', w: 1.05, re: /\b(newsletter|subscribe|subscription|signup|sign-up|optin|opt-in|email-capture)\b/ },
  { name: 'personalization', w: 1.05, re: /\b(personaliz\w*|personalis\w*|recommend\w*|for-?you|because-?you|audience|segment|visitor|greeting)\b/ },
  { name: 'chat', w: 1.1, re: /\b(chat|livechat|messenger|intercom|drift|zendesk|helpbot|bot-launcher|support-widget)\b/ },
  { name: 'social', w: 0.95, re: /\b(social|share|sharing|follow|twitter|facebook|linkedin|instagram|youtube|tiktok|whatsapp)\b/ },
  { name: 'related', w: 0.95, re: /\b(related|recirc|recirculation|more-from|morefrom|also-like|readnext|read-next|promoted|trending|popular)\b/ },
  { name: 'promo', w: 0.85, re: /\b(promo|promotion|ad|ads|advert|advertisement|sponsor|sponsored|upsell|cross-sell)\b/ },
  { name: 'overlay', w: 1.1, re: /\b(modal|overlay|interstitial|popup|pop-up|lightbox|paywall|gate|takeover|drawer|offcanvas|off-canvas)\b/ },
  { name: 'sticky', w: 0.8, re: /\b(sticky|fixed-bar|floating|affix|stickybar|sticky-cta|anchor-bar)\b/ },
  { name: 'skip', w: 1.3, re: /\b(skip-link|skiplink|skip-to|skipnav|visually-hidden-link)\b/ },
  { name: 'widget', w: 0.55, re: /\b(widget|toolbar|controls|switcher|selector|locale-picker|language-picker|country-selector)\b/ },
  { name: 'logos', w: 0.95, re: /\b(logo-?cloud|logos|logo-?marquee|marquee|trusted-?by|client-?logos|customer-?logos|as-?seen-?in|awards-?bar)\b/ },
  { name: 'cart', w: 0.8, re: /\b(minicart|mini-cart|cart-drawer|basket-flyout|wishlist-flyout)\b/ },
];

/**
 * (c) Boilerplate lexicon — the words furniture says. Matched against the
 * block's own collapsed text, guarded by length so an article *about* cookie
 * law is not mistaken for a cookie banner.
 */
export const CHROME_PHRASES = [
  { name: 'cookie', w: 1.25, max: 900, re: /\b(we use cookies|uses cookies|accept all cookies|accept all|reject all|manage (?:your )?(?:cookie )?preferences|cookie (?:policy|settings|preferences)|your privacy choices|privacy preference cent(?:er|re))\b/ },
  { name: 'newsletter', w: 1.1, max: 700, re: /\b(subscribe to (?:our|the) newsletter|sign up for (?:our|the) newsletter|get (?:the )?(?:latest|our best).{0,40}(?:inbox|email)|enter your email|email address|join our mailing list|never miss an update|unlock (?:this|full) (?:article|story))\b/ },
  { name: 'social', w: 0.9, max: 400, re: /\b(share (?:this|on)|follow us|share via|tweet this|post on linkedin|share this (?:article|page|story))\b/ },
  { name: 'chat', w: 1.05, max: 400, re: /\b(chat with (?:us|sales|an expert)|live chat|how can we help|start a conversation|message us)\b/ },
  { name: 'personalization', w: 1.05, max: 500, re: /\b(recommended for you|because you (?:viewed|read|bought)|picked for you|based on your|others like you|welcome back)\b/ },
  { name: 'related', w: 0.9, max: 500, re: /\b(related (?:articles|stories|products|content|reading)|you (?:may|might) also (?:like|enjoy)|more (?:from|like this)|read next|customers also (?:bought|viewed)|up next)\b/ },
  { name: 'footer', w: 0.95, max: 1200, re: /(\ball rights reserved\b|©\s*\d{4}|\(c\)\s*\d{4}|\bcopyright\s+\d{4})/ },
  { name: 'footer', w: 0.8, max: 900, re: /\b(privacy policy|terms of (?:use|service)|cookie notice|legal notice|imprint|impressum|site ?map)\b/ },
  { name: 'skip', w: 1.35, max: 120, re: /\b(skip to (?:main )?content|skip navigation|skip to main|zum inhalt springen|aller au contenu)\b/ },
  { name: 'nav', w: 0.7, max: 200, re: /\b(back to top|main menu|open menu|close menu|toggle navigation)\b/ },
  { name: 'cookie', w: 1.2, max: 900, re: /\b(wir verwenden cookies|alle akzeptieren|cookie-einstellungen|nous utilisons des cookies|tout accepter)\b/ },
  { name: 'newsletter', w: 1.05, max: 700, re: /\b(newsletter abonnieren|jetzt anmelden|e-mail-adresse|abonnez-vous)\b/ },
];

/** Localised "skip link" phrasings are in CHROME_PHRASES; this is the anchor form. */
const SKIP_LINK_RE = /^(skip|jump)\b.{0,40}\b(content|main|navigation|nav)\b/i;

/**
 * Normalised text signature used by the repeated-across-pages signal. Digits
 * are folded so "12 comments" and "34 comments" agree; punctuation is dropped
 * so a rebuilt template with different separators still matches.
 * @param {any} node
 * @returns {string}
 */
export function textSignature(node) {
  return textOf(node)
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}#\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {any} n @returns {string} */
function skeletonToken(n) {
  const id = (attrOf(n, 'id') || '').trim().split(/\s+/)[0];
  const cls = (attrOf(n, 'class') || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice().sort().slice(0, 3).join('.');
  const role = (attrOf(n, 'role') || '').trim().toLowerCase();
  return tagOf(n) + (id ? `#${id}` : '') + (cls ? `.${cls}` : '') + (role ? `[${role}]` : '');
}

/**
 * Structural signature: the tag/class/role skeleton of the subtree to a fixed
 * depth. This is the signal that survives translation — a locale variant has
 * different words in the same shell.
 * @param {any} node
 * @param {number} [depth]
 * @returns {string}
 */
export function structSignature(node, depth = 3) {
  /** @type {string[]} */
  const parts = [];
  const rec = (n, d) => {
    if (!isElement(n) || d > depth) return;
    parts.push(skeletonToken(n));
    for (const c of childrenOf(n)) if (isElement(c)) rec(c, d + 1);
  };
  rec(node, 0);
  return parts.join('/');
}

/**
 * A structural signature only counts as evidence when it is distinctive: it
 * names a class, id or role, and describes more than a bare wrapper. Without
 * this guard `div/p/p` would condemn every article on the site.
 * @param {string} sig
 * @returns {boolean}
 */
export function distinctiveStruct(sig) {
  if (!sig) return false;
  const parts = sig.split('/');
  if (parts.length < 2) return false;
  return /[#.[]/.test(sig);
}

/**
 * Index of what repeats across the sibling pages of the same site.
 * Accepts `DocNode`s, `RawCapture`s (`{doc}`) or `{root}` wrappers.
 * @param {any[]} siblings
 * @returns {{texts: Map<string, number>, structs: Map<string, number>, pages: number}}
 */
export function siblingIndex(siblings) {
  /** @type {Map<string, number>} */
  const texts = new Map();
  /** @type {Map<string, number>} */
  const structs = new Map();
  const docs = (siblings || []).map(asDoc).filter(Boolean);
  for (const doc of docs) {
    const body = bodyOf(doc);
    /** @type {Set<string>} */
    const tSeen = new Set();
    /** @type {Set<string>} */
    const sSeen = new Set();
    for (const el of elements(body)) {
      if (NON_RENDERED.has(tagOf(el))) continue;
      const t = textSignature(el);
      if (t.length >= 25) tSeen.add(t);
      const s = structSignature(el);
      if (distinctiveStruct(s)) sSeen.add(s);
    }
    for (const t of tSeen) texts.set(t, (texts.get(t) || 0) + 1);
    for (const s of sSeen) structs.set(s, (structs.get(s) || 0) + 1);
  }
  return { texts, structs, pages: docs.length };
}

/** @param {any} x @returns {any|null} */
function asDoc(x) {
  if (!x) return null;
  if (x.type === 'element' || x.type === 'text' || x.type === 'comment') return x;
  if (x.doc) return x.doc;
  if (x.root) return x.root;
  return null;
}

/**
 * (a) Landmark roles and semantic elements.
 * @param {any} node
 * @param {{inArticle: boolean}} ctx
 * @returns {{score: number, detail: string[]}}
 */
export function landmarkSignal(node, ctx) {
  /** @type {string[]} */
  const detail = [];
  let score = 0;
  const tag = tagOf(node);
  const role = (attrOf(node, 'role') || '').toLowerCase().trim();

  if (LANDMARK_TAGS[tag] !== undefined) {
    let w = LANDMARK_TAGS[tag];
    // A `<header>` or `<footer>` inside an `<article>` is the article's own
    // byline and tagline — content, not furniture.
    if (ctx.inArticle && (tag === 'header' || tag === 'footer')) w = 0;
    else if (ctx.inArticle && tag === 'aside') w = 0.55;
    if (w > 0) { score = Math.max(score, w); detail.push(`<${tag}>`); }
  }
  if (role && LANDMARK_ROLES[role] !== undefined && LANDMARK_ROLES[role] > 0) {
    score = Math.max(score, LANDMARK_ROLES[role]);
    detail.push(`role=${role}`);
  }
  if ((attrOf(node, 'aria-hidden') || '').toLowerCase() === 'true') { score = Math.max(score, 1.0); detail.push('aria-hidden'); }
  if (attrOf(node, 'hidden') !== null) { score = Math.max(score, 1.0); detail.push('hidden'); }
  if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(attrOf(node, 'style') || '')) {
    score = Math.max(score, 1.0); detail.push('style-hidden');
  }
  if (tag === 'a' && (attrOf(node, 'href') || '').startsWith('#') && SKIP_LINK_RE.test(textOf(node))) {
    score = Math.max(score, 1.35); detail.push('skip-link');
  }
  return { score, detail };
}

/**
 * (b) Link-density ratio with a short-text guard.
 *
 * The guard matters: a one-sentence paragraph containing a single link has a
 * link density near 1.0 and is unquestionably content. Density only speaks
 * when there is either enough text to be sure or enough links to be a list of
 * links rather than a sentence.
 * @param {any} node
 * @param {{textChars: number, linkChars: number, interactiveChars: number, linkCount: number, itemCount: number}} stats
 * @returns {{score: number, detail: string[], density: number}}
 */
export function linkSignal(node, stats) {
  const { textChars, linkChars, interactiveChars, linkCount } = stats;
  const density = textChars > 0 ? Math.min(1, interactiveChars / textChars) : 0;
  const linkDensity = textChars > 0 ? Math.min(1, linkChars / textChars) : 0;
  /** @type {string[]} */
  const detail = [];

  // Short-text guard: not enough evidence either way.
  if (textChars < 80 && linkCount <= 1) return { score: 0, detail, density: linkDensity };
  if (linkCount === 0) return { score: 0, detail, density: 0 };

  let score = 0;
  if (linkCount >= 3 && density >= 0.6) {
    score = 0.9 + Math.min(0.35, density - 0.6);
    detail.push(`density=${density.toFixed(2)} over ${linkCount} links`);
  } else if (density > 0.45) {
    score = (density - 0.45) * 1.6;
    detail.push(`density=${density.toFixed(2)}`);
  }
  // A list of links: many targets, almost no prose around them.
  const perLink = linkCount > 0 ? textChars / linkCount : Infinity;
  if (linkCount >= 5 && perLink < 32) {
    score += 0.5;
    detail.push(`${linkCount} links averaging ${perLink.toFixed(0)} chars`);
  }
  return { score: Math.min(1.4, score), detail, density: linkDensity };
}

/**
 * (c) Boilerplate lexicon and structural signatures.
 * @param {any} node
 * @param {{textChars: number}} stats
 * @returns {{score: number, detail: string[], names: string[]}}
 */
export function boilerplateSignal(node, stats) {
  const identity = identityString(node, { includeTag: false });
  const text = textOf(node).toLowerCase();
  /** @type {string[]} */
  const detail = [];
  /** @type {Set<string>} */
  const names = new Set();

  let structural = 0;
  for (const entry of CHROME_LEXICON) {
    if (entry.re.test(identity)) {
      if (entry.w > structural) structural = entry.w;
      names.add(entry.name);
      detail.push(`class:${entry.name}`);
    }
  }
  let lexical = 0;
  for (const entry of CHROME_PHRASES) {
    if (stats.textChars <= entry.max && entry.re.test(text)) {
      if (entry.w > lexical) lexical = entry.w;
      names.add(entry.name);
      detail.push(`text:${entry.name}`);
    }
  }
  // Two independent kinds of evidence for the same furniture is worth more
  // than either alone, but not their sum.
  let score = Math.max(structural, lexical);
  if (structural > 0 && lexical > 0) score += 0.3;
  // A form whose only fields are an email box is a subscribe shell.
  if (tagOf(node) === 'form' || firstElement(node, (n) => tagOf(n) === 'input' && /email|search/i.test(`${attrOf(n, 'type')} ${attrOf(n, 'name')} ${attrOf(n, 'placeholder')}`))) {
    if (stats.textChars < 400) { score += 0.45; detail.push('form:capture'); names.add('form'); }
  }
  return { score: Math.min(1.5, score), detail, names: [...names] };
}

/**
 * (d) Repeated-across-pages detection — the strongest signal available, and the
 * only one that needs no assumption about how a particular site is built. If
 * the same words or the same shell appear on another page of the same site,
 * they are the site, not the page.
 * @param {any} node
 * @param {{texts: Map<string, number>, structs: Map<string, number>, pages: number}|null} index
 * @param {{textChars: number}} stats
 * @returns {{score: number, detail: string[]}}
 */
export function repeatSignal(node, index, stats) {
  /** @type {string[]} */
  const detail = [];
  if (!index || index.pages === 0) return { score: 0, detail };
  let score = 0;

  const tsig = textSignature(node);
  if (tsig.length >= 25) {
    const hits = index.texts.get(tsig) || 0;
    if (hits > 0) {
      score += 1.6 + (hits >= index.pages ? 0.2 : 0);
      detail.push(`same text on ${hits}/${index.pages} sibling page(s)`);
    }
  }
  const ssig = structSignature(node);
  if (distinctiveStruct(ssig) && stats.textChars < 1500) {
    const hits = index.structs.get(ssig) || 0;
    if (hits > 0) {
      score += 1.0 + 0.2 * Math.min(1, (hits - 1) / 2);
      detail.push(`same structure on ${hits}/${index.pages} sibling page(s)`);
    }
  }
  return { score: Math.min(1.9, score), detail };
}

/**
 * Negative evidence: prose. Real content has paragraphs, sentences and
 * headings, and does not spend its characters on links.
 * @param {any} node
 * @param {{textChars: number, linkChars: number, interactiveChars: number}} stats
 * @returns {{score: number, detail: string[]}}
 */
export function contentSignal(node, stats) {
  /** @type {string[]} */
  const detail = [];
  const density = stats.textChars > 0 ? stats.interactiveChars / stats.textChars : 0;
  let score = 0;
  const tag = tagOf(node);
  const role = (attrOf(node, 'role') || '').toLowerCase();

  if (tag === 'article' || role === 'article' || role === 'main' || tag === 'main') {
    score += 1.0; detail.push('article-landmark');
  }
  if (attrOf(node, 'itemprop') === 'articleBody' || /\b(article-?body|post-?body|entry-?content|rich-?text|prose)\b/.test(identityString(node))) {
    score += 0.7; detail.push('article-body-class');
  }
  if (density < 0.35) {
    const proseChars = Math.max(0, stats.textChars - boilerplateChars(node));
    const prose = Math.min(1, proseChars / 700) * 0.55;
    if (prose > 0) { score += prose; detail.push(`${proseChars} chars of prose`); }
  }
  let longParas = 0;
  walk(node, (n) => {
    if (isElement(n) && tagOf(n) === 'p') {
      const t = textOf(n);
      // Boilerplate text is not evidence of content, however long it is: a
      // consent line and a "enter your email address" invitation are both full
      // sentences, and counting them as prose is how a lead-capture shell
      // talks its way into a specimen.
      if (t.length >= 60 && !isBoilerplateText(t)) longParas += 1;
    }
    return true;
  });
  if (longParas >= 2 && density < 0.35) { score += 0.35; detail.push(`${longParas} full paragraphs`); }
  if (longParas >= 1 && density < 0.4 && firstElement(node, (n) => /^h[1-3]$/.test(tagOf(n)))) {
    score += 0.3; detail.push('heading with prose');
  }
  return { score: Math.min(1.7, score), detail };
}

/**
 * True when a run of text is one of the phrases the boilerplate lexicon knows.
 * @param {string} text
 * @returns {boolean}
 */
export function isBoilerplateText(text) {
  const t = text.toLowerCase();
  for (const entry of CHROME_PHRASES) {
    if (t.length <= entry.max && entry.re.test(t)) return true;
  }
  return false;
}

/**
 * Characters of a subtree that belong to boilerplate paragraphs, discounted
 * from the prose the content signal credits.
 * @param {any} node
 * @returns {number}
 */
function boilerplateChars(node) {
  let chars = 0;
  walk(node, (n) => {
    if (!isElement(n)) return true;
    const tag = tagOf(n);
    if (tag !== 'p' && tag !== 'li') return true;
    const t = textOf(n);
    if (isBoilerplateText(t)) { chars += t.length; return false; }
    return true;
  });
  return chars;
}

/**
 * Score one candidate block. The classifier is the sum of the four positive
 * signals less the content signal; `CHROME_THRESHOLD` decides.
 * @param {any} node
 * @param {{root: any, index?: any, rootContentChars?: number}} ctx
 * @returns {{score: number, reason: string, signals: Record<string, number>, detail: string[], threshold: number}}
 */
export function scoreBlock(node, ctx) {
  const stats = textStats(node);
  const inArticle = Boolean(closest(node.parent, (n) => tagOf(n) === 'article' || (attrOf(n, 'role') || '').toLowerCase() === 'article'));
  const landmark = landmarkSignal(node, { inArticle });
  const link = linkSignal(node, stats);
  const boiler = boilerplateSignal(node, stats);
  const repeat = repeatSignal(node, ctx.index || null, stats);
  const content = contentSignal(node, stats);

  const score = landmark.score + link.score + boiler.score + repeat.score - content.score;
  /** @type {Record<string, number>} */
  const signals = {
    landmark: landmark.score,
    linkDensity: link.score,
    boilerplate: boiler.score,
    repeated: repeat.score,
    content: -content.score,
  };
  const ranked = [
    ['repeated-across-pages', repeat.score],
    ['landmark', landmark.score],
    ['boilerplate', boiler.score],
    ['link-density', link.score],
  ].sort((a, b) => b[1] - a[1]);
  const reason = ranked[0][1] > 0 ? String(ranked[0][0]) : 'low-content';

  // The dominant-block guard: never lose the page to one confident mistake.
  const nonLink = Math.max(0, stats.textChars - stats.interactiveChars);
  const rootNonLink = ctx.rootContentChars || 0;
  const dominant = rootNonLink > 0 && nonLink >= DOMINANT_SHARE * rootNonLink;
  const holdsHeadline = Boolean(ctx.headline) && contains(node, ctx.headline);
  const threshold = Math.max(
    dominant ? DOMINANT_THRESHOLD : CHROME_THRESHOLD,
    holdsHeadline ? HEADLINE_THRESHOLD : CHROME_THRESHOLD,
  );

  return {
    score,
    reason,
    signals,
    threshold,
    detail: [...landmark.detail, ...link.detail, ...boiler.detail, ...repeat.detail,
      ...(content.score > 0 ? content.detail.map((d) => `content:${d}`) : [])],
  };
}

/**
 * Main-content locator. `<main>` and `role=main` are authoritative when
 * present, then a single `<article>`, then a text-density peak: descend while
 * one child still holds most of the page's non-link text, which lands on the
 * smallest container that still contains the content.
 * @param {any} body
 * @returns {{root: any, how: 'main'|'role-main'|'article'|'density'|'body'}}
 */
export function locateMainRoot(body) {
  const main = firstElement(body, (n) => tagOf(n) === 'main');
  if (main && textOf(main).length > 0) return { root: main, how: 'main' };
  const roleMain = firstElement(body, (n) => (attrOf(n, 'role') || '').toLowerCase() === 'main');
  if (roleMain && textOf(roleMain).length > 0) return { root: roleMain, how: 'role-main' };

  const articles = elements(body).filter((n) => tagOf(n) === 'article');
  if (articles.length === 1 && contentChars(articles[0]) >= 0.4 * contentChars(body)) {
    return { root: articles[0], how: 'article' };
  }
  if (articles.length > 1) {
    // Several articles: their common parent is the content region.
    const common = commonAncestor(articles);
    if (common && common !== body && contentChars(common) >= 0.5 * contentChars(body)) {
      return { root: common, how: 'article' };
    }
  }

  let cur = body;
  const total = contentChars(body);
  if (total > 0) {
    for (;;) {
      const kids = childrenOf(cur).filter(isElement);
      let best = null;
      let bestChars = 0;
      for (const k of kids) {
        const c = contentChars(k);
        if (c > bestChars) { bestChars = c; best = k; }
      }
      if (!best || bestChars < 0.75 * total) break;
      if (NON_RENDERED.has(tagOf(best))) break;
      cur = best;
    }
  }
  return cur === body ? { root: body, how: 'body' } : { root: cur, how: 'density' };
}

/**
 * The page's own headline: the first `h1` inside the extraction root, or the
 * first `h2` when a page has none.
 * @param {any} root
 * @returns {any|null}
 */
export function primaryHeadline(root) {
  return firstElement(root, (n) => tagOf(n) === 'h1') || firstElement(root, (n) => tagOf(n) === 'h2');
}

/** Non-link text characters — the quantity a content locator should maximise. */
function contentChars(node) {
  const s = textStats(node);
  return Math.max(0, s.textChars - s.interactiveChars);
}

/** @param {any[]} nodes @returns {any|null} */
function commonAncestor(nodes) {
  if (nodes.length === 0) return null;
  let chain = [nodes[0], ...ancestors(nodes[0])].reverse();
  for (const n of nodes.slice(1)) {
    const other = [n, ...ancestors(n)].reverse();
    let i = 0;
    while (i < chain.length && i < other.length && chain[i] === other[i]) i += 1;
    chain = chain.slice(0, i);
  }
  return chain.length ? chain[chain.length - 1] : null;
}

/**
 * Drop elements that never render. They carry no blocks, so leaving them out of
 * the removal log keeps the studio's restore list about content decisions; the
 * untouched `raw` HTML on the specimen remains the true fallback (D-L6-2).
 * @param {any} root
 * @returns {number} how many were dropped
 */
export function dropNonRendered(root) {
  let n = 0;
  const doomed = [];
  walk(root, (node) => {
    if (node.type === 'comment') { doomed.push(node); return false; }
    if (isElement(node)) {
      const tag = tagOf(node);
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'iframe') {
        doomed.push(node); return false;
      }
    }
    return true;
  });
  for (const d of doomed) { if (detach(d)) n += 1; }
  return n;
}

/**
 * Classify without mutating: returns the extraction root and every subtree that
 * should be removed, outermost first, each with its reason and score.
 * @param {any} body
 * @param {{siblings?: any[], index?: any, threshold?: number}} [options]
 * @returns {{root: any, how: string, removed: any[]}}
 */
export function classifyChrome(body, options = {}) {
  const index = options.index || (options.siblings && options.siblings.length ? siblingIndex(options.siblings) : null);
  const located = locateMainRoot(body);
  const root = located.root;
  const rootContentChars = contentChars(root);
  const headline = primaryHeadline(root);
  const ctx = { root, index, rootContentChars, headline };

  /** @type {any[]} */
  const removed = [];

  // Pass A — everything outside the extraction root.
  if (root !== body) {
    const visitOutside = (node) => {
      for (const child of childrenOf(node).filter(isElement)) {
        if (child === root) continue;
        if (contains(child, root)) { visitOutside(child); continue; }
        const scored = scoreBlock(child, ctx);
        removed.push(entryFor(child, body, root, scored, true));
      }
    };
    visitOutside(body);
  }

  // Pass B — chrome inside the extraction root.
  const visitInside = (node) => {
    for (const child of childrenOf(node).filter(isElement)) {
      const tag = tagOf(child);
      if (NON_RENDERED.has(tag)) continue;
      const scored = scoreBlock(child, ctx);
      if (scored.score >= (options.threshold || scored.threshold)) {
        removed.push(entryFor(child, body, root, scored, false));
        continue;
      }
      // The parts of a quote, figure, table or paragraph are that block, not
      // blocks of their own, so scoring stops here.
      if (ATOMIC_CONTAINERS.has(tag)) continue;
      visitInside(child);
    }
  };
  visitInside(root);

  return { root, how: located.how, removed };
}

/** @returns {any} */
function entryFor(node, body, root, scored, outsideRoot) {
  return {
    node,
    reason: outsideRoot && scored.score < CHROME_THRESHOLD ? 'outside-main-root' : scored.reason,
    score: Number(scored.score.toFixed(4)),
    signals: scored.signals,
    detail: scored.detail,
    outsideRoot,
    selector: selectorPath(node, body),
    path: indexPath(body, node) || [],
    text: textOf(node).slice(0, 240),
    where: null,
  };
}

/**
 * §8 / API.md L6: strip chrome from a parsed document.
 *
 * Works on a clone, so the caller's tree is untouched. Every removed subtree
 * comes back in `removed` with the reason it was removed, its score, the signal
 * breakdown behind that score and the exact position it occupied — the studio
 * restores from this, and `restoreNode` puts it back byte for byte.
 *
 * @param {any} doc parsed document or fragment (`DocNode`)
 * @param {{siblings?: any[], threshold?: number}} [options]
 * @returns {{root: any, removed: {node: any, reason: string, score: number}[], how: string, body: any}}
 */
export function stripChrome(doc, options = {}) {
  const clone = linkParents(cloneTree(doc));
  const body = bodyOf(clone);
  dropNonRendered(body);
  const { root, how, removed } = classifyChrome(body, options);
  for (const entry of removed) entry.where = detach(entry.node);
  return { root, removed, how, body };
}

/**
 * Put a stripped subtree back exactly where it was. Exact inverse of the
 * detach performed by `stripChrome`.
 * @param {{node: any, where: any}} entry
 * @returns {boolean}
 */
export function restoreNode(entry) {
  if (!entry || !entry.where || !entry.node) return false;
  reattach(entry.node, entry.where);
  entry.where = null;
  return true;
}
