// Shared hole-probe semantics for the vector fill tool.
//
// Moved verbatim from `paper-vector.ts` (no behavior change): the hole
// overlay target types, the fail-closed `pathData` / clip-mask / Paper-entity
// guards, the DOM-only effective-paint cascade (style-first, root-inclusive,
// class/stylesheet fail-closed), and the hole bounds helper. Both the Paper
// probe (`paper-vector.ts`) and the curved fallback probe
// (`vector-curved-hole-probe.ts`) import from here so neither direction
// creates an import cycle. This module stays Paper-free (the `safePaper*`
// wrappers take `unknown`), DOM-only otherwise, and throws nothing new.
import { contourBounds, hasHoleBlockingHoleClass, type HoleContour } from './vector-fill-hole-geometry'
import { transformVectorPoint, type VectorMatrix } from './vector-svg'

type VectorBounds = { x: number; y: number; width: number; height: number }

export type VectorHoleTarget = {
  /** Selectable-unit index in `editableVectorUnits(svg)`. */
  parentIndex: number;
  /** Hole outline in unit-local coords (`hole.pathData`, safe subset only). */
  holePathData: string;
  /** Hole bounds in document coords (Paper global `bounds`). */
  holeDocumentBounds: VectorBounds;
  /** Source unit's own `transform` attribute (copied verbatim to the sibling overlay). */
  parentTransform: string;
  /** Source unit's own `fill-rule` attribute value (or `''` when absent). */
  parentFillRule: string;
};

export type VectorHoleProbe =
  | { kind: 'hole'; target: VectorHoleTarget }
  | { kind: 'none' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

/** Safe subset for Paper-exported hole `pathData` (numbers + path commands only). */
export function isHolePathDataSafe(data: string): boolean {
  if (typeof data !== 'string') return false;
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed.length > 20000) return false;
  if (/[<>&"']/.test(trimmed)) return false;
  if (/url\s*\(/i.test(trimmed)) return false;
  if (/script/i.test(trimmed)) return false;
  if (!/^[MmLlHhVvCcSsQqTtAaZz0-9\s.,+\-eE]+$/.test(trimmed)) return false;
  if (!/[Mm]/.test(trimmed)) return false;
  return true;
}

export function hasHoleBlockingClipOrMask(element: Element): boolean {
  try {
    let node: Element | null = element;
    while (node) {
      const tag = node.tagName?.toLowerCase();
      const isSvgRoot = tag === 'svg';
      if (node.hasAttribute?.('clip-path') || node.hasAttribute?.('mask')) return true;
      if (tag === 'clippath' || tag === 'mask') return true;
      const style = node.getAttribute?.('style') ?? '';
      if (/clip-path\s*:/i.test(style) || /(^|;)\s*mask\s*:/i.test(style)) return true;
      // Stylesheet-driven clip/mask cannot be computed detached: any class
      // token (other than the inert explicit-group marker) on the chain
      // blocks the hole probe fail-closed. Safe SVG (no class) is unaffected.
      try {
        if (hasHoleBlockingHoleClass(node.getAttribute?.('class'))) return true;
      } catch {
        return true;
      }
      if (isSvgRoot) break;
      node = node.parentElement;
    }
  } catch {
    // Fail-closed: assume blocked when the ancestor walk itself fails.
    return true;
  }
  return false;
}

export function safePaperContains(item: unknown, point: unknown): boolean {
  try {
    const holder = item as { contains?: (point: unknown) => boolean };
    if (!holder || typeof holder.contains !== 'function') return false;
    return Boolean(holder.contains(point as never));
  } catch {
    return false;
  }
}

export function safePaperArea(item: unknown): number | undefined {
  try {
    const raw = (item as { area?: unknown }).area;
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

export function safePaperIntersectionsCount(left: unknown, right: unknown): number | undefined {
  try {
    const holder = left as { getIntersections?: (other: unknown) => Array<unknown> };
    if (!holder || typeof holder.getIntersections !== 'function') return undefined;
    return holder.getIntersections(right as never).length;
  } catch {
    return undefined;
  }
}

/**
 * Inline-style declaration map (CSS cascade: last declaration wins,
 * `!important` stripped, property names lowercased). Never throws.
 */
function parseHoleStyleDeclarations(style: string | null | undefined): Map<string, string> {
  const declarations = new Map<string, string>();
  if (typeof style !== 'string' || !style) return declarations;
  try {
    for (const part of style.split(';')) {
      const colon = part.indexOf(':');
      if (colon < 0) continue;
      const property = part.slice(0, colon).trim().toLowerCase();
      if (!property) continue;
      let value = part.slice(colon + 1).trim();
      if (!value) continue;
      value = value.replace(/\s*!important\s*$/i, '').trim();
      if (!value) continue;
      declarations.set(property, value);
    }
  } catch {
    // Fail-closed: return what parsed so far.
  }
  return declarations;
}

function readOwnHoleStyleProperty(element: Element, property: string): string | undefined {
  try {
    const declarations = parseHoleStyleDeclarations(element.getAttribute?.('style'));
    const value = declarations.get(property.trim().toLowerCase());
    return value === undefined || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

function hasOwnHoleBlockingClass(element: Element): boolean {
  try {
    return hasHoleBlockingHoleClass(element.getAttribute?.('class'));
  } catch {
    return true;
  }
}

function isHoleInheritKeyword(value: string): boolean {
  return value.trim().toLowerCase() === 'inherit';
}

export type HoleInheritedResolution =
  | { status: 'value'; value: string }
  | { status: 'missing' }
  | { status: 'unknown'; reason: string };

/**
 * Resolve one inheritable presentation property (`fill`, `fill-rule`,
 * `visibility`, `fill-opacity`, `stroke`, ...) with CSS-cascade fidelity
 * limited to what the sanitized document carries:
 *
 * - inline `style` beats the presentation attribute on the same node;
 * - the nearest definition walking self -> ancestors -> `<svg>` root wins
 *   (the root IS checked: `svg fill-rule="evenodd"` / `svg style="..."` /
 *   `svg fill="..."` all inherit to descendants);
 * - `inherit` continues the walk;
 * - a non-explicit `class` on a walked node without an inline-style
 *   definition makes the result `unknown`: page/document stylesheets are not
 *   visible to this parser, and a detached `DOMParser` document plus
 *   `getComputedStyle` cannot compute them reliably (detached nodes have no
 *   layout, no cascade, and no stylesheet origin). Callers must treat
 *   `unknown` as fail-closed (`unsupported`), never guess the attribute
 *   value. The explicit-group token (`xyo-vector-explicit-group`) is inert
 *   and never forces `unknown`.
 *
 * Detached-DOM note: `getComputedStyle(detachedNode)` returns empty / Zero
 * values in every engine and never reflects `<style>` / external sheets, so
 * this resolver deliberately never calls it. Anything that would need the
 * real cascade (a `class` token, an unparsable value) is `unknown`.
 */
export function resolveInheritedHoleProperty(element: Element, property: string): HoleInheritedResolution {
  const name = property.trim().toLowerCase();
  let node: Element | null = element;
  while (node) {
    try {
      const styleValue = readOwnHoleStyleProperty(node, name);
      if (styleValue !== undefined) {
        if (isHoleInheritKeyword(styleValue)) {
          node = node.parentElement;
          continue;
        }
        return { status: 'value', value: styleValue };
      }
      if (hasOwnHoleBlockingClass(node)) {
        return { status: 'unknown', reason: `class-driven ${name} cannot be computed detached (fail-closed)` };
      }
      let attribute: string | null = null;
      try {
        attribute = node.getAttribute?.(name) ?? null;
      } catch {
        attribute = null;
      }
      if (attribute !== null && attribute.trim() !== '') {
        if (isHoleInheritKeyword(attribute)) {
          node = node.parentElement;
          continue;
        }
        return { status: 'value', value: attribute };
      }
    } catch {
      return { status: 'unknown', reason: `unreadable ${name} inheritance (fail-closed)` };
    }
    try {
      const tag = node.tagName?.toLowerCase();
      if (tag === 'svg') break;
    } catch {
      break;
    }
    node = node.parentElement;
  }
  return { status: 'missing' };
}

function parseHoleOpacityFactorText(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.endsWith('%')) {
    const percent = Number(trimmed.slice(0, -1));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
    return percent / 100;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) return undefined;
  return parsed;
}

export type HoleOpacityResolution = { status: 'value'; factor: number } | { status: 'unknown'; reason: string };

/**
 * Effective `opacity` multiplier: the product of every `opacity` in the
 * self -> `<svg>` root chain (group opacity multiplies in rendering, unlike
 * inherited paint which takes the nearest definition). Any class-controlled
 * or unparsable step is `unknown` (fail-closed); detached stylesheets cannot
 * be computed.
 */
export function resolveEffectiveHoleOpacityFactor(element: Element): HoleOpacityResolution {
  let factor = 1;
  let node: Element | null = element;
  while (node) {
    try {
      const styleValue = readOwnHoleStyleProperty(node, 'opacity');
      if (styleValue !== undefined) {
        if (!isHoleInheritKeyword(styleValue)) {
          const parsed = parseHoleOpacityFactorText(styleValue);
          if (parsed === undefined) return { status: 'unknown', reason: 'unparsable opacity style (fail-closed)' };
          factor *= parsed;
        }
      } else {
        if (hasOwnHoleBlockingClass(node)) {
          return { status: 'unknown', reason: 'class-driven opacity cannot be computed detached (fail-closed)' };
        }
        let attribute: string | null = null;
        try {
          attribute = node.getAttribute?.('opacity') ?? null;
        } catch {
          attribute = null;
        }
        if (attribute !== null && attribute.trim() !== '') {
          if (!isHoleInheritKeyword(attribute)) {
            const parsed = parseHoleOpacityFactorText(attribute);
            if (parsed === undefined) return { status: 'unknown', reason: 'unparsable opacity attribute (fail-closed)' };
            factor *= parsed;
          }
        }
      }
    } catch {
      return { status: 'unknown', reason: 'unreadable opacity chain (fail-closed)' };
    }
    try {
      if (node.tagName?.toLowerCase() === 'svg') break;
    } catch {
      break;
    }
    node = node.parentElement;
  }
  return { status: 'value', factor };
}

export type HoleVisibility = { hidden: boolean; unknownReason?: string };

/**
 * Effective visibility for hole probing (`display:none` on ANY ancestor
 * hides the subtree and cannot be re-shown by a descendant; `visibility`
 * is inherited with nearest-wins and `visible` re-shows; `opacity:0`
 * product hides). Any class/stylesheet or unparsable step that could hide
 * the unit is `unknown` (fail-closed) rather than guessed visible.
 */
export function resolveHoleVisibility(element: Element): HoleVisibility {
  // `display:none` on self or any ancestor (style beats attribute per cascade).
  let node: Element | null = element;
  while (node) {
    try {
      const styleDisplay = readOwnHoleStyleProperty(node, 'display');
      if (styleDisplay !== undefined && !isHoleInheritKeyword(styleDisplay)) {
        if (styleDisplay.trim().toLowerCase() === 'none') return { hidden: true };
      } else {
        if (hasOwnHoleBlockingClass(node) && styleDisplay === undefined) {
          return { hidden: false, unknownReason: 'class-driven display cannot be computed detached (fail-closed)' };
        }
        let attrDisplay: string | null = null;
        try {
          attrDisplay = node.getAttribute?.('display') ?? null;
        } catch {
          attrDisplay = null;
        }
        if (attrDisplay !== null && attrDisplay.trim() !== '' && !isHoleInheritKeyword(attrDisplay)) {
          if (attrDisplay.trim().toLowerCase() === 'none') return { hidden: true };
        }
      }
    } catch {
      return { hidden: false, unknownReason: 'unreadable display chain (fail-closed)' };
    }
    try {
      if (node.tagName?.toLowerCase() === 'svg') break;
    } catch {
      break;
    }
    node = node.parentElement;
  }
  const visibility = resolveInheritedHoleProperty(element, 'visibility');
  if (visibility.status === 'unknown') return { hidden: false, unknownReason: visibility.reason };
  if (visibility.status === 'value') {
    const mode = visibility.value.trim().toLowerCase();
    if (mode === 'hidden' || mode === 'collapse') return { hidden: true };
  }
  const opacity = resolveEffectiveHoleOpacityFactor(element);
  if (opacity.status === 'unknown') return { hidden: false, unknownReason: opacity.reason };
  if (!(opacity.factor > 0)) return { hidden: true };
  return { hidden: false };
}

export type HolePaintState =
  | { kind: 'painted' }
  | { kind: 'none' }
  | { kind: 'unsupported'; reason: string };

/**
 * Effective fill paint for hole probing (style-first, root-inclusive,
 * class/stylesheet fail-closed, inherited `url()` included, `fill-opacity`
 * and `opacity:0` treated as no-fill/invisible).
 *
 * - `missing` fill defaults to opaque black (painted, per SVG).
 * - `none` / `transparent` / `fill-opacity:0` -> `none` (unfilled parents
 *   have no hole; callers skip the unit, preserving Z-order via the body
 *   probe).
 * - `url(` anywhere (own, inherited, or inline style) -> `unsupported`
 *   (defs resolution needed; the baked Paper import cannot resolve it
 *   without the live document).
 * - `unknown` (class/stylesheet/unparsable chain) -> `unsupported`.
 */
export function classifyHoleEffectiveFill(element: Element): HolePaintState {
  const visibility = resolveHoleVisibility(element);
  if (visibility.unknownReason) return { kind: 'unsupported', reason: visibility.unknownReason };
  if (visibility.hidden) return { kind: 'none' };
  const fill = resolveInheritedHoleProperty(element, 'fill');
  if (fill.status === 'unknown') return { kind: 'unsupported', reason: fill.reason };
  if (fill.status === 'value') {
    if (/url\s*\(/i.test(fill.value)) {
      return { kind: 'unsupported', reason: 'inherited url(#...) paint needs defs resolution (fail-closed)' };
    }
    const normalized = fill.value.trim().toLowerCase();
    if (normalized === 'none' || normalized === 'transparent' || normalized === '') {
      if (normalized === 'none' || normalized === 'transparent') return { kind: 'none' };
    } else if (normalized.startsWith('none ') || normalized.startsWith('none,')) {
      return { kind: 'none' };
    } else if (normalized !== '') {
      // Concrete color paint below; still gate on fill-opacity.
    }
    if (normalized === 'none' || normalized === 'transparent') return { kind: 'none' };
  }
  const fillOpacity = resolveInheritedHoleProperty(element, 'fill-opacity');
  if (fillOpacity.status === 'unknown') return { kind: 'unsupported', reason: fillOpacity.reason };
  if (fillOpacity.status === 'value') {
    const text = fillOpacity.value.trim();
    let factor: number | undefined;
    if (text.endsWith('%')) {
      const percent = Number(text.slice(0, -1));
      factor = Number.isFinite(percent) ? percent / 100 : undefined;
    } else {
      const parsed = Number(text);
      factor = Number.isFinite(parsed) ? parsed : undefined;
    }
    if (factor === undefined) return { kind: 'unsupported', reason: 'unparsable fill-opacity (fail-closed)' };
    if (!(factor > 0)) return { kind: 'none' };
  }
  if (fill.status === 'value') {
    const normalized = fill.value.trim().toLowerCase();
    if (normalized === 'none' || normalized === 'transparent') return { kind: 'none' };
    if (normalized === '') return { kind: 'painted' };
    // Fully-transparent direct paint (`rgba(...,0)`, `#rrggbbaa` with `aa=00`)
    // paints nothing: treat as `none` (transmissive to lower holes) so the
    // geometry fallback does not hide a visible hole behind an invisible
    // foreground. Semitransparent alpha stays `painted` here; the cover gate
    // fail-closes it when near.
    try {
      const alpha = holeFillAlphaForNone(fill.value);
      if (alpha !== undefined && !(alpha > 0)) return { kind: 'none' };
    } catch {
      // Fall through to painted: the cover gate fail-closes when near.
    }
    return { kind: 'painted' };
  }
  return { kind: 'painted' };
}

function holeFillAlphaForNone(value: string): number | undefined {
  const text = value.trim();
  if (!text) return 1;
  const lower = text.toLowerCase();
  if (lower === 'none' || lower === 'transparent') return 0;
  if (/url\s*\(/i.test(text)) return undefined;
  if (text.startsWith('#')) {
    const body = text.slice(1);
    if (/^[0-9a-fA-F]{3}$/.test(body) || /^[0-9a-fA-F]{6}$/.test(body)) return 1;
    if (/^[0-9a-fA-F]{8}$/.test(body)) {
      const alpha = Number.parseInt(body.slice(6, 8), 16);
      if (!Number.isFinite(alpha)) return undefined;
      return alpha / 255;
    }
    return undefined;
  }
  const rgbMatch = /^rgba?\(\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)(?:\s*,\s*([+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?))?\s*\)$/.exec(
    lower,
  );
  if (rgbMatch) {
    if (rgbMatch[4] === undefined) return 1;
    const raw = Number(rgbMatch[4]);
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    if (raw <= 1) return raw;
    if (raw <= 255) return raw / 255;
    return undefined;
  }
  const hslMatch = /^hsla?\(\s*([+-]?(?:\d*\.)?\d+)(?:deg|rad|grad|turn)?\s*,\s*([+-]?(?:\d*\.)?\d+)%\s*,\s*([+-]?(?:\d*\.)?\d+)%(?:\s*,\s*([+-]?(?:\d*\.)?\d+(?:[eE][+-]?\d+)?))?\s*\)$/.exec(
    lower,
  );
  if (hslMatch) {
    if (hslMatch[4] === undefined) return 1;
    const raw = Number(hslMatch[4]);
    if (!Number.isFinite(raw) || raw < 0) return undefined;
    if (raw <= 1) return raw;
    if (raw <= 255) return raw / 255;
    return undefined;
  }
  return undefined;
}

export type HoleFillRuleState = { kind: 'value'; value: string } | { kind: 'unknown'; reason: string };

/** Effective `fill-rule` (style-first, root-inclusive, class fail-closed). Missing -> `''` (helper defaults to `nonzero`). */
export function resolveEffectiveHoleFillRule(element: Element): HoleFillRuleState {
  const resolved = resolveInheritedHoleProperty(element, 'fill-rule');
  if (resolved.status === 'unknown') return { kind: 'unknown', reason: resolved.reason };
  if (resolved.status === 'missing') return { kind: 'value', value: '' };
  return { kind: 'value', value: resolved.value };
}

function effectiveHoleFillRule(element: Element): string {
  const resolved = resolveEffectiveHoleFillRule(element);
  return resolved.kind === 'value' ? resolved.value : '';
}

function effectiveHoleFillIsNone(element: Element): boolean {
  return classifyHoleEffectiveFill(element).kind === 'none';
}

export function holeContourToPathData(contour: HoleContour): string {
  const pts = contour.points;
  let data = `M${String(pts[0]!.x)} ${String(pts[0]!.y)}`;
  for (let i = 1; i < pts.length; i += 1) {
    data += `L${String(pts[i]!.x)} ${String(pts[i]!.y)}`;
  }
  return `${data}Z`;
}

export function documentBoundsForHole(contour: HoleContour, world: VectorMatrix | undefined): VectorBounds {
  if (!world) return contourBounds(contour);
  try {
    const moved = contour.points.map((p) => transformVectorPoint(world, p.x, p.y));
    if (moved.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return contourBounds(contour);
    }
    return contourBounds({ points: moved, closed: contour.closed });
  } catch {
    return contourBounds(contour);
  }
}
