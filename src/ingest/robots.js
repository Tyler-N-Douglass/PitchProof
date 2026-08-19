/**
 * `robots.txt` — parsing, and the allow/deny question (§6).
 *
 * Two things use it. Sitemap discovery reads the `Sitemap:` lines, and
 * sub-resource collection asks whether a path may be fetched.
 *
 * The distinction that matters: the **document** a user pastes is never gated
 * on `robots.txt`. PitchProof is not a crawler there — it is fetching one page
 * a person is already looking at, on their behalf, at their request. Collecting
 * that page's sub-resources afterwards *is* automated, so it is gated. That is
 * the same line a browser's reader mode draws, and it is the honest one.
 *
 * Matching follows the de-facto standard the major crawlers implement: the most
 * specific group wins, `*` and `$` are honoured inside a path, and the longest
 * matching rule wins with `Allow` beating `Disallow` on an exact-length tie.
 *
 * @module ingest/robots
 */

/**
 * @typedef {object} RobotsGroup
 * @property {string[]} agents      lowercased user-agent tokens
 * @property {{allow: boolean, path: string}[]} rules
 */

/**
 * @typedef {object} Robots
 * @property {RobotsGroup[]} groups
 * @property {string[]} sitemaps
 * @property {boolean} present      false when no robots.txt could be read
 */

/** A permissive record, used when robots.txt is absent or unreadable. */
export function emptyRobots() {
  return { groups: [], sitemaps: [], present: false };
}

/**
 * Parse a `robots.txt`.
 *
 * @param {string} text
 * @returns {Robots}
 */
export function parseRobots(text) {
  /** @type {Robots} */
  const robots = { groups: [], sitemaps: [], present: true };
  const source = String(text == null ? '' : text);
  if (!source.trim()) { robots.present = false; return robots; }

  /** @type {RobotsGroup|null} */
  let group = null;
  let expectingAgent = false;

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const at = line.indexOf(':');
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase();
    const value = line.slice(at + 1).trim();

    if (field === 'user-agent') {
      if (!group || !expectingAgent) {
        group = { agents: [], rules: [] };
        robots.groups.push(group);
      }
      group.agents.push(value.toLowerCase());
      expectingAgent = true;
      continue;
    }
    if (field === 'sitemap') {
      if (value) robots.sitemaps.push(value);
      continue;
    }
    if (field === 'allow' || field === 'disallow') {
      expectingAgent = false;
      if (!group) { group = { agents: ['*'], rules: [] }; robots.groups.push(group); }
      // `Disallow:` with an empty value allows everything and carries no rule.
      if (field === 'disallow' && value === '') continue;
      group.rules.push({ allow: field === 'allow', path: value });
      continue;
    }
    expectingAgent = false;
  }
  return robots;
}

/**
 * The group that applies to a user agent: the most specific name match, else
 * the `*` group, else nothing.
 * @param {Robots} robots
 * @param {string} userAgent
 * @returns {RobotsGroup|null}
 */
export function groupFor(robots, userAgent = '*') {
  if (!robots || !robots.groups.length) return null;
  const ua = String(userAgent || '*').toLowerCase();
  /** @type {RobotsGroup|null} */
  let best = null;
  let bestLength = -1;
  /** @type {RobotsGroup|null} */
  let wildcard = null;
  for (const group of robots.groups) {
    for (const agent of group.agents) {
      if (agent === '*') { if (!wildcard) wildcard = group; continue; }
      if (ua !== '*' && ua.includes(agent) && agent.length > bestLength) { best = group; bestLength = agent.length; }
    }
  }
  return best || wildcard;
}

/**
 * Does a rule pattern match a path? `*` matches any run, `$` anchors the end.
 * @param {string} pattern
 * @param {string} path
 * @returns {boolean}
 */
export function ruleMatches(pattern, path) {
  const p = String(pattern || '');
  if (!p) return false;
  const anchored = p.endsWith('$');
  const body = anchored ? p.slice(0, -1) : p;
  const parts = body.split('*');
  let at = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '') continue;
    if (i === 0) {
      if (!path.startsWith(part)) return false;
      at = part.length;
      continue;
    }
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  if (anchored) {
    const tail = parts[parts.length - 1];
    return tail === '' ? true : path.endsWith(tail) && at === path.length;
  }
  return true;
}

/**
 * May this URL be fetched?
 *
 * An absent or unreadable `robots.txt` allows everything — that is what the
 * standard says, and guessing the other way would break ingest on every site
 * that simply has no such file.
 *
 * @param {Robots|null} robots
 * @param {string} url      an absolute URL, or a path
 * @param {string} [userAgent]
 * @returns {boolean}
 */
export function robotsAllows(robots, url, userAgent = '*') {
  if (!robots || !robots.present) return true;
  const group = groupFor(robots, userAgent);
  if (!group || !group.rules.length) return true;

  let path = String(url || '/');
  try {
    const parsed = new URL(path);
    path = `${parsed.pathname}${parsed.search}`;
  } catch { /* already a path */ }
  if (!path.startsWith('/')) path = `/${path}`;

  let verdict = true;
  let bestLength = -1;
  for (const rule of group.rules) {
    if (!ruleMatches(rule.path, path)) continue;
    const length = rule.path.replace(/\$$/, '').length;
    if (length > bestLength || (length === bestLength && rule.allow)) {
      bestLength = length;
      verdict = rule.allow;
    }
  }
  return verdict;
}
