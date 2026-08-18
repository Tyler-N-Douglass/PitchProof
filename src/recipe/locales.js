/**
 * Locale structure, not locale strings (§9.1).
 *
 * `locale-fanout` is the first reframe payload in §9 and the easiest one to fake:
 * run the copy through a translator, put nine cards on a slide, call it done.
 * That version dies to the first question a localisation lead asks — *what
 * actually changed besides the words?*
 *
 * So the table below carries **structure**: the order a date's parts are read
 * in, the separators a number groups with, where a currency symbol sits, whether
 * a person's family name leads, the order of an address block, where the legal
 * line is allowed to sit, which plural categories the copy has to satisfy, the
 * quotation marks, the typographic spacing rules, and the writing direction.
 * Those are the things that reshape a page, and they are what the renditions
 * differ by.
 *
 * **The table never invents data.** `localizeText` only reformats numbers,
 * dates, currency amounts and quotation marks that were already in the
 * specimen — reordering a date's own digits, regrouping a number's own digits.
 * Where the source has no address and no legal line, the rendition shows a
 * labelled empty slot rather than a plausible-looking German street address.
 * That is §18.2 holding at the one place a localisation demo is most tempted to
 * break it.
 *
 * @module recipe/locales
 */

/** Narrow no-break space — French and Russian digit grouping. */
const NNBSP = '\u202F';

/**
 * @typedef {object} LocaleModel
 * @property {string} id                 BCP 47 tag
 * @property {string} name               market name, in English
 * @property {string} endonym            the locale's own name for itself
 * @property {'ltr'|'rtl'} dir
 * @property {string} datePattern        pattern notation in the locale's own letters, digit-free
 * @property {('day'|'month'|'year')[]} dateOrder
 * @property {string} dateSeparator
 * @property {string} [dateSuffixes]     ja/zh style unit suffixes, applied per part
 * @property {string} numberGroup
 * @property {string} numberDecimal
 * @property {string} numberPattern      digit-free display pattern
 * @property {'before'|'after'} currencyPosition
 * @property {boolean} currencySpace
 * @property {('given'|'family')[]} nameOrder
 * @property {string[]} addressOrder     field names in postal order
 * @property {'footer'|'before-cta'|'after-headline'} legalPlacement
 * @property {string[]} pluralCategories CLDR cardinal categories
 * @property {[string, string]} quotes
 * @property {boolean} spaceBeforeHighPunctuation  French typographic rule
 */

/**
 * Nine markets, chosen to span the structural axes rather than the biggest
 * economies: two RTL/CJK writing systems, three number-format families, three
 * name orders, two legal-line placements, and plural-category counts from one to
 * six.
 * @type {LocaleModel[]}
 */
export const LOCALES = [
  {
    id: 'en-US', name: 'United States', endonym: 'English (US)', dir: 'ltr',
    datePattern: 'MM/DD/YYYY', dateOrder: ['month', 'day', 'year'], dateSeparator: '/',
    numberGroup: ',', numberDecimal: '.', numberPattern: '#,###.##',
    currencyPosition: 'before', currencySpace: false,
    nameOrder: ['given', 'family'],
    addressOrder: ['street', 'city, state ZIP', 'country'],
    legalPlacement: 'footer',
    pluralCategories: ['one', 'other'],
    quotes: ['“', '”'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'de-DE', name: 'Germany', endonym: 'Deutsch', dir: 'ltr',
    datePattern: 'TT.MM.JJJJ', dateOrder: ['day', 'month', 'year'], dateSeparator: '.',
    numberGroup: '.', numberDecimal: ',', numberPattern: '#.###,##',
    currencyPosition: 'after', currencySpace: true,
    nameOrder: ['given', 'family'],
    addressOrder: ['street and number', 'postal code + city', 'country'],
    legalPlacement: 'before-cta',
    pluralCategories: ['one', 'other'],
    quotes: ['„', '“'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'fr-FR', name: 'France', endonym: 'Français', dir: 'ltr',
    datePattern: 'JJ/MM/AAAA', dateOrder: ['day', 'month', 'year'], dateSeparator: '/',
    numberGroup: NNBSP, numberDecimal: ',', numberPattern: `#${NNBSP}###,##`,
    currencyPosition: 'after', currencySpace: true,
    nameOrder: ['given', 'family'],
    addressOrder: ['number and street', 'postal code + city', 'country'],
    legalPlacement: 'footer',
    pluralCategories: ['one', 'many', 'other'],
    quotes: ['«', '»'],
    spaceBeforeHighPunctuation: true,
  },
  {
    id: 'es-MX', name: 'Mexico', endonym: 'Español (México)', dir: 'ltr',
    datePattern: 'DD/MM/AAAA', dateOrder: ['day', 'month', 'year'], dateSeparator: '/',
    numberGroup: ',', numberDecimal: '.', numberPattern: '#,###.##',
    currencyPosition: 'before', currencySpace: false,
    nameOrder: ['given', 'family'],
    addressOrder: ['street and number', 'neighbourhood', 'postal code + city', 'state', 'country'],
    legalPlacement: 'footer',
    pluralCategories: ['one', 'many', 'other'],
    quotes: ['«', '»'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'pt-BR', name: 'Brazil', endonym: 'Português (Brasil)', dir: 'ltr',
    datePattern: 'DD/MM/AAAA', dateOrder: ['day', 'month', 'year'], dateSeparator: '/',
    numberGroup: '.', numberDecimal: ',', numberPattern: '#.###,##',
    currencyPosition: 'before', currencySpace: true,
    nameOrder: ['given', 'family'],
    addressOrder: ['street and number', 'neighbourhood', 'city — state', 'postal code', 'country'],
    legalPlacement: 'footer',
    pluralCategories: ['one', 'many', 'other'],
    quotes: ['“', '”'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'ja-JP', name: 'Japan', endonym: '日本語', dir: 'ltr',
    datePattern: 'YYYY年M月D日', dateOrder: ['year', 'month', 'day'], dateSeparator: '/',
    dateSuffixes: '年月日',
    numberGroup: ',', numberDecimal: '.', numberPattern: '#,###.##',
    currencyPosition: 'before', currencySpace: false,
    nameOrder: ['family', 'given'],
    addressOrder: ['postal code', 'prefecture', 'city', 'district and number', 'building'],
    legalPlacement: 'before-cta',
    pluralCategories: ['other'],
    quotes: ['「', '」'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'zh-CN', name: 'China', endonym: '简体中文', dir: 'ltr',
    datePattern: 'YYYY年M月D日', dateOrder: ['year', 'month', 'day'], dateSeparator: '/',
    dateSuffixes: '年月日',
    numberGroup: ',', numberDecimal: '.', numberPattern: '#,###.##',
    currencyPosition: 'before', currencySpace: false,
    nameOrder: ['family', 'given'],
    addressOrder: ['province', 'city', 'district', 'street and number', 'postal code'],
    legalPlacement: 'footer',
    pluralCategories: ['other'],
    quotes: ['“', '”'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'ru-RU', name: 'Russia', endonym: 'Русский', dir: 'ltr',
    datePattern: 'ДД.ММ.ГГГГ', dateOrder: ['day', 'month', 'year'], dateSeparator: '.',
    numberGroup: NNBSP, numberDecimal: ',', numberPattern: `#${NNBSP}###,##`,
    currencyPosition: 'after', currencySpace: true,
    nameOrder: ['family', 'given'],
    addressOrder: ['country', 'postal code', 'region', 'city', 'street and number'],
    legalPlacement: 'footer',
    pluralCategories: ['one', 'few', 'many', 'other'],
    quotes: ['«', '»'],
    spaceBeforeHighPunctuation: false,
  },
  {
    id: 'ar-SA', name: 'Saudi Arabia', endonym: 'العربية', dir: 'rtl',
    datePattern: 'YYYY/MM/DD', dateOrder: ['year', 'month', 'day'], dateSeparator: '/',
    numberGroup: ',', numberDecimal: '.', numberPattern: '#,###.##',
    currencyPosition: 'after', currencySpace: true,
    nameOrder: ['given', 'family'],
    addressOrder: ['building number + street', 'district', 'city postal code', 'country'],
    legalPlacement: 'footer',
    pluralCategories: ['zero', 'one', 'two', 'few', 'many', 'other'],
    quotes: ['«', '»'],
    spaceBeforeHighPunctuation: false,
  },
];

/**
 * @param {string} id
 * @returns {LocaleModel|null}
 */
export function localeById(id) {
  return LOCALES.find((l) => l.id === id) || null;
}

/** Source-side date shapes recognised for reformatting. */
const DATE_SLASH = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g;   // assumed US order: month/day/year
const DATE_DOT = /\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g;     // assumed day.month.year
const DATE_ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;           // ISO 8601
/** Any decimal number, grouped or not, in the source's en-US-shaped convention. */
const ANY_NUMBER = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![\d,]|\.\d)/g;

/**
 * Reorder a date's own parts into a locale's order. No digit is created or
 * destroyed, which is exactly what lets the §18.2 guard pass it.
 * @param {LocaleModel} locale
 * @param {{day: string, month: string, year: string}} parts
 * @returns {string}
 */
function formatDate(locale, parts) {
  // Each part keeps the digits the source wrote it with. Padding `8` to `08`
  // would add a digit the source never had, and the §18.2 guard would be right
  // to call that fabrication.
  const values = locale.dateOrder.map((k) => parts[k]);
  if (locale.dateSuffixes) {
    return values.map((v, i) => `${v}${locale.dateSuffixes[i]}`).join('');
  }
  return values.join(locale.dateSeparator);
}

/**
 * Regroup an integer's digits with a locale's group separator.
 * @param {string} digits
 * @param {string} group
 * @returns {string}
 */
function regroup(digits, group) {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && (fromEnd - 1) % 3 === 0) out += group;
  }
  return out;
}

/**
 * Apply a locale's structural formatting to text drawn from the specimen.
 *
 * Reformats — never translates, never rewrites, never adds. The words stay the
 * prospect's; the dates, numbers, currency placement, quotation marks and
 * typographic spacing become the market's.
 *
 * @param {string} text
 * @param {LocaleModel} locale
 * @returns {string}
 */
export function localizeText(text, locale) {
  let out = String(text == null ? '' : text);

  out = out.replace(DATE_ISO, (_m, y, mo, d) => formatDate(locale, { year: y, month: mo, day: d }));
  out = out.replace(DATE_SLASH, (_m, a, b, y) => formatDate(locale, { month: a, day: b, year: y }));
  out = out.replace(DATE_DOT, (_m, a, b, y) => formatDate(locale, { day: a, month: b, year: y }));

  // Numbers are rewritten in one pass into placeholders, then substituted, so a
  // regrouped integer can never be re-read as a decimal by a later rule.
  /** @type {string[]} */
  const slots = [];
  out = out.replace(ANY_NUMBER, (_m, intPart, frac) => {
    const grouped = intPart.includes(',');
    const digits = intPart.replace(/,/g, '');
    const head = grouped ? regroup(digits, locale.numberGroup) : digits;
    const value = frac === undefined ? head : `${head}${locale.numberDecimal}${frac}`;
    slots.push(value);
    return `\u0000${slots.length - 1}\u0000`;
  });

  // Currency placement. Only symbols already present are moved.
  if (locale.currencyPosition === 'after') {
    const gap = locale.currencySpace ? ' ' : '';
    out = out.replace(/([$€£¥₹₽₩¢])\s?(\u0000\d+\u0000)/g, (_m, sym, num) => `${num}${gap}${sym}`);
  } else if (locale.currencySpace) {
    out = out.replace(/([$€£¥₹₽₩¢])(?=\u0000)/g, '$1 ');
  }

  // Quotation marks.
  const [open, close] = locale.quotes;
  out = out.replace(/“([^”]*)”/g, (_m, inner) => `${open}${inner}${close}`);
  out = out.replace(/"([^"]*)"/g, (_m, inner) => `${open}${inner}${close}`);

  if (locale.spaceBeforeHighPunctuation) {
    out = out.replace(/\s*([;:!?»])/g, `${NNBSP}$1`).replace(/(«)\s*/g, `$1${NNBSP}`);
  }
  return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)]);
}

/**
 * The locale format contract as table rows: the structural facts a localisation
 * lead would actually check. Digit-free by construction — every value is a
 * pattern in letters, a field order, or a category name.
 * @param {LocaleModel} locale
 * @returns {string[][]}
 */
export function formatContractRows(locale) {
  return [
    ['Facet', 'This market'],
    ['Writing direction', locale.dir === 'rtl' ? 'right to left' : 'left to right'],
    ['Date', locale.datePattern],
    ['Number', locale.numberPattern],
    ['Currency', locale.currencyPosition === 'before' ? 'symbol leads the amount' : `amount leads the symbol${locale.currencySpace ? ', separated by a space' : ''}`],
    ['Name order', locale.nameOrder.join(' then ')],
    ['Address order', locale.addressOrder.join(' / ')],
    ['Legal line', legalPlacementLabel(locale.legalPlacement)],
    ['Plural categories', locale.pluralCategories.join(', ')],
    ['Quotation marks', `${locale.quotes[0]} … ${locale.quotes[1]}`],
    ['High punctuation', locale.spaceBeforeHighPunctuation ? 'narrow space before ; : ! ? »' : 'no space before punctuation'],
  ];
}

/**
 * @param {'footer'|'before-cta'|'after-headline'} placement
 * @returns {string}
 */
export function legalPlacementLabel(placement) {
  switch (placement) {
    case 'before-cta': return 'immediately above the call to action';
    case 'after-headline': return 'directly under the headline';
    default: return 'in the page footer';
  }
}
