/**
 * FROZEN CONTRACTS — PitchProof BUILD SPEC v1.0 §4.
 *
 * The interface bodies below are byte-identical to the spec's `ts` block and are
 * verified as such by `test/core/contracts-freeze.test.mjs`, which diffs this
 * file's frozen region against `test/fixtures/frozen-contracts.txt`.
 *
 * Lanes may extend with OPTIONAL fields only, and only below the FROZEN REGION
 * END marker. No lane may rename, retype, or remove a field. A lane that
 * believes a contract is wrong records the objection in CONTRACTS-DISPUTES.md
 * and proceeds against the contract as written.
 *
 * FROZEN REGION BEGIN
 */

// ---------- Brand ----------
export type ColorRole =
  | 'primary' | 'onPrimary' | 'secondary' | 'onSecondary'
  | 'surface' | 'onSurface' | 'surfaceAlt' | 'onSurfaceAlt'
  | 'accent' | 'onAccent' | 'border' | 'success' | 'warning' | 'danger';

export interface ColorToken {
  role: ColorRole;
  hex: string;                 // #RRGGBB
  oklch: [number, number, number]; // L 0..1, C, H degrees
  source: 'extracted' | 'derived' | 'manual';
  /** Contrast ratio against its designated pair, computed, never assumed. */
  contrastWithPair: number | null;
}

export interface TypeFace {
  family: string;
  fallbackStack: string[];     // metric-compatible ordering
  weightsSeen: number[];
  role: 'display' | 'body' | 'mono';
  /** Ratio of this face's cap-height/x-height to the chosen fallback. */
  metricDelta: { capHeight: number; xHeight: number; avgAdvance: number } | null;
  embeddable: boolean;         // true only if a license-clear webfont file was supplied by the user
}

export interface LogoAsset {
  id: string;
  kind: 'svg' | 'raster';
  data: string;                // inline SVG markup or data URI
  variant: 'primary' | 'mark' | 'wordmark' | 'inverse' | 'favicon';
  intrinsic: { w: number; h: number };
  hasTransparency: boolean;
}

export interface BrandSystem {
  id: string;
  sourceUrl: string | null;
  capturedAt: string;          // ISO
  colors: ColorToken[];
  faces: TypeFace[];
  logos: LogoAsset[];
  shape: { radiusPx: number; borderWidthPx: number; shadowLevel: 0|1|2|3 };
  imagery: { treatment: 'photographic'|'illustrative'|'mixed'|'unknown'; saturationBias: number; };
  confidence: Record<'colors'|'faces'|'logos'|'shape'|'imagery', number>; // 0..1
  manualOverrides: string[];   // field paths the user edited
}

// ---------- Content ----------
export type SpecimenKind =
  | 'page' | 'article' | 'product' | 'campaign' | 'document' | 'image' | 'fragment';

export interface Specimen {
  id: string;
  kind: SpecimenKind;
  title: string;
  sourceUrl: string | null;
  capturedAt: string;
  /** Normalized semantic tree; chrome/nav/footer stripped. */
  blocks: ContentBlock[];
  media: MediaRef[];
  meta: Record<string, string>;   // title, description, canonical, lang, og:*
  wordCount: number;
  locale: string | null;
}

export type ContentBlock =
  | { type: 'heading'; level: 1|2|3|4|5|6; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string; attribution?: string }
  | { type: 'table'; rows: string[][]; header: boolean }
  | { type: 'cta'; label: string; href: string | null }
  | { type: 'media'; ref: string; caption?: string }
  | { type: 'raw'; html: string };

export interface MediaRef {
  id: string;
  dataUri: string;             // always inlined by emit time
  alt: string | null;
  intrinsic: { w: number; h: number };
  bytes: number;
}

// ---------- Transformation ----------
export type Provenance = 'client-supplied' | 'illustrative' | 'verified-by-user';

export interface Rendition {
  id: string;
  specimenId: string;
  recipeId: string;
  label: string;               // e.g. "de-DE", "Email variant", "PDP module"
  blocks: ContentBlock[];
  media: MediaRef[];
  provenance: Provenance;      // NEVER default to 'verified-by-user'
  producedBy: 'manual-paste' | 'adapter' | 'template';
  notes: string | null;
}

export interface Recipe {
  id: string;
  name: string;
  intent: string;              // one line: what a viewer should conclude
  inputKinds: SpecimenKind[];
  outputLabels: string[];      // expected rendition labels
  adapterPrompt: string | null; // used only if an adapter is configured at runtime
}

// ---------- Presentation ----------
export type SceneLayout =
  | 'splitBeforeAfter' | 'fanOut' | 'stack' | 'fullBleed'
  | 'sideNote' | 'systemMap' | 'quoteCard' | 'contentsIndex';

export interface Beat {
  id: string;
  /** Element ids revealed at this beat, additive over the scene. */
  reveals: string[];
  presenterNote: string | null;
  dwellHintMs: number | null;  // presentation pacing hint only; never auto-advances
}

export interface Scene {
  id: string;
  layout: SceneLayout;
  headline: string | null;
  subhead: string | null;
  specimenId: string | null;
  renditionIds: string[];
  beats: Beat[];
  branchAnchors: string[];     // Branch ids offerable from this scene
}

export interface Branch {
  id: string;
  objection: string;           // verbatim phrasing a client would use
  aliases: string[];           // other phrasings, for the jump search
  scenes: Scene[];
  returnPolicy: 'anchor' | 'nextSpineScene';
}

export interface Proof {
  schemaVersion: 1;
  id: string;
  prospectName: string;
  createdAt: string;
  brand: BrandSystem;
  specimens: Specimen[];
  renditions: Rendition[];
  recipes: Recipe[];
  spine: Scene[];
  branches: Branch[];
  emitOptions: EmitOptions;
}

export interface EmitOptions {
  mode: 'presenter' | 'review' | 'both';
  includePresenterNotes: boolean;
  maxBytes: number;            // default 25_000_000
  imageQuality: 0.6 | 0.75 | 0.85 | 0.92;
  labelIllustrativeContent: boolean; // default true, user may not disable in Review builds
}

// ---------- Validation ----------
export interface Finding {
  id: string;
  severity: 1 | 2 | 3;         // 1 blocks emit, 2 warns, 3 informational
  code: FindingCode;
  message: string;
  locus: { sceneId?: string; branchId?: string; specimenId?: string; assetId?: string };
  autoFixAvailable: boolean;
}

export type FindingCode =
  | 'ASSET_MISSING' | 'ASSET_OVERSIZE' | 'FONT_UNAVAILABLE' | 'TEXT_OVERFLOW'
  | 'CONTRAST_FAIL' | 'BRANCH_UNREACHABLE' | 'BRANCH_NO_RETURN' | 'BEAT_EMPTY'
  | 'PROVENANCE_UNLABELED' | 'NETWORK_REFERENCE' | 'STALE_CAPTURE'
  | 'SPECIMEN_EMPTY' | 'DUPLICATE_SCENE' | 'SIZE_BUDGET_EXCEEDED';

/* FROZEN REGION END — optional extensions below this line only. */

/** Runtime-only navigation frame; not part of the persisted Proof. */
export interface ReturnFrame {
  sequenceId: string;
  sceneIndex: number;
  beatIndex: number;
  returnPolicy: 'anchor' | 'nextSpineScene';
}
