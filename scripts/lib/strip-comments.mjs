/**
 * Remove comments from bundled JavaScript and CSS.
 *
 * The §20 critic measured 158,804 bytes of source comments in a 431,608-byte
 * runtime bundle — 36.8% of it — shipping inside every artifact, while §13's
 * budgeter progressively downscales the *client's* images, which were 3.8% of
 * the same file. The degradation report told a seller their hero image had been
 * resampled to 15% while the largest removable payload was never considered.
 *
 * This is a scanner, not a parser, but it is a complete one for the constructs
 * that decide where a comment is: single and double quoted strings, template
 * literals including nested `${}` interpolation, and regular-expression
 * literals including character classes. Getting any of those wrong would
 * corrupt an artifact, so `test/core/strip-comments.test.mjs` checks each case
 * directly and `scripts/build.mjs` additionally asserts that a stripped bundle
 * still evaluates to the same export surface as the unstripped one.
 *
 * It removes comments only. It does not rename, reformat, or shorten anything
 * else — the emitted bytes must stay a readable, auditable copy of the source,
 * because §18.4 makes "verified at emit, not asserted in a README" a law and an
 * unreadable artifact cannot be audited by the person receiving it. Provenance
 * survives too: the bundler keys every module by its source path as a *string
 * literal*, not a comment, so a reader of the artifact can still see which file
 * each function came from.
 */

/** Characters after which a `/` begins a regular expression rather than division. */
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>', '\n',
]);

/** Keywords after which a `/` begins a regular expression. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * @param {string} src
 * @param {number} i  index of the `/`
 * @param {string} lastSignificant
 * @returns {boolean}
 */
function startsRegex(src, i, lastSignificant) {
  if (lastSignificant === '') return true;
  if (REGEX_PRECEDERS.has(lastSignificant)) return true;
  if (/[A-Za-z0-9_$)\]]/.test(lastSignificant)) {
    // A word character can still precede a regex when the word is a keyword:
    // `return /x/`, `typeof /x/`. Read the identifier back off the source.
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j -= 1;
    const end = j + 1;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(src[j])) j -= 1;
    return REGEX_KEYWORDS.has(src.slice(j + 1, end));
  }
  return false;
}

/**
 * Strip JavaScript comments, preserving every other byte and every line break
 * so a stack trace from the artifact still points at the right line of the
 * artifact.
 *
 * @param {string} src
 * @param {{keepLines?: boolean}} [options]
 * @returns {string}
 */
export function stripComments(src, options = {}) {
  const keepLines = options.keepLines !== false;
  let out = '';
  let lastSignificant = '';
  /**
   * One entry per template literal whose interpolation we are currently inside,
   * holding the brace depth that was in force when `${` opened. A `}` closes an
   * interpolation only when the depth is back to that entry plus one — which is
   * what keeps an object literal inside an interpolation from ending it.
   * @type {number[]}
   */
  const templateStack = [];
  let braceDepth = 0;
  let i = 0;

  /**
   * Copy a run of template-literal text starting at `from`, then either close
   * the literal or open its next interpolation. Returns the index to resume at.
   * @param {number} from
   * @returns {number}
   */
  const copyTemplateChunk = (from) => {
    const end = scanTemplateChunk(src, from);
    out += src.slice(from, end);
    if (end >= src.length) return end;
    if (src[end] === '`') {           // the literal ends here
      out += '`';
      lastSignificant = '`';
      return end + 1;
    }
    out += '${';                      // an interpolation opens here
    templateStack.push(braceDepth);
    braceDepth += 1;
    lastSignificant = '{';
    return end + 2;
  };

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    // --- comments ---------------------------------------------------------
    if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      if (end < 0) break;             // a trailing comment with no newline
      i = end;                        // the newline itself is emitted next pass
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      if (keepLines) {
        // Keep the newlines the comment spanned so every later line keeps its
        // number. A comment that spanned no line just disappears.
        for (let k = i; k < stop; k += 1) if (src[k] === '\n') out += '\n';
      }
      i = stop;
      continue;
    }

    // --- strings ----------------------------------------------------------
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      lastSignificant = ch;
      continue;
    }

    // --- template literals ------------------------------------------------
    if (ch === '`') {
      out += '`';
      i = copyTemplateChunk(i + 1);
      continue;
    }
    if (ch === '}' && templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1] + 1) {
      templateStack.pop();
      braceDepth -= 1;
      out += '}';
      i = copyTemplateChunk(i + 1);
      continue;
    }

    // --- regular expressions ---------------------------------------------
    if (ch === '/' && startsRegex(src, i, lastSignificant)) {
      const end = scanRegex(src, i);
      out += src.slice(i, end);
      i = end;
      lastSignificant = '/';
      continue;
    }

    if (ch === '{') braceDepth += 1;
    else if (ch === '}') braceDepth -= 1;

    out += ch;
    if (!/\s/.test(ch)) lastSignificant = ch;
    i += 1;
  }
  return out;
}

/**
 * Index just past the closing quote.
 * @param {string} src
 * @param {number} start
 * @param {string} quote
 * @returns {number}
 */
function scanQuoted(src, start, quote) {
  for (let i = start + 1; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === quote) return i + 1;
    if (src[i] === '\n') return i;    // unterminated; stop at the line
  }
  return src.length;
}

/**
 * Index of the next unescaped `` ` `` or `${` in a template literal, exclusive.
 * @param {string} src
 * @param {number} start
 * @returns {number}
 */
function scanTemplateChunk(src, start) {
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === '\\') { i += 1; continue; }
    if (src[i] === '`') return i;
    if (src[i] === '$' && src[i + 1] === '{') return i;
  }
  return src.length;
}

/**
 * Index just past the closing `/` and its flags. Character classes are tracked
 * because a `/` inside `[...]` does not end the literal.
 * @param {string} src
 * @param {number} start
 * @returns {number}
 */
function scanRegex(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === '\\') { i += 1; continue; }
    if (c === '\n') return start + 1;             // not a regex after all
    if (c === '[') { inClass = true; continue; }
    if (c === ']') { inClass = false; continue; }
    if (c === '/' && !inClass) {
      let j = i + 1;
      while (j < src.length && /[a-z]/.test(src[j])) j += 1;
      return j;
    }
  }
  return src.length;
}

/**
 * Strip CSS comments. CSS has no line comments and no regular expressions, so
 * the only thing that has to be tracked is a quoted string — `content: "/*"` is
 * legal and must survive.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripCssComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const stop = close < 0 ? src.length : close + 2;
      for (let k = i; k < stop; k += 1) if (src[k] === '\n') out += '\n';
      i = stop;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = scanQuoted(src, i, ch);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Collapse the blank lines and trailing whitespace stripping leaves behind,
 * without touching indentation inside anything that survived.
 * @param {string} src
 * @returns {string}
 */
export function collapseBlankLines(src) {
  return src
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : line.replace(/[ \t]+$/, '')))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
}
