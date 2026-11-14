// Scratch Paint parity scale for vector stroke widths (reference facts only).
//
// Reference behavior (read from `.tmp/scratch-editor/...`, no code copied):
// - Every vector tool creates Paper.js items with `strokeWidth = <UI value>`
//   verbatim (`line-mode.jsx` L109-113 / L126-130 / L203-207, `rect-tool.js`,
//   `oval-tool.js`, `style-path.js` `styleShape`: `path.strokeWidth = value`).
// - The Paper art board is 960x720 (`view.js`: `ART_BOARD_* = SVG_* * 2`);
//   stored SVG is the 480x360 `SVG_ART_BOARD` size.
// - Save halves: `update-image-hoc.jsx` `handleUpdateVector` runs
//   `scaleWithStrokes(activeLayer, 0.5)` (`helper/math.js`: `strokeWidth *= 0.5`
//   then geometry `scale(0.5)`) before `exportSVG`, and restores with `* 2`.
// - Load doubles: `paper-canvas.jsx` `onUpdateImage` runs
//   `scaleWithStrokes(item, 2)` after `importSVG` ("Import at 2x").
// - Net effect for a stored SVG: `svgStroke = uiStroke / 2`,
//   `paperStroke = svgStroke * 2 = uiStroke`. Selecting an imported
//   `stroke-width="5"` therefore shows UI `10`; typing UI `10` stores `5`.
// - The probe `.tmp/line-width-probe/result.json` replays exactly this:
//   `scratchSvgPerUi = 0.5`, `scratchPaperPerSvg = 2` for UI 1/4/10/25/100.
//
// Current editor state (unreviewed 2x -> 1x change under test):
// - `vector-shapes.ts` writes `stroke-width = UI` verbatim for rect/oval
//   (`Math.max(0, w)`), line (`Math.max(1, w)`), and the legacy stroke brush
//   (`Math.max(1, w)`); text writes `UI / 2` (visual parity: new text has no
//   transform, Scratch PointText exports `UI` verbatim + `scale(0.5)` geometry
//   for a `UI / 2` stage look). `VectorShapePreview.svelte`
//   renders `stroke-width = UI` verbatim. Selection read/write
//   (`vector-selection-style.ts`, `Editor.svelte`) round-trips the attribute
//   verbatim, so imported `stroke-width="5"` displays as UI `5`.
// - That is internally consistent (line now matches rect/oval), but stored
//   bytes are 2x Scratch (`editorSvgPerUi = 1` vs `0.5`): the same UI number
//   renders twice as thick on stage as Scratch would.
// - The live vector brush is fill-based (`vectorBrushFillMarkup`,
//   `stroke="none"`), the eraser is geometry subtraction, and bitmap tools
//   are canvas px: none of them carry a stroke-width scale and they must NOT
//   be touched by any future stroke-scale migration.
//
// This module holds the scale as pure data + pure converters so tests and a
// future coordinated migration share one frame. Importing it changes NO
// behavior: callers (`vector-shapes.ts`, `VectorShapePreview.svelte`,
// `Editor.svelte`) are deliberately left unwired (Editor.svelte is owned by
// a concurrent agent). See the parity probe tests for the fail-first matrix.
export const VECTOR_STROKE_UI_TO_SVG = 0.5;
export const VECTOR_STROKE_SVG_TO_UI = 2;

/** Widths the parity matrix must cover (probe + toolbar `0..100`). */
export const VECTOR_STROKE_PARITY_WIDTHS = [1, 4, 10, 25, 100] as const;

/** Scratch-parity stored value for a toolbar UI width: `UI / 2`. */
export function vectorStrokeUiToSvg(uiWidth: number): number {
  if (!Number.isFinite(uiWidth)) return 0;
  return uiWidth / 2;
}

/** Scratch-parity toolbar value for a stored SVG width: `SVG * 2`. */
export function vectorStrokeSvgToUi(svgWidth: number): number {
  if (!Number.isFinite(svgWidth)) return 0;
  return svgWidth * 2;
}

/**
 * Line-tool floor under parity: the floor lives in Paper/UI units
 * (`line-mode.jsx`: `if (!strokeWidth) onChangeStrokeWidth(1)`), then the
 * commit halves. So UI 1 stores SVG 0.5 (not 1): `max(1, UI) / 2`.
 * UI 0 (or non-finite) stays 0 so the invisible-line no-op gate keeps working.
 */
export function vectorLineSvgForUi(uiWidth: number): number {
  if (!Number.isFinite(uiWidth)) return 0;
  if (!(uiWidth > 0)) return 0;
  return Math.max(1, uiWidth) / 2;
}

/**
 * Text outline parity (Scratch PointText reference):
 * - Scratch creates `PointText` with `strokeWidth = UI` verbatim, exports
 *   with `scaleWithStrokes` SKIPPING text strokes (geometry `scale(0.5)` only),
 *   so exported bytes carry `stroke-width = UI` verbatim plus a `scale(0.5)`
 *   geometry scale; stage appearance is therefore `UI / 2`.
 * - New editor text carries NO transform, so storing `SVG = UI / 2` renders the
 *   same `UI / 2` stage px (visual parity). Hence `/2` (not the legacy `/4`,
 *   which has no Scratch basis).
 * - Imported Scratch bytes (`<text stroke-width="4" transform="scale(0.5)">`)
 *   select as UI `4` in Scratch (local Paper `strokeWidth`, world scale is NOT
 *   folded in). An unconditional `SVG * 2` would misread those as UI `8`.
 *   Only a mathematically certain `scale == 1` chain (no transform, or pure
 *   translate/rotate) uses `*2`; any scale/skew/matrix (own or ancestor) or
 *   style-transform protects to verbatim (Scratch Paper-local parity, no
 *   forced factor conversion). See `isSimpleTextScale` + element-aware
 *   wrappers below.
 */
export function vectorTextSvgForUi(uiWidth: number): number {
  if (!Number.isFinite(uiWidth)) return 0;
  return Math.max(0, uiWidth) / 2;
}

/** Inverse of `vectorTextSvgForUi`: toolbar UI value for a stored text SVG width (simple scale-1 chain). */
export function vectorTextUiForSvg(svgWidth: number): number {
  if (!Number.isFinite(svgWidth)) return 0;
  return Math.max(0, svgWidth) * 2;
}

export type VectorTextScaleElement = {
  getAttribute?(name: string): string | null;
  parentElement?: unknown;
  parentNode?: unknown;
  tagName?: string;
  nodeName?: string;
};

function textTransformIsSimpleScale(transform: string | null | undefined): boolean {
  if (transform === null || transform === undefined) return true;
  const trimmed = transform.trim();
  if (trimmed === '') return true;
  // skew/matrix may carry scale: protect (fail-closed, no forced conversion).
  if (/skewX|skewY|matrix/i.test(trimmed)) return false;
  const scaleOps = [...trimmed.matchAll(/scale\s*\(([^)]*)\)/gi)];
  for (const op of scaleOps) {
    const parts = (op[1] ?? '').split(/[\s,]+/).filter((token) => token.length > 0);
    if (parts.length === 0) return false;
    const numbers: number[] = [];
    for (const part of parts) {
      if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(part)) return false;
      const value = Number(part);
      if (!Number.isFinite(value)) return false;
      numbers.push(value);
    }
    const sx = numbers[0]!;
    const sy = numbers.length >= 2 ? numbers[1]! : sx;
    if (Math.abs(sx - 1) > 1e-9 || Math.abs(sy - 1) > 1e-9) return false;
  }
  return true;
}

function textNodeTagName(node: unknown): string {
  try {
    const candidate = node as { tagName?: unknown; nodeName?: unknown };
    const raw = candidate.tagName ?? candidate.nodeName ?? '';
    return String(raw).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * True only when the text element's own + ancestor transform chain is
 * mathematically certain to preserve stroke scale (empty, translate/rotate
 * only, or `scale(1)`). Anything with scale/skew/matrix, a CSS
 * `style="transform:..."`, an unparsable scale, or a walk failure returns
 * false so callers protect to verbatim instead of forcing `*2`/`/2`.
 * Walks self up through (and including) the `<svg>` root; lightweight stubs
 * without parents simply check their own transform.
 */
export function isSimpleTextScale(element: unknown): boolean {
  try {
    let node = element as VectorTextScaleElement | null;
    const seen = new Set<unknown>();
    let depth = 0;
    while (node && depth < 32 && !seen.has(node)) {
      seen.add(node);
      depth += 1;
      let transform: string | null = null;
      try {
        transform = node.getAttribute?.('transform') ?? null;
      } catch {
        transform = null;
      }
      if (!textTransformIsSimpleScale(transform)) return false;
      try {
        const style = node.getAttribute?.('style') ?? null;
        if (typeof style === 'string' && /(^|;)\s*transform\s*:/i.test(style)) return false;
      } catch {
        return false;
      }
      if (textNodeTagName(node) === 'svg') break;
      let parent: unknown = null;
      try {
        parent = (node as { parentElement?: unknown }).parentElement
          ?? (node as { parentNode?: unknown }).parentNode
          ?? null;
      } catch {
        parent = null;
      }
      if (!parent || typeof (parent as VectorTextScaleElement).getAttribute !== 'function') break;
      node = parent as VectorTextScaleElement;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Toolbar UI for a stored text SVG width with transform protection:
 * simple scale-1 chain → `SVG * 2`; scaled/complex/style-transform chain →
 * verbatim (Scratch Paper-local parity for
 * `<text stroke-width="4" transform="scale(0.5)">` → UI `4`, not `8`).
 * No element (creation paths) → `*2`.
 */
export function vectorTextUiForSvgElement(svgWidth: number, element?: unknown): number {
  if (!Number.isFinite(svgWidth)) return 0;
  const value = Math.max(0, svgWidth);
  if (element !== undefined && element !== null) {
    try {
      if (!isSimpleTextScale(element)) return value;
    } catch {
      return value;
    }
  }
  return value * 2;
}

/**
 * Stored SVG for a toolbar UI width with transform protection (inverse of
 * `vectorTextUiForSvgElement`): simple scale-1 chain → `UI / 2`; scaled/complex
 * chain → verbatim so a same-value edit on
 * `<text stroke-width="4" transform="scale(0.5)">` stays a byte-identical
 * no-op and an explicit `UI 8` stores `8` (visual `8 * 0.5 = 4 = UI / 2`).
 */
export function vectorTextSvgForUiElement(uiWidth: number, element?: unknown): number {
  if (!Number.isFinite(uiWidth)) return 0;
  const value = Math.max(0, uiWidth);
  if (element !== undefined && element !== null) {
    try {
      if (!isSimpleTextScale(element)) return value;
    } catch {
      return value;
    }
  }
  return value / 2;
}
