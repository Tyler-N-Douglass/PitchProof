/**
 * Logo extraction (§7): intrinsic dimensions read from the asset's own bytes,
 * transparency read from the format rather than guessed, variant classification,
 * the §7 preference order, and the rule that an inverse variant is generated
 * only for a monochrome mark.
 *
 * The raster fixtures are constructed byte by byte in this file, from the format
 * specifications, so the parsers are tested against the formats rather than
 * against an encoder from the same source tree. Only the PNG round-trip and the
 * generated inverse use the in-repo encoder, because those are the two places
 * where the encoder is the thing under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { IdMinter } from '../../src/core/ids.js';
import {
  sniffFormat, imageInfo, readPng, decodePng, encodePng, alphaUsed, adler32,
  pngMayHaveTransparency, jpegInfo, gifInfo, webpInfo, bmpInfo, icoInfo,
  svgIntrinsic, svgRootAttrs, parseViewBox, absoluteSvgLength, svgHasFullBleedBackground,
  svgPaints, svgMonochrome, rasterMonochrome, rgbSetMonochrome, paintToRgb, hslToRgb,
  hueOf, circularStats, classifyVariant, extractLogos, collectLogoCandidates,
  inverseVariant, invertInk, invertSvgPaints, invertPixels, isLightInk,
  logosConfidence, serializeNode, inHeaderRegion, contextText, indexAssets,
  lookupAsset, dataUri, parseLogoDataUri, monochromeOf,
  selectLogos, identityScore, mergeCandidates, declaredLogoUrls,
  FAVICON_MAX_PX, WORDMARK_ASPECT, DEFAULT_REPLACED_SIZE, FORMAT_MIME, IDENTITY_WEIGHTS,
} from '../../src/brand/logo.js';

// ------------------------------------------------------------ byte builders

const bytes = (...parts) => {
  const flat = [];
  for (const p of parts) {
    if (typeof p === 'string') for (const ch of p) flat.push(ch.charCodeAt(0));
    else if (Array.isArray(p) || p instanceof Uint8Array) flat.push(...p);
    else flat.push(p);
  }
  return new Uint8Array(flat);
};
const be32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const be16 = (n) => [(n >>> 8) & 0xff, n & 0xff];
const le16 = (n) => [n & 0xff, (n >>> 8) & 0xff];
const le24 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff];
const le32 = (n) => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** A PNG chunk. `readPng` does not verify CRCs, so the fixtures carry zeroes. */
const pngChunk = (type, data) => bytes(be32(data.length), type, data, [0, 0, 0, 0]);

/**
 * A PNG built from the specification: signature, IHDR, optional PLTE/tRNS, an
 * IDAT placeholder, IEND.
 */
const makePng = ({ w, h, bitDepth = 8, colorType = 6, palette = null, trns = null, idat = [0x78, 0x01, 0, 0, 0, 0] }) => {
  const parts = [bytes(PNG_SIG), pngChunk('IHDR', bytes(be32(w), be32(h), bitDepth, colorType, 0, 0, 0))];
  if (palette) parts.push(pngChunk('PLTE', bytes(palette)));
  if (trns) parts.push(pngChunk('tRNS', bytes(trns)));
  parts.push(pngChunk('IDAT', bytes(idat)));
  parts.push(pngChunk('IEND', new Uint8Array(0)));
  return bytes(...parts);
};

/** A baseline JPEG: SOI, APP0/JFIF, SOF0 with the frame dimensions, EOI. */
const makeJpeg = ({ w, h }) => bytes(
  [0xff, 0xd8],
  [0xff, 0xe0], be16(16), 'JFIF', 0, [1, 1, 0], be16(1), be16(1), [0, 0],
  [0xff, 0xdb], be16(4), [0, 0],
  [0xff, 0xc0], be16(17), 8, be16(h), be16(w), 3,
  [1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1],
  [0xff, 0xd9],
);

/** A GIF89a logical screen descriptor, with an optional graphic-control
 *  extension declaring a transparent colour index. */
const makeGif = ({ w, h, transparent = false }) => bytes(
  'GIF89a', le16(w), le16(h), 0x00, 0x00, 0x00,
  transparent ? [0x21, 0xf9, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00] : [0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x3b],
);

/** RIFF/WEBP containers, one per bitstream variant. */
const makeWebpVp8x = ({ w, h, alpha }) => {
  const body = bytes('WEBP', 'VP8X', le32(10), alpha ? 0x10 : 0x00, [0, 0, 0], le24(w - 1), le24(h - 1));
  return bytes('RIFF', le32(body.length), body);
};
const makeWebpVp8 = ({ w, h }) => {
  const chunk = bytes('VP8 ', le32(10), [0x00, 0x00, 0x00], [0x9d, 0x01, 0x2a], le16(w), le16(h));
  const body = bytes('WEBP', chunk);
  return bytes('RIFF', le32(body.length), body);
};
const makeWebpVp8l = ({ w, h, alpha }) => {
  // 14 bits width-1, 14 bits height-1, 1 bit alpha_is_used, 3 bits version.
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | ((alpha ? 1 : 0) << 28);
  const chunk = bytes('VP8L', le32(5), 0x2f, le32(bits >>> 0));
  const body = bytes('WEBP', chunk);
  return bytes('RIFF', le32(body.length), body);
};

/** A BITMAPINFOHEADER BMP, and an ICO directory. */
const makeBmp = ({ w, h, bpp = 24 }) => bytes(
  'BM', le32(54 + w * h * 3), [0, 0, 0, 0], le32(54),
  le32(40), le32(w), le32(h), le16(1), le16(bpp), le32(0), le32(0), le32(2835), le32(2835), le32(0), le32(0),
);
const makeIco = (sizes) => bytes(
  [0, 0, 1, 0], le16(sizes.length),
  ...sizes.map(([w, h]) => bytes(w === 256 ? 0 : w, h === 256 ? 0 : h, 0, 0, le16(1), le16(32), le32(0), le32(22))),
);

/** A real RGBA PNG, through the in-repo encoder. */
const solidPng = (w, h, rgba) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = rgba[0]; data[i * 4 + 1] = rgba[1]; data[i * 4 + 2] = rgba[2]; data[i * 4 + 3] = rgba[3];
  }
  return encodePng({ width: w, height: h, data });
};

const el = (tag, attrs = {}, children = []) => ({ type: 'element', tag, attrs, children });
const txt = (text) => ({ type: 'text', text });

/**
 * A home page carrying all four §7 tiers at once: an inline SVG in the header,
 * a `<link rel=icon>` SVG, an og:image, and header rasters — one of them the
 * real logo, one of them a partner badge, plus a hero photograph outside the
 * header that must never be a candidate.
 */
function homePage() {
  const doc = el('html', {}, [
    el('head', {}, [
      el('link', { rel: 'icon', href: '/favicon.svg' }, []),
      el('meta', { property: 'og:image', content: 'https://cdn.example.com/og-card.png' }, []),
    ]),
    el('body', {}, [
      el('header', { class: 'site-header' }, [
        el('a', { class: 'site-logo', href: '/' }, [
          el('svg', { class: 'site-logo__svg', viewBox: '0 0 120 40' }, [el('path', { fill: '#0b1220', d: 'M0 0h120v40z' }, [])]),
        ]),
        el('img', { src: '/img/wordmark.png', alt: 'Acme wordmark' }, []),
      ]),
      el('main', {}, [el('img', { src: '/img/hero.jpg', alt: 'A hero photograph' }, [])]),
    ]),
  ]);
  const assets = [
    { name: '/favicon.svg', bytes: new TextEncoder().encode('<svg viewBox="0 0 32 32"><path fill="#0b1220" d="M0 0h32v32z"/></svg>'), mime: 'image/svg+xml' },
    { name: 'https://cdn.example.com/og-card.png', bytes: makePng({ w: 1200, h: 630, colorType: 2 }), mime: 'image/png' },
    { name: '/img/wordmark.png', bytes: makePng({ w: 300, h: 60, colorType: 2 }), mime: 'image/png' },
    { name: '/img/hero.jpg', bytes: makeJpeg({ w: 2000, h: 1200 }), mime: 'image/jpeg' },
  ];
  return { doc, assets };
}

// ---------------------------------------------------------------- sniffing

test('formats are identified by magic bytes, never by extension', () => {
  assert.equal(sniffFormat(makePng({ w: 1, h: 1 })), 'png');
  assert.equal(sniffFormat(makeJpeg({ w: 1, h: 1 })), 'jpeg');
  assert.equal(sniffFormat(makeGif({ w: 1, h: 1 })), 'gif');
  assert.equal(sniffFormat(makeWebpVp8x({ w: 1, h: 1, alpha: false })), 'webp');
  assert.equal(sniffFormat(makeBmp({ w: 1, h: 1 })), 'bmp');
  assert.equal(sniffFormat(makeIco([[32, 32]])), 'ico');
  assert.equal(sniffFormat(new TextEncoder().encode('<svg viewBox="0 0 1 1"></svg>')), 'svg');
  assert.equal(sniffFormat(new TextEncoder().encode('<?xml version="1.0"?><svg></svg>')), 'svg');
  assert.equal(sniffFormat(new TextEncoder().encode('not an image at all')), null);
});

// --------------------------------------------------- intrinsic dimensions

test('PNG intrinsic dimensions come from IHDR', () => {
  const info = imageInfo(makePng({ w: 512, h: 128, colorType: 2 }));
  assert.equal(info.format, 'png');
  assert.equal(info.w, 512);
  assert.equal(info.h, 128);
  assert.equal(readPng(makePng({ w: 7, h: 9, colorType: 0, bitDepth: 4 })).bitDepth, 4);
});

test('JPEG intrinsic dimensions come from the SOFn frame header', () => {
  const info = imageInfo(makeJpeg({ w: 1200, h: 630 }));
  assert.equal(info.format, 'jpeg');
  assert.deepEqual([info.w, info.h], [1200, 630]);
  assert.deepEqual(jpegInfo(makeJpeg({ w: 3, h: 5 })), { w: 3, h: 5 });
});

test('GIF intrinsic dimensions come from the logical screen descriptor', () => {
  const info = imageInfo(makeGif({ w: 240, h: 60 }));
  assert.equal(info.format, 'gif');
  assert.deepEqual([info.w, info.h], [240, 60]);
});

test('WebP intrinsic dimensions come from VP8, VP8L and VP8X alike', () => {
  assert.deepEqual(pick(imageInfo(makeWebpVp8({ w: 640, h: 480 }))), { w: 640, h: 480 });
  assert.deepEqual(pick(imageInfo(makeWebpVp8l({ w: 300, h: 100, alpha: false }))), { w: 300, h: 100 });
  assert.deepEqual(pick(imageInfo(makeWebpVp8x({ w: 1024, h: 256, alpha: false }))), { w: 1024, h: 256 });
  assert.equal(webpInfo(new Uint8Array(4)), null);
});

test('BMP and ICO dimensions are read too', () => {
  assert.deepEqual(pick(imageInfo(makeBmp({ w: 48, h: 48 }))), { w: 48, h: 48 });
  assert.deepEqual(pick(imageInfo(makeIco([[16, 16], [48, 48], [32, 32]]))), { w: 48, h: 48 });
  assert.equal(icoInfo(makeIco([[256, 256]])).w, 256);
  assert.equal(bmpInfo(makeBmp({ w: 4, h: 4, bpp: 32 })).hasTransparency, true);
});

test('SVG intrinsic dimensions follow the SVG 2 rules', () => {
  assert.deepEqual(svgIntrinsic('<svg viewBox="0 0 120 40"></svg>'), { w: 120, h: 40, source: 'viewBox' });
  assert.deepEqual(svgIntrinsic('<svg width="200" height="50"></svg>'), { w: 200, h: 50, source: 'attrs' });
  assert.deepEqual(svgIntrinsic('<svg width="200" height="50" viewBox="0 0 120 40"></svg>'), { w: 200, h: 50, source: 'attrs' });
  // One absolute axis plus a viewBox gives the other by aspect ratio.
  assert.deepEqual(svgIntrinsic('<svg width="240" viewBox="0 0 120 40"></svg>'), { w: 240, h: 80, source: 'attrs' });
  // A percentage is relative to a viewport an extractor does not have.
  assert.deepEqual(svgIntrinsic('<svg width="100%" height="100%" viewBox="0 0 32 32"></svg>'), { w: 32, h: 32, source: 'viewBox' });
  // Neither: the CSS default replaced size.
  assert.deepEqual(svgIntrinsic('<svg></svg>'), { ...DEFAULT_REPLACED_SIZE, source: 'default' });
  assert.equal(absoluteSvgLength('12pt'), 16);
  assert.equal(absoluteSvgLength('50%'), null);
  assert.deepEqual(parseViewBox('0 0 10 20'), { x: 0, y: 0, w: 10, h: 20 });
  assert.deepEqual(parseViewBox('0,0,10,20'), { x: 0, y: 0, w: 10, h: 20 });
  assert.equal(parseViewBox('nope'), null);
  assert.equal(svgRootAttrs('<svg class="a" data-x="1"></svg>').class, 'a');
});

// ------------------------------------------------------------ transparency

test('PNG transparency is read from the colour type, the tRNS chunk and the alpha channel', () => {
  // Truecolour with no tRNS cannot be transparent.
  assert.equal(imageInfo(makePng({ w: 4, h: 4, colorType: 2 })).hasTransparency, false);
  // Palette with a tRNS entry below 255 can.
  assert.equal(imageInfo(makePng({ w: 4, h: 4, colorType: 3, palette: [0, 0, 0], trns: [0] })).hasTransparency, true);
  assert.equal(imageInfo(makePng({ w: 4, h: 4, colorType: 3, palette: [0, 0, 0], trns: [255] })).hasTransparency, false);
  // Truecolour with a colour-key tRNS can.
  assert.equal(pngMayHaveTransparency(readPng(makePng({ w: 2, h: 2, colorType: 2, trns: [0, 0, 0, 0, 0, 0] }))), true);
  // An RGBA PNG whose alpha channel is entirely 255 has no transparency, and
  // the extractor reads the pixels rather than trusting the header.
  const opaque = imageInfo(solidPng(4, 4, [10, 20, 30, 255]));
  assert.equal(opaque.hasTransparency, false);
  assert.equal(opaque.transparencyChecked, true);
  const translucent = imageInfo(solidPng(4, 4, [10, 20, 30, 128]));
  assert.equal(translucent.hasTransparency, true);
});

test('GIF transparency comes from the graphic-control extension', () => {
  assert.equal(imageInfo(makeGif({ w: 8, h: 8, transparent: true })).hasTransparency, true);
  assert.equal(imageInfo(makeGif({ w: 8, h: 8, transparent: false })).hasTransparency, false);
});

test('WebP transparency comes from the VP8X flags and the VP8L header bit', () => {
  assert.equal(imageInfo(makeWebpVp8x({ w: 10, h: 10, alpha: true })).hasTransparency, true);
  assert.equal(imageInfo(makeWebpVp8x({ w: 10, h: 10, alpha: false })).hasTransparency, false);
  assert.equal(imageInfo(makeWebpVp8l({ w: 10, h: 10, alpha: true })).hasTransparency, true);
  assert.equal(imageInfo(makeWebpVp8l({ w: 10, h: 10, alpha: false })).hasTransparency, false);
  // Lossy VP8 has no alpha channel at all.
  assert.equal(imageInfo(makeWebpVp8({ w: 10, h: 10 })).hasTransparency, false);
});

test('JPEG is never transparent', () => {
  assert.equal(imageInfo(makeJpeg({ w: 100, h: 100 })).hasTransparency, false);
});

test('an SVG is transparent unless it paints a full-bleed background', () => {
  assert.equal(imageInfo('<svg viewBox="0 0 100 40"><path fill="#000" d="M0 0"/></svg>').hasTransparency, true);
  assert.equal(svgHasFullBleedBackground('<svg viewBox="0 0 100 40"><rect width="100" height="40" fill="#fff"/><path d="M0 0"/></svg>'), true);
  assert.equal(svgHasFullBleedBackground('<svg viewBox="0 0 100 40"><rect width="100%" height="100%" fill="#0b1220"/></svg>'), true);
  // A rect that does not cover the canvas is not a background.
  assert.equal(svgHasFullBleedBackground('<svg viewBox="0 0 100 40"><rect width="20" height="20" fill="#fff"/></svg>'), false);
  // A rect with no fill paints nothing.
  assert.equal(svgHasFullBleedBackground('<svg viewBox="0 0 100 40"><rect width="100" height="40" fill="none"/></svg>'), false);
  assert.equal(svgHasFullBleedBackground('<svg viewBox="0 0 100 40"><rect width="100" height="40" fill="#fff" fill-opacity="0"/></svg>'), false);
  // A background declared on the root element counts.
  assert.equal(svgHasFullBleedBackground('<svg style="background:#0b1220" viewBox="0 0 10 10"></svg>'), true);
  assert.equal(imageInfo('<svg viewBox="0 0 100 40"><rect width="100" height="40" fill="#fff"/></svg>').hasTransparency, false);
});

// ------------------------------------------------------------- monochrome

test('colour tokens are resolved from every syntax a logo uses', () => {
  assert.deepEqual(paintToRgb('#abc'), [170, 187, 204]);
  assert.deepEqual(paintToRgb('#0b1220'), [11, 18, 32]);
  assert.deepEqual(paintToRgb('rgb(10, 20, 30)'), [10, 20, 30]);
  assert.deepEqual(paintToRgb('rgba(10 20 30 / 50%)'), [10, 20, 30]);
  assert.deepEqual(paintToRgb('hsl(0, 100%, 50%)'), [255, 0, 0]);
  assert.deepEqual(paintToRgb('black'), [0, 0, 0]);
  assert.equal(paintToRgb('none'), null);
  assert.equal(paintToRgb('url(#grad)'), null);
  assert.equal(paintToRgb('currentColor'), null);
  assert.deepEqual(hslToRgb(120, 1, 0.5), [0, 255, 0]);
  assert.equal(hueOf(255, 0, 0), 0);
  assert.equal(hueOf(7, 7, 7), null);
});

test('circular statistics do not average 359 and 1 to 180', () => {
  const { mean, spread } = circularStats([359, 1, 0]);
  assert.ok(mean < 5 || mean > 355, `mean ${mean}`);
  assert.ok(spread < 5, `spread ${spread}`);
  assert.ok(circularStats([0, 180]).spread > 90);
});

test('an SVG is monochrome when it is one ink, tints included', () => {
  assert.equal(svgMonochrome('<svg><path fill="#111" d=""/><path fill="#333" d=""/></svg>').monochrome, true);
  assert.equal(svgMonochrome('<svg><path fill="#0b3fbe" d=""/><path fill="#2f63e0" d=""/></svg>').monochrome, true);
  assert.equal(svgMonochrome('<svg><path fill="#e11" d=""/><path fill="#11e" d=""/></svg>').monochrome, false);
  // No explicit paint at all: SVG's initial fill is black, so it is one ink.
  const bare = svgMonochrome('<svg viewBox="0 0 10 10"><path d="M0 0h10v10z"/></svg>');
  assert.equal(bare.monochrome, true);
  assert.equal(bare.inkHex, '#000000');
});

test('an SVG the extractor cannot resolve is never called monochrome', () => {
  assert.equal(svgMonochrome('<svg><linearGradient id="g"/><path fill="url(#g)"/></svg>').monochrome, false);
  assert.equal(svgMonochrome('<svg><image href="data:image/png;base64,AA"/></svg>').monochrome, false);
  assert.equal(svgMonochrome('<svg><path fill="var(--brand)"/></svg>').monochrome, false);
  assert.equal(svgMonochrome('<svg><path fill="somenewcolourname"/></svg>').monochrome, false);
  assert.deepEqual(svgPaints('<svg><path fill="#000" stroke="red" style="stop-color:#fff"/></svg>').sort(), ['#000', '#fff', 'red']);
});

test('a raster is monochrome when its opaque pixels are one ink', () => {
  const black = decodePng(solidPng(8, 8, [0, 0, 0, 255]));
  assert.equal(rasterMonochrome(black).monochrome, true);
  assert.equal(rasterMonochrome(black).kind, 'achromatic');

  // A two-hue mark is not monochrome.
  const twoHue = { width: 2, height: 1, data: new Uint8Array([220, 20, 20, 255, 20, 20, 220, 255]) };
  assert.equal(rasterMonochrome(twoHue).monochrome, false);

  // One hue in two tints is.
  const oneHue = { width: 2, height: 1, data: new Uint8Array([11, 63, 190, 255, 47, 99, 224, 255]) };
  assert.equal(rasterMonochrome(oneHue).monochrome, true);
  assert.equal(rasterMonochrome(oneHue).kind, 'single-hue');

  // Fully transparent pixels are not paint.
  const empty = { width: 1, height: 1, data: new Uint8Array([255, 0, 0, 0]) };
  assert.equal(rasterMonochrome(empty).monochrome, false);
  assert.equal(rgbSetMonochrome([[0, 0, 0]]).kind, 'single-colour');
});

// ---------------------------------------------------------- classification

test('a named signal beats a shape signal', () => {
  assert.equal(classifyVariant({ w: 800, h: 200, name: 'logo-inverse.svg' }), 'inverse');
  assert.equal(classifyVariant({ w: 800, h: 200, alt: 'Acme wordmark' }), 'wordmark');
  assert.equal(classifyVariant({ w: 512, h: 512, name: 'apple-touch-icon.png' }), 'favicon');
  assert.equal(classifyVariant({ w: 512, h: 512, name: 'acme-monogram.svg' }), 'mark');
});

test('shape classifies whatever the name does not', () => {
  assert.equal(classifyVariant({ w: 32, h: 32 }), 'favicon');
  assert.equal(classifyVariant({ w: FAVICON_MAX_PX, h: FAVICON_MAX_PX }), 'favicon');
  assert.equal(classifyVariant({ w: 400, h: 100 }), 'wordmark');       // 4:1
  assert.equal(classifyVariant({ w: 200 * WORDMARK_ASPECT, h: 200 }), 'wordmark');
  assert.equal(classifyVariant({ w: 200, h: 200 }), 'mark');           // 1:1
  assert.equal(classifyVariant({ w: 400, h: 220 }), 'primary');        // 1.8:1 lockup
  assert.equal(classifyVariant({ w: 200, h: 200, source: 'link-icon-svg' }), 'favicon');
});

// ------------------------------------------------------------- extraction

test('discovery follows the §7 preference order', () => {
  const { doc, assets } = homePage();
  const candidates = collectLogoCandidates(doc, assets);
  // §7: inline SVG, then <link rel=icon> SVG, then og:image, then the largest
  // raster in the header region. Discovery finds all four, in that order.
  assert.deepEqual(candidates.map((c) => c.source), ['inline-svg', 'link-icon-svg', 'og-image', 'header-raster']);
  assert.deepEqual(candidates[0].info, { format: 'svg', w: 120, h: 40, hasTransparency: true, transparencyChecked: true, mime: FORMAT_MIME.svg });
  // The hero image outside the header is not named as a logo and is never found.
  assert.equal(candidates.some((c) => c.info.w === 2000), false);
});

test('the primary role goes to the identity, not to whichever tier fired first', () => {
  // The regression the §20 critic found (F10): §7's order is about *finding* a
  // logo. Reading it as an ordering over the `primary` variant promotes a
  // 320x180 og:image of an industrial plant over the SVG in the site header,
  // and `logoFor(brand)` defaults to `primary`.
  const { doc, assets } = homePage();
  const logos = extractLogos(doc, assets, { idMinter: new IdMinter('seed-a', 'brand/logos') });

  const primaries = logos.filter((l) => l.variant === 'primary');
  assert.equal(primaries.length, 1, 'exactly one asset carries the primary role');
  assert.equal(primaries[0].source, 'inline-svg');
  assert.deepEqual(primaries[0].intrinsic, { w: 120, h: 40 });

  // The og:image had no variant signal and lost the identity: it is not a logo.
  assert.equal(logos.some((l) => l.intrinsic.w === 1200), false, 'the social card is not a brand asset');
  assert.deepEqual(logos.map((l) => l.variant), ['primary', 'favicon', 'wordmark']);
  for (const logo of logos) assert.match(logo.id, /^lg_[0-9a-f]{12}$/);
});

test('a non-empty logo set always contains exactly one primary', () => {
  // `logoFor(brand)` (L8) defaults to `primary`; a layout that asks for the
  // brand's logo must always get one.
  const cases = [
    homePage().doc,
    el('header', {}, [el('img', { src: '/logo.png', alt: 'Acme logo' }, [])]),
    el('head', {}, [el('link', { rel: 'icon', href: '/favicon.svg' }, [])]),
    el('head', {}, [el('meta', { property: 'og:image', content: '/og-card.png' }, [])]),
  ];
  const assets = homePage().assets.concat([
    { name: '/logo.png', bytes: makePng({ w: 180, h: 60, colorType: 2 }), mime: 'image/png' },
    { name: '/og-card.png', bytes: makePng({ w: 1200, h: 630, colorType: 2 }), mime: 'image/png' },
  ]);
  for (const doc of cases) {
    const logos = extractLogos(doc, assets, { idMinter: new IdMinter('s') });
    assert.ok(logos.length > 0, 'a candidate was found');
    assert.equal(logos.filter((l) => l.variant === 'primary').length, 1, JSON.stringify(logos.map((l) => l.variant)));
  }
});

test('an og:image alone is still the primary — degradation, not rejection', () => {
  // §7 lists og:image precisely so extraction degrades gracefully. When nothing
  // else was found, the social card is the best evidence there is.
  const doc = el('head', {}, [el('meta', { property: 'og:image', content: '/og-card.png' }, [])]);
  const assets = [{ name: '/og-card.png', bytes: makePng({ w: 1200, h: 630, colorType: 2 }), mime: 'image/png' }];
  const logos = extractLogos(doc, assets, { idMinter: new IdMinter('s') });
  assert.equal(logos.length, 1);
  assert.equal(logos[0].variant, 'primary');
  assert.equal(logos[0].source, 'og-image');
});

test('schema.org Organization.logo is read, and decides the primary', () => {
  const ld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Acme',
    logo: 'https://acme.example/assets/brandfile.svg',
  });
  const doc = el('html', {}, [
    el('head', {}, [
      el('script', { type: 'application/ld+json' }, [txt(ld)]),
      el('meta', { property: 'og:image', content: '/og-card.png' }, []),
    ]),
    el('body', {}, [el('header', {}, [el('img', { src: '/assets/brandfile.svg', alt: '' }, [])])]),
  ]);
  const assets = [
    { name: '/assets/brandfile.svg', bytes: new TextEncoder().encode('<svg viewBox="0 0 300 90"><path fill="#0b1220" d="M0 0h300v90z"/></svg>'), mime: 'image/svg+xml' },
    { name: '/og-card.png', bytes: makePng({ w: 1200, h: 630, colorType: 2 }), mime: 'image/png' },
  ];
  assert.deepEqual(declaredLogoUrls(doc), ['https://acme.example/assets/brandfile.svg']);

  const logos = extractLogos(doc, assets, { idMinter: new IdMinter('s') });
  const primary = logos.find((l) => l.variant === 'primary');
  // The asset is named neither "logo" nor anything else recognisable; only the
  // JSON-LD says what it is.
  assert.deepEqual(primary.intrinsic, { w: 300, h: 90 });
  assert.equal(primary.declared, true);
  assert.equal(logos.some((l) => l.intrinsic.w === 1200), false);
});

test('JSON-LD is read through @graph and publisher, and survives malformed blocks', () => {
  const graph = JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      { '@type': 'WebPage', name: 'Home' },
      { '@type': 'Organization', logo: { '@type': 'ImageObject', url: '/a.svg' } },
    ],
  });
  assert.deepEqual(declaredLogoUrls(el('head', {}, [el('script', { type: 'application/ld+json' }, [txt(graph)])])), ['/a.svg']);

  const publisher = JSON.stringify({ '@type': 'NewsArticle', publisher: { '@type': 'Organization', logo: '/b.png' } });
  assert.deepEqual(declaredLogoUrls(el('head', {}, [el('script', { type: 'application/ld+json' }, [txt(publisher)])])), ['/b.png']);

  // Malformed JSON-LD is ignored, not thrown on: half the web ships broken LD.
  assert.deepEqual(declaredLogoUrls(el('head', {}, [el('script', { type: 'application/ld+json' }, [txt('{not json')])])), []);
  assert.deepEqual(declaredLogoUrls(null), []);
  // `logo` on a node that could not own one is not a logo declaration.
  const recipe = JSON.stringify({ '@type': 'Recipe', logo: '/nope.png' });
  assert.deepEqual(declaredLogoUrls(el('head', {}, [el('script', { type: 'application/ld+json' }, [txt(recipe)])])), []);
});

test('the identity score is the named terms and nothing else', () => {
  const declared = identityScore({
    source: 'header-raster', sources: ['header-raster'], rank: 4, kind: 'svg',
    declared: true, inHeader: true, name: '/assets/logo.svg', alt: 'Acme', context: '',
    info: { w: 240, h: 48 },
  });
  assert.deepEqual(declared.terms, {
    declared: IDENTITY_WEIGHTS.declared, named: IDENTITY_WEIGHTS.named,
    inHeader: IDENTITY_WEIGHTS.inHeader, vector: IDENTITY_WEIGHTS.vector,
    lockupForm: IDENTITY_WEIGHTS.lockupForm,
  });
  assert.equal(declared.score, 8);

  const social = identityScore({
    source: 'og-image', sources: ['og-image'], rank: 3, kind: 'raster',
    name: '/assets/hero-plant.png', alt: '', context: '', info: { w: 320, h: 180 },
  });
  assert.deepEqual(social.terms, { lockupForm: IDENTITY_WEIGHTS.lockupForm, ogOnly: IDENTITY_WEIGHTS.ogOnly });
  assert.ok(social.score < declared.score);

  const icon = identityScore({
    source: 'link-icon-svg', sources: ['link-icon-svg'], rank: 2, kind: 'svg',
    name: '/favicon.svg', alt: '', context: '', info: { w: 32, h: 32 },
  });
  assert.equal(icon.terms.faviconForm, IDENTITY_WEIGHTS.faviconForm);
});

test('the same asset found twice keeps both sources instead of losing one', () => {
  const svg = '<svg viewBox="0 0 200 50"><path fill="#0b1220" d="M0 0h200v50z"/></svg>';
  const doc = el('html', {}, [
    el('head', {}, [el('link', { rel: 'icon', href: '/logo.svg' }, [])]),
    el('body', {}, [el('header', {}, [el('img', { src: '/logo.svg', alt: 'Acme logo' }, [])])]),
  ]);
  const assets = [{ name: '/logo.svg', bytes: new TextEncoder().encode(svg), mime: 'image/svg+xml' }];
  const merged = mergeCandidates(collectLogoCandidates(doc, assets));
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].sources.slice().sort(), ['header-raster', 'link-icon-svg']);
  const [logo] = extractLogos(doc, assets, { idMinter: new IdMinter('s') });
  assert.deepEqual(logo.sources, ['header-raster', 'link-icon-svg']);
});

test('selectLogos reports what it rejected and why', () => {
  const { doc, assets } = homePage();
  const { selected, rejected } = selectLogos(collectLogoCandidates(doc, assets));
  assert.equal(selected.length, 3);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].candidate.source, 'og-image');
  assert.match(rejected[0].reason, /no variant signal and not the primary identity/);
  assert.deepEqual(selectLogos([]), { selected: [], rejected: [] });
});

test('an inline SVG that is not the identity is not a logo candidate', () => {
  const doc = el('main', {}, [el('svg', { class: 'icon icon-chevron', viewBox: '0 0 16 16' }, [])]);
  assert.equal(collectLogoCandidates(doc, []).length, 0);
});

test('the largest raster in the header wins, but a named logo beats a larger unnamed one', () => {
  const doc = el('header', { class: 'masthead' }, [
    el('img', { src: '/big.png', alt: 'Award banner' }, []),
    el('img', { src: '/logo.png', alt: 'Acme logo' }, []),
  ]);
  const assets = [
    { name: '/big.png', bytes: makePng({ w: 900, h: 300, colorType: 2 }), mime: 'image/png' },
    { name: '/logo.png', bytes: makePng({ w: 180, h: 60, colorType: 2 }), mime: 'image/png' },
  ];
  const candidates = collectLogoCandidates(doc, assets).filter((c) => c.source === 'header-raster');
  assert.equal(candidates[0].name, '/logo.png');
});

test('extractLogos refuses to run without an injected id minter', () => {
  assert.throws(() => extractLogos(null, [], {}), /idMinter/);
  assert.deepEqual(extractLogos(null, [], { idMinter: new IdMinter('s') }), []);
});

test('identical assets are extracted once', () => {
  const svg = '<svg class="logo" viewBox="0 0 10 10"><path fill="#000" d="M0 0"/></svg>';
  const doc = el('header', {}, [
    el('a', { class: 'logo' }, [el('svg', { class: 'logo', viewBox: '0 0 10 10' }, [el('path', { fill: '#000', d: 'M0 0' }, [])])]),
    el('a', { class: 'logo' }, [el('svg', { class: 'logo', viewBox: '0 0 10 10' }, [el('path', { fill: '#000', d: 'M0 0' }, [])])]),
  ]);
  assert.equal(extractLogos(doc, [], { idMinter: new IdMinter('s') }).length, 1);
  assert.ok(svg.length > 0);
});

test('assets are found under a url, a path or a basename', () => {
  const index = indexAssets([{ name: 'https://cdn.example.com/a/logo.png?v=3', bytes: new Uint8Array([1]), mime: 'image/png' }]);
  assert.ok(lookupAsset(index, 'https://cdn.example.com/a/logo.png?v=3'));
  assert.ok(lookupAsset(index, 'logo.png'));
  assert.equal(lookupAsset(index, 'other.png'), null);
});

test('header detection recognises landmarks, roles and class names', () => {
  assert.equal(inHeaderRegion(el('img'), [el('header')]), true);
  assert.equal(inHeaderRegion(el('img'), [el('div', { role: 'banner' })]), true);
  assert.equal(inHeaderRegion(el('img'), [el('div', { class: 'global-nav' })]), true);
  assert.equal(inHeaderRegion(el('img'), [el('footer')]), false);
  assert.match(contextText(el('img', { alt: 'Acme logo' }), [el('a', { class: 'brand' })]), /brand.*Acme logo/s);
});

test('an inline SVG round-trips through the serializer', () => {
  const node = el('svg', { viewBox: '0 0 10 10', class: 'logo' }, [el('title', {}, [txt('Acme')]), el('path', { d: 'M0 0' }, [])]);
  const markup = serializeNode(node);
  assert.equal(markup, '<svg class="logo" viewBox="0 0 10 10"><title>Acme</title><path d="M0 0"></path></svg>');
  assert.deepEqual(svgIntrinsic(markup), { w: 10, h: 10, source: 'viewBox' });
});

// -------------------------------------------------------------- inversion

test('an inverse is generated for a monochrome SVG', () => {
  const logo = {
    id: 'lg_000000000001', kind: 'svg', variant: 'primary',
    data: '<svg viewBox="0 0 100 40"><path fill="#0b1220" d="M0 0h100v40z"/></svg>',
    intrinsic: { w: 100, h: 40 }, hasTransparency: true,
    monochrome: true, monochromeKind: 'achromatic', inkHex: '#0b1220',
  };
  const inverse = inverseVariant(logo);
  assert.ok(inverse, 'a monochrome mark can be inverted');
  assert.equal(inverse.variant, 'inverse');
  assert.equal(inverse.generatedFrom, logo.id);
  assert.match(inverse.id, /^lg_[0-9a-f]{12}$/);
  assert.ok(!inverse.data.includes('#0b1220'), 'the original ink is gone');
  const ink = svgPaints(inverse.data)[0];
  assert.ok(isLightInk(ink), `the inverted ink ${ink} reads light`);
  assert.deepEqual(inverse.intrinsic, logo.intrinsic);
  // Regenerating gives the same id: the id is content-derived (§5).
  assert.equal(inverseVariant(logo).id, inverse.id);
});

test('an inverse is NOT generated for a two-colour mark, and the need is flagged', () => {
  const doc = el('header', {}, [
    el('a', { class: 'logo' }, [
      el('svg', { class: 'logo', viewBox: '0 0 100 40' }, [
        el('path', { fill: '#e11d48', d: 'M0 0' }, []),
        el('path', { fill: '#1d4ed8', d: 'M0 0' }, []),
      ]),
    ]),
  ]);
  const [logo] = extractLogos(doc, [], { idMinter: new IdMinter('s') });
  assert.equal(logo.monochrome, false);
  assert.equal(logo.needsInverseAsset, true);
  assert.equal(inverseVariant(logo), null);
  assert.match(logo.monochromeReason, /hue spread/);
});

test('an inverse is generated for a monochrome raster, as a real PNG', () => {
  const png = solidPng(6, 4, [17, 17, 17, 255]);
  const logo = {
    id: 'lg_000000000002', kind: 'raster', variant: 'primary',
    data: dataUri(png, FORMAT_MIME.png), intrinsic: { w: 6, h: 4 }, hasTransparency: false,
  };
  const inverse = inverseVariant(logo);
  assert.ok(inverse);
  assert.equal(inverse.kind, 'raster');
  assert.equal(inverse.format, 'png');
  const decoded = decodePng(parseLogoDataUri(inverse.data).bytes);
  assert.equal(decoded.width, 6);
  assert.equal(decoded.height, 4);
  assert.ok(decoded.data[0] > 200, `the ink inverted to ${decoded.data[0]}`);
  assert.equal(decoded.data[3], 255, 'alpha is preserved');
});

test('a raster this build cannot decode is never inverted', () => {
  const logo = {
    id: 'lg_000000000003', kind: 'raster', variant: 'primary',
    data: dataUri(makeJpeg({ w: 10, h: 10 }), FORMAT_MIME.jpeg), intrinsic: { w: 10, h: 10 }, hasTransparency: false,
  };
  assert.equal(monochromeOf(logo).monochrome, false);
  assert.equal(inverseVariant(logo), null);
});

test('an existing inverse is never inverted again', () => {
  assert.equal(inverseVariant({ id: 'x', kind: 'svg', variant: 'inverse', data: '<svg/>', intrinsic: { w: 1, h: 1 } }), null);
  assert.equal(inverseVariant(null), null);
});

test('inversion holds the hue and reflects the lightness', () => {
  assert.equal(invertInk('#000000'), '#ffffff');
  assert.equal(invertInk('#ffffff'), '#000000');
  const inverted = invertInk('#1a3fbe');
  assert.ok(isLightInk(inverted) && !isLightInk('#1a3fbe'), `${inverted} should read lighter than #1a3fbe`);
  // Round-tripping returns to the neighbourhood of the original.
  assert.ok(!isLightInk(invertInk(inverted)));
  assert.equal(invertSvgPaints('<svg><path fill="url(#g)"/></svg>'), null);
});

test('pixel inversion memoises and preserves alpha', () => {
  const image = { width: 2, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 40]) };
  const out = invertPixels(image);
  assert.deepEqual([...out.data.slice(0, 3)], [...out.data.slice(4, 7)]);
  assert.equal(out.data[3], 255);
  assert.equal(out.data[7], 40);
});

// --------------------------------------------------------- codec integrity

test('the PNG encoder round-trips through the decoder', () => {
  const w = 5;
  const h = 3;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = (i * 7) % 256;
    data[i * 4 + 1] = (i * 13) % 256;
    data[i * 4 + 2] = (i * 29) % 256;
    data[i * 4 + 3] = i % 3 === 0 ? 0 : 255;
  }
  const png = encodePng({ width: w, height: h, data });
  const back = decodePng(png);
  assert.equal(back.width, w);
  assert.equal(back.height, h);
  assert.deepEqual([...back.data], [...data]);
  assert.equal(alphaUsed(back), true);
  // Encoding is deterministic: the same pixels produce the same bytes (§5).
  assert.deepEqual([...encodePng({ width: w, height: h, data })], [...png]);
});

test('adler32 matches the published check value for "Wikipedia"', () => {
  // The Adler-32 worked example: "Wikipedia" -> 0x11E60398.
  assert.equal(adler32(new TextEncoder().encode('Wikipedia')), 0x11e60398);
});

test('an interlaced PNG is reported rather than mis-decoded', () => {
  const interlaced = bytes(
    PNG_SIG,
    pngChunk('IHDR', bytes(be32(4), be32(4), 8, 6, 0, 0, 1)),
    pngChunk('IDAT', bytes([0x78, 0x01, 0, 0, 0, 0])),
    pngChunk('IEND', new Uint8Array(0)),
  );
  assert.throws(() => decodePng(interlaced), /interlaced/);
});

// ---------------------------------------------------------------- confidence

test('confidence reflects the source tier and the agreement between sources', () => {
  const svgOnly = [{ source: 'inline-svg', intrinsic: { w: 120, h: 40 }, variant: 'primary', transparencyChecked: true }];
  const ogOnly = [{ source: 'og-image', intrinsic: { w: 1200, h: 630 }, variant: 'primary', transparencyChecked: true }];
  const agreeing = [
    { source: 'inline-svg', intrinsic: { w: 120, h: 40 }, variant: 'primary', transparencyChecked: true },
    { source: 'header-raster', intrinsic: { w: 240, h: 80 }, variant: 'primary', transparencyChecked: true },
  ];
  assert.ok(logosConfidence(svgOnly) > logosConfidence(ogOnly));
  assert.ok(logosConfidence(agreeing) > logosConfidence(svgOnly));
  assert.equal(logosConfidence([]), 0);
  assert.ok(logosConfidence(agreeing) <= 1);
});

test('a transparency flag that was inferred rather than read lowers confidence', () => {
  const read = [{ source: 'inline-svg', intrinsic: { w: 10, h: 10 }, variant: 'primary', transparencyChecked: true }];
  const inferred = [{ source: 'inline-svg', intrinsic: { w: 10, h: 10 }, variant: 'primary', transparencyChecked: false }];
  assert.ok(logosConfidence(read) > logosConfidence(inferred));
});

test('extraction is deterministic for a fixed seed', () => {
  const doc = el('header', {}, [el('a', { class: 'logo' }, [el('svg', { class: 'logo', viewBox: '0 0 10 10' }, [])])]);
  const a = extractLogos(doc, [], { idMinter: new IdMinter('seed-x', 'brand/logos') });
  const b = extractLogos(doc, [], { idMinter: new IdMinter('seed-x', 'brand/logos') });
  assert.deepEqual(a, b);
});

/** @param {{w: number, h: number}} info */
function pick(info) { return { w: info.w, h: info.h }; }
