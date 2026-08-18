/**
 * HTML character references (§6, D8).
 *
 * The parser needs to turn `&amp;`, `&#8212;` and `&hellip;` into text before a
 * single byte of a prospect's copy reaches a specimen, because a proof that
 * renders "Don&#39;t settle" in front of a CMO is a defect that costs the room.
 *
 * The table is the HTML 4.01 / XHTML entity set (252 names) plus the handful of
 * HTML5 additions that appear in real marketing copy. It is stored as a compact
 * `name:codepoint` string and expanded once, so the source stays readable and
 * the module stays small enough to inline into a single-file studio.
 *
 * Two rules from the HTML5 tokenizer are honoured because real pages depend on
 * them:
 *   - numeric references in the C1 range are mapped through Windows-1252, which
 *     is what every browser does and what every CMS emits;
 *   - a *legacy* subset of named references is recognised without the trailing
 *     semicolon (`&copy`, `&nbsp`), but never inside an attribute value that
 *     continues with `=` or an alphanumeric — otherwise `?x=1&sect=2` silently
 *     becomes `?x=1§=2`.
 *
 * @module ingest/entities
 */

/** `name:codepoint` pairs, semicolon-separated. Codepoints are decimal. */
const TABLE_SOURCE = [
  // XML / core
  'quot:34;amp:38;apos:39;lt:60;gt:62',
  // Latin-1 supplement
  'nbsp:160;iexcl:161;cent:162;pound:163;curren:164;yen:165;brvbar:166;sect:167',
  'uml:168;copy:169;ordf:170;laquo:171;not:172;shy:173;reg:174;macr:175',
  'deg:176;plusmn:177;sup2:178;sup3:179;acute:180;micro:181;para:182;middot:183',
  'cedil:184;sup1:185;ordm:186;raquo:187;frac14:188;frac12:189;frac34:190;iquest:191',
  'Agrave:192;Aacute:193;Acirc:194;Atilde:195;Auml:196;Aring:197;AElig:198;Ccedil:199',
  'Egrave:200;Eacute:201;Ecirc:202;Euml:203;Igrave:204;Iacute:205;Icirc:206;Iuml:207',
  'ETH:208;Ntilde:209;Ograve:210;Oacute:211;Ocirc:212;Otilde:213;Ouml:214;times:215',
  'Oslash:216;Ugrave:217;Uacute:218;Ucirc:219;Uuml:220;Yacute:221;THORN:222;szlig:223',
  'agrave:224;aacute:225;acirc:226;atilde:227;auml:228;aring:229;aelig:230;ccedil:231',
  'egrave:232;eacute:233;ecirc:234;euml:235;igrave:236;iacute:237;icirc:238;iuml:239',
  'eth:240;ntilde:241;ograve:242;oacute:243;ocirc:244;otilde:245;ouml:246;divide:247',
  'oslash:248;ugrave:249;uacute:250;ucirc:251;uuml:252;yacute:253;thorn:254;yuml:255',
  // Latin Extended-A / B, spacing modifiers
  'OElig:338;oelig:339;Scaron:352;scaron:353;Yuml:376;fnof:402;circ:710;tilde:732',
  // Greek
  'Alpha:913;Beta:914;Gamma:915;Delta:916;Epsilon:917;Zeta:918;Eta:919;Theta:920',
  'Iota:921;Kappa:922;Lambda:923;Mu:924;Nu:925;Xi:926;Omicron:927;Pi:928',
  'Rho:929;Sigma:931;Tau:932;Upsilon:933;Phi:934;Chi:935;Psi:936;Omega:937',
  'alpha:945;beta:946;gamma:947;delta:948;epsilon:949;zeta:950;eta:951;theta:952',
  'iota:953;kappa:954;lambda:955;mu:956;nu:957;xi:958;omicron:959;pi:960',
  'rho:961;sigmaf:962;sigma:963;tau:964;upsilon:965;phi:966;chi:967;psi:968',
  'omega:969;thetasym:977;upsih:978;piv:982',
  // General punctuation
  'ensp:8194;emsp:8195;thinsp:8201;zwnj:8204;zwj:8205;lrm:8206;rlm:8207',
  'ndash:8211;mdash:8212;horbar:8213;lsquo:8216;rsquo:8217;sbquo:8218',
  'ldquo:8220;rdquo:8221;bdquo:8222;dagger:8224;Dagger:8225;bull:8226;hellip:8230',
  'permil:8240;prime:8242;Prime:8243;lsaquo:8249;rsaquo:8250;oline:8254;frasl:8260',
  'euro:8364;image:8465;weierp:8472;real:8476;trade:8482;alefsym:8501',
  // Arrows
  'larr:8592;uarr:8593;rarr:8594;darr:8595;harr:8596;crarr:8629',
  'lArr:8656;uArr:8657;rArr:8658;dArr:8659;hArr:8660',
  // Mathematical operators
  'forall:8704;part:8706;exist:8707;empty:8709;nabla:8711;isin:8712;notin:8713',
  'ni:8715;prod:8719;sum:8721;minus:8722;lowast:8727;radic:8730;prop:8733;infin:8734',
  'ang:8736;and:8743;or:8744;cap:8745;cup:8746;int:8747;there4:8756;sim:8764',
  'cong:8773;asymp:8776;ne:8800;equiv:8801;le:8804;ge:8805;sub:8834;sup:8835',
  'nsub:8836;sube:8838;supe:8839;oplus:8853;otimes:8855;perp:8869;sdot:8901',
  // Technical / geometric / dingbats
  'lceil:8968;rceil:8969;lfloor:8970;rfloor:8971;lang:9001;rang:9002',
  'loz:9674;spades:9824;clubs:9827;hearts:9829;diams:9830',
  // HTML5 additions that show up in real copy
  'star:9734;starf:9733;check:10003;cross:10007;nbsp:160;numsp:8199;puncsp:8200',
  'hairsp:8202;tridot:9708;copysr:8471;bsol:92;sol:47;lowbar:95;grave:96;verbar:124',
  'lcub:123;rcub:125;lsqb:91;rsqb:93;lpar:40;rpar:41;excl:33;quest:63;num:35',
  'dollar:36;percnt:37;ast:42;plus:43;comma:44;period:46;colon:58;semi:59',
  'equals:61;commat:64;Hat:94;lbrace:123;rbrace:125;nldr:8229;dtri:9663;utri:9653',
].join(';');

/** @type {Map<string, string>} name (without `&` or `;`) → replacement text. */
export const NAMED_ENTITIES = (() => {
  /** @type {Map<string, string>} */
  const m = new Map();
  for (const pair of TABLE_SOURCE.split(';')) {
    if (!pair) continue;
    const i = pair.lastIndexOf(':');
    if (i < 0) continue;
    const name = pair.slice(0, i);
    const cp = Number(pair.slice(i + 1));
    if (!name || !Number.isFinite(cp)) continue;
    if (!m.has(name)) m.set(name, String.fromCodePoint(cp));
  }
  return m;
})();

/**
 * The references HTML5 still recognises without a trailing semicolon. Anything
 * outside this set requires the semicolon, which is what keeps query strings
 * intact.
 * @type {Set<string>}
 */
export const LEGACY_ENTITIES = new Set([
  'AElig', 'AMP', 'Aacute', 'Acirc', 'Agrave', 'Aring', 'Atilde', 'Auml', 'COPY', 'Ccedil',
  'ETH', 'Eacute', 'Ecirc', 'Egrave', 'Euml', 'GT', 'Iacute', 'Icirc', 'Igrave', 'Iuml',
  'LT', 'Ntilde', 'Oacute', 'Ocirc', 'Ograve', 'Oslash', 'Otilde', 'Ouml', 'QUOT', 'REG',
  'THORN', 'Uacute', 'Ucirc', 'Ugrave', 'Uuml', 'Yacute', 'aacute', 'acirc', 'acute',
  'aelig', 'agrave', 'amp', 'aring', 'atilde', 'auml', 'brvbar', 'ccedil', 'cedil', 'cent',
  'copy', 'curren', 'deg', 'divide', 'eacute', 'ecirc', 'egrave', 'eth', 'euml', 'frac12',
  'frac14', 'frac34', 'gt', 'iacute', 'icirc', 'iexcl', 'igrave', 'iquest', 'iuml', 'laquo',
  'lt', 'macr', 'micro', 'middot', 'nbsp', 'not', 'ntilde', 'oacute', 'ocirc', 'ograve',
  'ordf', 'ordm', 'oslash', 'otilde', 'ouml', 'para', 'plusmn', 'pound', 'quot', 'raquo',
  'reg', 'sect', 'shy', 'sup1', 'sup2', 'sup3', 'szlig', 'thorn', 'times', 'uacute', 'ucirc',
  'ugrave', 'uml', 'uuml', 'yacute', 'yen', 'yuml',
]);

/** HTML5's Windows-1252 override for numeric references in the C1 range. */
const C1_OVERRIDE = new Map([
  [0x80, 0x20ac], [0x82, 0x201a], [0x83, 0x0192], [0x84, 0x201e], [0x85, 0x2026],
  [0x86, 0x2020], [0x87, 0x2021], [0x88, 0x02c6], [0x89, 0x2030], [0x8a, 0x0160],
  [0x8b, 0x2039], [0x8c, 0x0152], [0x8e, 0x017d], [0x91, 0x2018], [0x92, 0x2019],
  [0x93, 0x201c], [0x94, 0x201d], [0x95, 0x2022], [0x96, 0x2013], [0x97, 0x2014],
  [0x98, 0x02dc], [0x99, 0x2122], [0x9a, 0x0161], [0x9b, 0x203a], [0x9c, 0x0153],
  [0x9e, 0x017e], [0x9f, 0x0178],
]);

/** Longest named reference, so the scanner knows how far to look ahead. */
const MAX_NAME_LENGTH = (() => {
  let n = 0;
  for (const k of NAMED_ENTITIES.keys()) if (k.length > n) n = k.length;
  return n;
})();

/**
 * Resolve one numeric reference body (everything between `&#` and `;`).
 * @param {string} body
 * @returns {string|null}
 */
function numericReference(body) {
  let cp;
  if (body[0] === 'x' || body[0] === 'X') {
    if (!/^[0-9a-fA-F]+$/.test(body.slice(1))) return null;
    cp = parseInt(body.slice(1), 16);
  } else {
    if (!/^[0-9]+$/.test(body)) return null;
    cp = parseInt(body, 10);
  }
  if (!Number.isFinite(cp)) return null;
  if (C1_OVERRIDE.has(cp)) cp = /** @type {number} */ (C1_OVERRIDE.get(cp));
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

/**
 * Decode character references in a run of text or in an attribute value.
 *
 * @param {string} input
 * @param {{ inAttribute?: boolean }} [options]
 * @returns {string}
 */
export function decodeEntities(input, options = {}) {
  const s = String(input);
  if (s.indexOf('&') < 0) return s;
  const inAttribute = options.inAttribute === true;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const amp = s.indexOf('&', i);
    if (amp < 0) { out += s.slice(i); break; }
    out += s.slice(i, amp);
    const next = s[amp + 1];
    if (next === '#') {
      const semi = s.indexOf(';', amp + 2);
      // A numeric reference may legally run to a non-digit rather than a `;`.
      let end = amp + 2;
      const hex = s[end] === 'x' || s[end] === 'X';
      let j = hex ? end + 1 : end;
      while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
      const body = s.slice(amp + 2, j);
      const resolved = body ? numericReference(body) : null;
      if (resolved !== null) {
        out += resolved;
        i = s[j] === ';' ? j + 1 : j;
        continue;
      }
      out += '&';
      i = amp + 1;
      if (semi < 0) { /* nothing more to try */ }
      continue;
    }
    // Named reference: longest match wins.
    let matched = '';
    let matchedName = '';
    const limit = Math.min(s.length, amp + 1 + MAX_NAME_LENGTH + 1);
    for (let j = amp + 1; j < limit; j++) {
      const ch = s[j];
      if (ch === ';') {
        const name = s.slice(amp + 1, j);
        const value = NAMED_ENTITIES.get(name);
        if (value !== undefined) { matched = value; matchedName = s.slice(amp, j + 1); }
        break;
      }
      if (!/[0-9a-zA-Z]/.test(ch)) break;
      const name = s.slice(amp + 1, j + 1);
      if (LEGACY_ENTITIES.has(name) && NAMED_ENTITIES.has(name)) {
        // Keep scanning for a longer, semicolon-terminated match, but remember
        // this one. In an attribute the legacy form is only honoured when the
        // next character cannot continue a name or an assignment.
        const after = s[j + 1];
        const attributeSafe = !inAttribute || !(after === '=' || (after !== undefined && /[0-9a-zA-Z]/.test(after)));
        if (attributeSafe) {
          matched = /** @type {string} */ (NAMED_ENTITIES.get(name));
          matchedName = s.slice(amp, j + 1);
        }
      }
    }
    if (matchedName) {
      out += matched;
      i = amp + matchedName.length;
      continue;
    }
    out += '&';
    i = amp + 1;
  }
  return out;
}

/**
 * Escape text for safe re-serialisation. Used when an importer has to rebuild
 * HTML it did not author (MHTML part bodies, saved-page fragments).
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
