// Opaque foreground-cover check for the geometry fallback hole probe.
//
// Split out of `paper-vector.ts` per `packages/editor/AGENTS.md` (features/
// holds shared feature logic): the fallback previously treated a filled
// foreground as transmissive (`verdict contours overlap && isPointFilled ->
// continue`, `filled -> continue`), so an opaque path above a lower hole
// leaked the background hole. The Editor hid this via the Paper body-vs-hole
// comparison, but the helper contract itself violated Z-order.
//
// This module is the pure cover gate used top-down by
// `geometryFallbackHoleProbe`: an opaque straight-path foreground that
// contains the point is an immediate `cover` (caller returns `none`), a
// transparent / outside foreground is `transparent` (caller keeps scanning
// lower units for holes), and anything that cannot be proven safe
// (semitransparency, gradients, unknown/invalid paint, clip/mask, class,
// unknown fill-rule, edge proximity, unfilled overlap, unreadable
// transforms) is fail-closed (`ambiguous` / `unsupported`) when near the
// point and `transparent` when far outside (never poisoning distant units).
//
// Scope: straight-segment `<path>` units only (the fallback's own scope).
// Curves / non-path shapes stay `transparent` here so the existing
// Paper-body comparison keeps handling them; they never become a `cover`
// from this helper. Invalid paint never darkens: unparsable fill / opacity
// is `unsupported`, never `cover`.

import {
  contourBounds,
  contoursOverlap,
  distanceToContours,
  isPathDataSafeForHoleGeometry,
  isPointFilled,
  localToleranceForHoleMatrix,
  normalizeFillRule,
  parseStraightContours,
  type HoleContour,
  type HolePoint,
} from './vector-fill-hole-geometry';
import {
  classifyHoleEffectiveFill,
  hasHoleBlockingClipOrMask,
  resolveEffectiveHoleOpacityFactor,
  resolveInheritedHoleProperty,
} from './vector-hole-probe-shared';
import {
  transformVectorPoint,
  tryInvertVectorMatrix,
  type VectorMatrix,
} from './vector-svg';

export type StraightCoverResult =
  | { kind: 'cover' }
  | { kind: 'transparent' }
  | { kind: 'ambiguous'; reason: string }
  | { kind: 'unsupported'; reason: string };

// Full CSS named-color list (CSS Color 4, case-insensitive). Anything
// alphabetic outside this set is invalid paint: it must not darken to a
// `cover`, so it refuses as `unsupported` (fail-closed).
const CSS_NAMED_COLORS = new Set([
  'aliceblue', 'antiquewhite', 'aqua', 'aquamarine', 'azure', 'beige', 'bisque',
  'black', 'blanchedalmond', 'blue', 'blueviolet', 'brown', 'burlywood',
  'cadetblue', 'chartreuse', 'chocolate', 'coral', 'cornflowerblue', 'cornsilk',
  'crimson', 'cyan', 'darkblue', 'darkcyan', 'darkgoldenrod', 'darkgray',
  'darkgrey', 'darkgreen', 'darkkhaki', 'darkmagenta', 'darkolivegreen',
  'darkorange', 'darkorchid', 'darkred', 'darksalmon', 'darkseagreen',
  'darkslateblue', 'darkslategray', 'darkslategrey', 'darkturquoise',
  'darkviolet', 'deeppink', 'deepskyblue', 'dimgray', 'dimgrey', 'dodgerblue',
  'firebrick', 'floralwhite', 'forestgreen', 'fuchsia', 'gainsboro',
  'ghostwhite', 'gold', 'goldenrod', 'gray', 'grey', 'green', 'greenyellow',
  'honeydew', 'hotpink', 'indianred', 'indigo', 'ivory', 'khaki', 'lavender',
  'lavenderblush', 'lawngreen', 'lemonchiffon', 'lightblue', 'lightcoral',
  'lightcyan', 'lightgoldenrodyellow', 'lightgray', 'lightgrey', 'lightgreen',
  'lightpink', 'lightsalmon', 'lightseagreen', 'lightskyblue',
  'lightslategray', 'lightslategrey', 'lightsteelblue', 'lightyellow', 'lime',
  'limegreen', 'linen', 'magenta', 'maroon', 'mediumaquamarine', 'mediumblue',
  'mediumorchid', 'mediumpurple', 'mediumseagreen', 'mediumslateblue',
  'mediumspringgreen', 'mediumturquoise', 'mediumvioletred', 'midnightblue',
  'mintcream', 'mistyrose', 'moccasin', 'navajowhite', 'navy', 'oldlace',
  'olive', 'olivedrab', 'orange', 'orangered', 'orchid', 'palegoldenrod',
  'palegreen', 'paleturquoise', 'palevioletred', 'papayawhip', 'peachpuff',
  'peru', 'pink', 'plum', 'powderblue', 'purple', 'rebeccapurple', 'red',
  'rosybrown', 'royalblue', 'saddlebrown', 'salmon', 'sandybrown', 'seagreen',
  'seashell', 'sienna', 'silver', 'skyblue', 'slateblue', 'slategray',
  'slategrey', 'snow', 'springgreen', 'steelblue', 'tan', 'teal', 'thistle',
  'tomato', 'turquoise', 'violet', 'wheat', 'white', 'whitesmoke', 'yellow',
  'yellowgreen',
]);

function parseOpacityFactorText(text: string): number | undefined {
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

function fillAlphaForCover(value: string): number | undefined {
  const text = value.trim();
  if (!text) return 1;
  const lower = text.toLowerCase();
  if (lower === 'none' || lower === 'transparent') return 0;
  if (/url\s*\(/i.test(text)) return undefined;
  if (/^\s*(inherit|initial|unset|currentcolor|context-fill|context-stroke)\s*$/i.test(text)) {
    return undefined;
  }
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
  if (/^[a-z]+$/.test(lower)) {
    return CSS_NAMED_COLORS.has(lower) ? 1 : undefined;
  }
  return undefined;
}

type Token = { kind: 'cmd'; value: string } | { kind: 'num'; value: number };

function tokenizeStraightData(data: string): Token[] | undefined {
  const tokens: Token[] = [];
  const pattern = /([MmLlHhVvZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(data)) !== null) {
    const gap = data.slice(lastIndex, match.index);
    if (!/^[\s,]*$/.test(gap)) return undefined;
    if (match[1]) tokens.push({ kind: 'cmd', value: match[1] });
    else tokens.push({ kind: 'num', value: Number(match[2]) });
    lastIndex = pattern.lastIndex;
  }
  if (!/^[\s,]*$/.test(data.slice(lastIndex))) return undefined;
  return tokens;
}

// Straight-segment parser that keeps single contours (the shared
// `parseStraightContours` requires >= 2 because a lone contour can never be
// a hole; a lone contour CAN be an opaque cover, so this allows 1).
function parseStraightContoursAllowingSingle(data: string): HoleContour[] | undefined {
  if (!isPathDataSafeForHoleGeometry(data)) return undefined;
  const tokens = tokenizeStraightData(data.trim());
  if (!tokens || tokens.length === 0) return undefined;
  const contours: HoleContour[] = [];
  let current: HolePoint[] = [];
  let closed = false;
  let cursor: HolePoint = { x: 0, y: 0 };
  let subpathStart: HolePoint = { x: 0, y: 0 };
  let hasCursor = false;
  let command: string | null = null;
  let i = 0;
  const flush = () => {
    if (current.length > 0) {
      contours.push({ points: current, closed });
      current = [];
      closed = false;
    }
  };
  const need = (n: number): number[] | undefined => {
    const out: number[] = [];
    for (let k = 0; k < n; k += 1) {
      const token = tokens[i];
      if (!token || token.kind !== 'num' || !Number.isFinite(token.value)) return undefined;
      out.push(token.value);
      i += 1;
    }
    return out;
  };
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === 'cmd') {
      command = token.value;
      i += 1;
      if (command === 'Z' || command === 'z') {
        if (current.length > 0) closed = true;
        cursor = { ...subpathStart };
        continue;
      }
      if (command === 'M' || command === 'm') {
        flush();
        const pair = need(2);
        if (!pair) return undefined;
        const absolute = command === 'm' && hasCursor
          ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
          : { x: pair[0]!, y: pair[1]! };
        if (!Number.isFinite(absolute.x) || !Number.isFinite(absolute.y)) return undefined;
        cursor = absolute;
        subpathStart = { ...absolute };
        hasCursor = true;
        current = [{ ...cursor }];
        command = command === 'm' ? 'l' : 'L';
        continue;
      }
      continue;
    }
    if (!command) return undefined;
    if (command === 'L' || command === 'l') {
      const pair = need(2);
      if (!pair) return undefined;
      const pt = command === 'l'
        ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
        : { x: pair[0]!, y: pair[1]! };
      if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return undefined;
      cursor = pt;
      current.push({ ...cursor });
    } else if (command === 'H' || command === 'h') {
      const xs = need(1);
      if (!xs) return undefined;
      const x = command === 'h' ? cursor.x + xs[0]! : xs[0]!;
      if (!Number.isFinite(x)) return undefined;
      cursor = { x, y: cursor.y };
      current.push({ ...cursor });
    } else if (command === 'V' || command === 'v') {
      const ys = need(1);
      if (!ys) return undefined;
      const y = command === 'v' ? cursor.y + ys[0]! : ys[0]!;
      if (!Number.isFinite(y)) return undefined;
      cursor = { x: cursor.x, y };
      current.push({ ...cursor });
    } else {
      return undefined;
    }
  }
  flush();
  if (contours.length < 1) return undefined;
  for (const contour of contours) {
    if (contour.points.length < 3) return undefined;
  }
  return contours;
}

export function classifyStraightForegroundCover(options: {
  element: Element;
  index: number;
  point: { x: number; y: number };
  world: VectorMatrix | undefined;
  safeTolerance: number;
  fillRule: string;
  data: string;
}): StraightCoverResult {
  const { element, index, point, world, safeTolerance, fillRule, data } = options;
  let tag = '';
  try {
    tag = element.tagName.toLowerCase();
  } catch {
    return { kind: 'transparent' };
  }
  // Fallback scope is `<path>` only; other shapes stay transmissive here so
  // the Paper body-vs-hole comparison keeps owning them (existing Z-hide
  // behavior for `<rect>` covers is preserved).
  if (tag !== 'path') return { kind: 'transparent' };
  if (!data.trim()) return { kind: 'transparent' };
  // Definite transparency stays transmissive (see-through to lower holes).
  // Unknown paint (`unsupported`: class/stylesheet/url/unparsable chain) is
  // deferred until the near gate below: far-outside unknowns stay
  // transmissive (never poison distant units), near unknowns fail-closed
  // (never leak a lower hole through a possibly-opaque cover).
  let deferredUnknownPaintReason: string | undefined;
  try {
    const paint = classifyHoleEffectiveFill(element);
    if (paint.kind === 'none') return { kind: 'transparent' };
    if (paint.kind === 'unsupported') deferredUnknownPaintReason = paint.reason;
  } catch {
    return { kind: 'transparent' };
  }
  // Curves are not proven here (no pure-geometry oracle for them): stay
  // transmissive so the Paper probe keeps owning curved covers.
  if (/[CcSsQqTtAa]/.test(data)) return { kind: 'transparent' };
  let contours: HoleContour[] | undefined;
  try {
    contours = parseStraightContours(data) ?? parseStraightContoursAllowingSingle(data) ?? undefined;
  } catch {
    return { kind: 'transparent' };
  }
  if (!contours) return { kind: 'transparent' };
  let local = point;
  if (world) {
    let inverse: VectorMatrix | null = null;
    try {
      inverse = tryInvertVectorMatrix(world);
    } catch {
      return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
    }
    if (!inverse) {
      return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
    }
    try {
      local = transformVectorPoint(inverse, point.x, point.y);
    } catch {
      return { kind: 'ambiguous', reason: `hole transform maps point out of range at unit ${index} (fail-closed)` };
    }
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
      return { kind: 'ambiguous', reason: `hole transform maps point out of range at unit ${index} (fail-closed)` };
    }
  }
  const localTolerance = world
    ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], safeTolerance)
    : safeTolerance;
  let near = false;
  try {
    near = contours.some((contour) => {
      const b = contourBounds(contour);
      return (
        local.x >= b.x - localTolerance &&
        local.x <= b.x + b.width + localTolerance &&
        local.y >= b.y - localTolerance &&
        local.y <= b.y + b.height + localTolerance
      );
    });
  } catch {
    return { kind: 'transparent' };
  }
  if (!near) return { kind: 'transparent' };
  // Edge-adjacent points stay fail-closed even when filled (anti-alias zone).
  try {
    const edgeDistance = distanceToContours(contours, local);
    if (!(edgeDistance > localTolerance)) {
      return { kind: 'ambiguous', reason: `point is on/near a painted edge at unit ${index} (fail-closed)` };
    }
  } catch {
    return { kind: 'ambiguous', reason: `unreadable edge distance at unit ${index} (fail-closed)` };
  }
  // Deferred unknown paint: near + unresolvable (class/stylesheet/url chain)
  // cannot prove a cover and cannot prove transparency -> fail-closed.
  if (deferredUnknownPaintReason !== undefined) {
    return { kind: 'unsupported', reason: `${deferredUnknownPaintReason} at unit ${index} (fail-closed)` };
  }
  // Clip/mask on the foreground (self or ancestors, attribute/style/class):
  // the baked Paper import ignores clipping, so a geometrically-filled point
  // may render empty. Near + clipped -> fail-closed, never a cover.
  try {
    if (hasHoleBlockingClipOrMask(element)) {
      return { kind: 'unsupported', reason: `clip/mask on foreground unit ${index} (fail-closed)` };
    }
  } catch {
    return { kind: 'unsupported', reason: `unreadable clip/mask at unit ${index} (fail-closed)` };
  }
  // Invalid fill-rule never becomes a cover: the true rule could still leave
  // the point unfilled while the guessed `nonzero` claims filled.
  try {
    const ruleText = (fillRule ?? '').trim().toLowerCase();
    if (ruleText !== '' && ruleText !== 'nonzero' && ruleText !== 'evenodd') {
      return { kind: 'unsupported', reason: `invalid fill-rule cannot safely occlude at unit ${index} (fail-closed)` };
    }
  } catch {
    return { kind: 'unsupported', reason: `unreadable fill-rule at unit ${index} (fail-closed)` };
  }
  // Opacity / fill-opacity / fill-alpha: semitransparency cannot safely
  // occlude (fail-closed), invalid paint never darkens to a cover.
  try {
    const opacity = resolveEffectiveHoleOpacityFactor(element);
    if (opacity.status === 'unknown') {
      return { kind: 'unsupported', reason: `${opacity.reason} at unit ${index} (fail-closed)` };
    }
    if (opacity.factor < 1 - 1e-9) {
      return { kind: 'ambiguous', reason: `semitransparent foreground cannot safely occlude at unit ${index} (fail-closed)` };
    }
  } catch {
    return { kind: 'unsupported', reason: `unreadable opacity at unit ${index} (fail-closed)` };
  }
  try {
    const fillOpacity = resolveInheritedHoleProperty(element, 'fill-opacity');
    if (fillOpacity.status === 'unknown') {
      return { kind: 'unsupported', reason: `${fillOpacity.reason} at unit ${index} (fail-closed)` };
    }
    if (fillOpacity.status === 'value') {
      const factor = parseOpacityFactorText(fillOpacity.value);
      if (factor === undefined) {
        return { kind: 'unsupported', reason: `unparsable fill-opacity at unit ${index} (fail-closed)` };
      }
      if (factor < 1 - 1e-9) {
        if (!(factor > 0)) return { kind: 'transparent' };
        return { kind: 'ambiguous', reason: `semitransparent fill-opacity cannot safely occlude at unit ${index} (fail-closed)` };
      }
    }
  } catch {
    return { kind: 'unsupported', reason: `unreadable fill-opacity at unit ${index} (fail-closed)` };
  }
  try {
    const fill = resolveInheritedHoleProperty(element, 'fill');
    if (fill.status === 'unknown') {
      return { kind: 'unsupported', reason: `${fill.reason} at unit ${index} (fail-closed)` };
    }
    if (fill.status === 'value') {
      if (/url\s*\(/i.test(fill.value)) {
        return { kind: 'unsupported', reason: `inherited url(#...) paint needs defs resolution at unit ${index} (fail-closed)` };
      }
      const alpha = fillAlphaForCover(fill.value);
      if (alpha === undefined) {
        return { kind: 'unsupported', reason: `invalid fill paint cannot safely occlude at unit ${index} (fail-closed)` };
      }
      if (alpha < 1 - 1e-9) {
        if (!(alpha > 0)) return { kind: 'transparent' };
        return { kind: 'ambiguous', reason: `semitransparent fill cannot safely occlude at unit ${index} (fail-closed)` };
      }
    }
  } catch {
    return { kind: 'unsupported', reason: `unreadable fill at unit ${index} (fail-closed)` };
  }
  let overlap = false;
  try {
    overlap = contoursOverlap(contours);
  } catch {
    return { kind: 'ambiguous', reason: `unreadable overlap at unit ${index} (fail-closed)` };
  }
  let filled = false;
  try {
    filled = isPointFilled(contours as never, local as never, normalizeFillRule(fillRule) as never);
  } catch {
    return { kind: 'ambiguous', reason: `unreadable fill containment at unit ${index} (fail-closed)` };
  }
  if (overlap && !filled) {
    return { kind: 'ambiguous', reason: `contours overlap at unit ${index} (fail-closed)` };
  }
  if (filled) return { kind: 'cover' };
  return { kind: 'transparent' };
}
