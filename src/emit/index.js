/**
 * L10 Emitter — the lane's public surface (API.md, Part 3).
 *
 * ```
 * emit(proof, options, deps): Promise<Result<EmitResult>>
 * scanForNetworkReferences(html): Finding[]
 * assertProvenance(proof, html, css): Finding[]
 * budgetAssets(proof, maxBytes): {plan: DegradationLine[], proof: Proof}
 * inlineRuntime({runtimeJs, runtimeCss, themeCss, proof, firstPaintHtml}): string
 * ```
 *
 * Everything below the four declared entry points is exported as well, because
 * `scripts/verify-offline.mjs` and the lane's own tests need to reach the
 * pieces individually — but no other lane may depend on them.
 *
 * **There is no override flag anywhere in this module or anything it imports.**
 * A severity-1 finding refuses the emit, and the refusal comes back as `err`
 * carrying every blocking finding (§14). `test/emit/no-override.test.mjs`
 * searches the whole repository to keep that true.
 *
 * @module emit/index
 */

export { emit, buildDocument, layoutsMissingFor, staleCaptureFindings, stripPresenterNotes, STALE_CAPTURE_DAYS } from './emit.js';

export { runEmitGate, gateDeps, gatedCodes, measureDeck, renderedElementIds, layoutContextFor, MEASURED_BY_EMIT } from './gate.js';

export {
  scanForNetworkReferences, scanModelAssets, scanCss, scanJs, scanAbsoluteUrls, scanNestedDataUri,
  classifyUrl, isW3cNamespace, parseSrcset, networkFinding,
  W3C_NAMESPACES, URL_ALLOWLIST, URL_ATTRS, SRCSET_ATTRS, TEXT_ATTRS, JS_NETWORK_TOKENS,
} from './scan.js';

export {
  assertProvenance, judgeLabelStyle, resolveBackground, describeElement, walkWithChain, renditionAppearsIn,
  documentChainPrefix, allScenesOf, nodeText, provenanceFinding, labelOptionFinding,
  PROVENANCE_LABEL_CLASS, MIN_LABEL_FONT_PX, RENDITION_ATTR,
} from './provenance.js';

export {
  promotionRecord, hasPromotionRecord, requiresProvenanceLabel, isUnearnedVerification,
} from './promotion.js';

export {
  budgetAssets, collectAssets, dedupeAssets, rankAssets, locateAssets, degradeAsset, minifySvg,
  applyReplacements, beatIndexResolver, sizeBudgetFinding, predictEmittedBytes,
  dataUriPrefixBytes, SCALE_LADDER, PNG_CONTAINER_BYTES,
} from './budget.js';

export {
  inlineRuntime, documentLanguage, jsonForScript,
  STAGE_ROOT_ID, PRERENDERED_ATTR, MODEL_ELEMENT_ID, MEDIA_ELEMENT_ID, INERT_SCRIPT_TYPE,
} from './document.js';

export { encodePayload, splitMedia, isExtractableMedia, MEDIA_PLACEHOLDER_FLOOR } from './model.js';

export {
  ppBase64ToBytes, ppInflateRaw, ppUtf8Decode, ppRehydrateMedia, ppDecodePayload,
  ppDecodePayloadRaw, ppBootArtifact, artifactRuntimeSource,
} from './artifact-runtime.js';

export { compileFallbackTheme, compileFontFaces, quoteFamily, stackFor, ROLE_VARS } from './theme.js';

export {
  parseStylesheet, parseSelector, parseDeclarations, computeCascade, matchesSelector,
  specificityOf, resolveVars, resolveFontSize, parseOpacity, backgroundColorOf,
  conditionsApply, splitSelectorList, TRACKED_PROPS, INHERITED_PROPS,
} from './css.js';

export {
  parseColor, contrastRatio, relativeLuminance, compositeOver, oklabToSrgb, oklchToSrgb,
  hslToRgb, hwbToRgb, splitArgs, splitComponents, parseColorMix, NAMED_COLORS,
} from './color-value.js';

export { tokenizeHtml, maskJs, maskCss, lineColOf, excerptAt, decodeEntities, RAW_TEXT_TAGS, VOID_TAGS } from './scan-parse.js';

export {
  decodePng, encodePng, rescalePng, resample, pngSize, isPng, readChunks, adler32,
} from './png.js';

/**
 * @typedef {object} EmitResult
 * @property {string} html
 * @property {number} bytes
 * @property {import('../core/contracts.d.ts').Finding[]} findings
 * @property {import('./budget.js').DegradationLine[]} degradations
 * @property {{mode: 'deflate'|'raw', modelBytes: number, mediaBytes: number}} compression
 */
