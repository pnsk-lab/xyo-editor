// Curved fill-hole fallback probe (Scratch-Paint-style compound paths).
//
// Moved verbatim from `paper-vector.ts` (no behavior change): the verbatim
// curved-subpath splitter (`splitCurvedHoleSubpaths`), the sibling-overlay
// transform allow-list, and the conservative curved fallback
// (`probeCurvedFallbackHole`). The fallback runs only after the Paper entity
// probe and the straight fallback both report `none`, applies the same
// caller-side gates, and requires independent Paper-outline confirmation
// (Canvas-vs-Paper conflicts refuse as `ambiguous`, never as holes).
//
// Import-cycle rule: this module never imports `paper-vector.ts`. Shared
// pure/DOM semantics come from `vector-hole-probe-shared.ts`; geometry comes
// from `vector-fill-hole-geometry.ts` / `vector-fill-hole-curves.ts` /
// `vector-svg.ts`. Paper/scope access arrives only through explicit
// arguments (`scope` + `deps.importUnit`), so the Paper lifecycle
// (`ensureVectorPaperScope`, ephemeral imports, `remove()` cleanup) stays
// owned by `paper-vector.ts` and output SVG / safety guards are untouched.
import {
  classifyHoleEffectiveFill,
  documentBoundsForHole,
  hasHoleBlockingClipOrMask,
  isHolePathDataSafe,
  resolveEffectiveHoleFillRule,
  resolveInheritedHoleProperty,
  safePaperContains,
  safePaperIntersectionsCount,
  type VectorHoleProbe,
  type VectorHoleTarget,
} from './vector-hole-probe-shared'
import {
  contourBounds,
  isUnitEligibleForHoleGeometry,
  localToleranceForHoleMatrix,
} from './vector-fill-hole-geometry'
import {
  classifyCurvedHolePoint,
  curvedHoleDataHasCurves,
  curvedLocalMarginFor,
  flattenCurvedContours,
  gateCurvedWorldMatrix,
  isPathDataSafeForCurvedHoleGeometry,
  CURVED_FLATTEN_TOLERANCE,
} from './vector-fill-hole-curves'
import { transformVectorPoint, tryInvertVectorMatrix, worldTransformMatrix, type VectorMatrix } from './vector-svg'

/** Paper/scope dependencies injected by `paper-vector.ts` (no import cycle). */
export type CurvedHolePaperDeps = {
  /** Ephemeral Paper import of one selectable unit (owns `remove()` cleanup contract). */
  importUnit: (scope: paper.PaperScope, element: Element) => paper.Item | undefined
}

/**
 * Split a curved `d` into absolute subpath strings (one per `M/m`).
 * Relative hole-start `m` is resolved arithmetically to an absolute `M`
 * (unlike `splitPathDataIntoSubpaths`, which declines it); bare pairs after
 * `M/m` are materialized with an explicit `L`/`l` (inheriting the moveto's
 * case per SVG) so the re-rooted cut never reparses a relative `l` pair as
 * absolute `L`. The remaining commands are preserved verbatim with the same
 * numeric values, so the
 * extracted hole outline carries the original curves without flatten drift.
 * Returns `undefined` for unreadable / single-contour / unsafe inputs.
 */
export function splitCurvedHoleSubpaths(data: string): string[] | undefined {
  try {
    if (!isPathDataSafeForCurvedHoleGeometry(data)) return undefined;
    const tokens: Array<{ kind: 'cmd'; value: string } | { kind: 'num'; value: number }> = [];
    const pattern = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
    const trimmed = data.trim();
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(trimmed)) !== null) {
      const gap = trimmed.slice(lastIndex, match.index);
      if (!/^[\s,]*$/.test(gap)) return undefined;
      if (match[1]) tokens.push({ kind: 'cmd', value: match[1] });
      else {
        const value = Number(match[2]);
        if (!Number.isFinite(value)) return undefined;
        tokens.push({ kind: 'num', value });
      }
      lastIndex = pattern.lastIndex;
    }
    if (!/^[\s,]*$/.test(trimmed.slice(lastIndex))) return undefined;
    if (tokens.length === 0) return undefined;
    const arity: Record<string, number> = { M: 2, m: 2, L: 2, l: 2, H: 1, h: 1, V: 1, v: 1, C: 6, c: 6, S: 4, s: 4, Q: 4, q: 4, T: 2, t: 2, A: 7, a: 7 };
    type SubTokens = Array<{ kind: 'cmd'; value: string } | { kind: 'num'; value: number }>;
    const subpaths: SubTokens[] = [];
    let current: SubTokens = [];
    let cursor = { x: 0, y: 0 };
    let subpathStart = { x: 0, y: 0 };
    let hasCursor = false;
    let command: string | null = null;
    let i = 0;
    const pushCurrent = () => {
      if (current.length > 0) {
        subpaths.push(current);
        current = [];
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
        const cmd = token.value;
        i += 1;
        if (cmd === 'Z' || cmd === 'z') {
          current.push({ kind: 'cmd', value: cmd });
          cursor = { ...subpathStart };
          // Bare numbers after `Z` without a new moveto are invalid SVG;
          // fail-closed instead of reusing the pre-close command.
          command = null;
          continue;
        }
        if (cmd === 'M' || cmd === 'm') {
          const pair = need(2);
          if (!pair) return undefined;
          const absolute = cmd === 'm' && hasCursor
            ? { x: cursor.x + pair[0]!, y: cursor.y + pair[1]! }
            : { x: pair[0]!, y: pair[1]! };
          if (!Number.isFinite(absolute.x) || !Number.isFinite(absolute.y)) return undefined;
          // A new subpath starts (but the very first `M` opens the first one).
          if (current.length > 0) pushCurrent();
          current.push({ kind: 'cmd', value: 'M' });
          current.push({ kind: 'num', value: absolute.x });
          current.push({ kind: 'num', value: absolute.y });
          cursor = absolute;
          subpathStart = { ...absolute };
          hasCursor = true;
          command = cmd === 'm' ? 'l' : 'L';
          continue;
        }
        command = cmd;
        current.push({ kind: 'cmd', value: cmd });
        continue;
      }
      if (!command) return undefined;
      const count = arity[command];
      if (!count) return undefined;
      const values = need(count);
      if (!values) return undefined;
      // Explicitly materialize implicit linetos after `M/m`: bare pairs after
      // a moveto inherit the moveto's case (`M`->`L`, `m`->`l` per SVG). The
      // verbatim cut re-roots a relative hole at absolute `M`, so without an
      // explicit `l` the bare pair would reparse as absolute `L` (a shifted
      // overlay vs Scratch/Canvas). Insert the pending `l`/`L` once when the
      // last command token differs; later repeats of the same `l`/`L` stay
      // implicit (valid SVG), and other commands never gain a stray `l`.
      try {
        let lastCmd: string | null = null;
        for (let k = current.length - 1; k >= 0; k -= 1) {
          const entry = current[k]!;
          if (entry.kind === 'cmd') {
            lastCmd = entry.value;
            break;
          }
        }
        if (lastCmd !== command) {
          current.push({ kind: 'cmd', value: command });
        }
      } catch {
        return undefined;
      }
      for (const value of values) current.push({ kind: 'num', value });
      // Track the cursor for later relative-`m` resolution (geometry only).
      try {
        const relative = command === command.toLowerCase();
        if (command === 'L' || command === 'l') {
          cursor = relative
            ? { x: cursor.x + values[0]!, y: cursor.y + values[1]! }
            : { x: values[0]!, y: values[1]! };
        } else if (command === 'H' || command === 'h') {
          cursor = relative ? { x: cursor.x + values[0]!, y: cursor.y } : { x: values[0]!, y: cursor.y };
        } else if (command === 'V' || command === 'v') {
          cursor = relative ? { x: cursor.x, y: cursor.y + values[0]! } : { x: cursor.x, y: values[0]! };
        } else if (command === 'C' || command === 'c') {
          cursor = relative
            ? { x: cursor.x + values[4]!, y: cursor.y + values[5]! }
            : { x: values[4]!, y: values[5]! };
        } else if (command === 'S' || command === 's') {
          cursor = relative
            ? { x: cursor.x + values[2]!, y: cursor.y + values[3]! }
            : { x: values[2]!, y: values[3]! };
        } else if (command === 'Q' || command === 'q') {
          cursor = relative
            ? { x: cursor.x + values[2]!, y: cursor.y + values[3]! }
            : { x: values[2]!, y: values[3]! };
        } else if (command === 'T' || command === 't') {
          cursor = relative
            ? { x: cursor.x + values[0]!, y: cursor.y + values[1]! }
            : { x: values[0]!, y: values[1]! };
        } else if (command === 'A' || command === 'a') {
          cursor = relative
            ? { x: cursor.x + values[5]!, y: cursor.y + values[6]! }
            : { x: values[5]!, y: values[6]! };
        } else if (command === 'M' || command === 'm') {
          cursor = relative
            ? { x: cursor.x + values[0]!, y: cursor.y + values[1]! }
            : { x: values[0]!, y: values[1]! };
        }
      } catch {
        return undefined;
      }
    }
    pushCurrent();
    if (subpaths.length < 2) return undefined;
    const parts: string[] = [];
    for (const sub of subpaths) {
      let text = '';
      for (const token of sub) {
        if (token.kind === 'cmd') text += (text ? ' ' : '') + token.value;
        else text += (text ? ' ' : '') + String(token.value);
      }
      const cleaned = text.trim();
      if (!isHolePathDataSafe(cleaned)) return undefined;
      parts.push(cleaned);
    }
    return parts;
  } catch {
    return undefined;
  }
}

/** Allow-list for the sibling overlay `transform` (mirrors the commit gate). */
export function isSafeCurvedHoleSiblingTransform(transform: string): boolean {
  try {
    if (!transform) return true;
    if (transform.length > 2000) return false;
    if (/[<>&"']/.test(transform)) return false;
    if (/url\s*\(/i.test(transform)) return false;
    if (/script|javascript:|expression|behaviour/i.test(transform)) return false;
    if (!/^[a-z0-9\s.,+\-()]*$/i.test(transform)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Conservative curved fallback for `<path>` units with curve commands.
 *
 * Runs ONLY after the Paper entity probe and the straight fallback both
 * report `none` (callers guarantee the ordering; this function itself never
 * overrides them). For each curve-containing `d` it applies the same
 * caller-side gates as the straight fallback (path-only, effective fill,
 * clip/mask, defs `url()` paint, class/stylesheet, invisibility, stroke-only
 * via `fill:none`, Z-order top-down with cross-unit `ambiguous`), plus the
 * curve-strict similarity gate (mirror / non-uniform / skew refuse via the
 * helper). A helper `hole` is independently confirmed against real Paper
 * outlines (whole-item `contains` must be unfilled, exactly two subpath
 * temps must contain the point with the smaller area as the hole, no
 * boundary crossings, strict bounds nesting, no island); any Canvas-vs-Paper
 * conflict (notably the 2-segment lens where Canvas renders a hole but Paper
 * reports filled) refuses as `ambiguous`, never as a hole. The overlay
 * outline is the original curved subpath (absolute `M` start, explicit close),
 * never the flattened polyline. Far-outside points stay `none` via the
 * widened bounds gate.
 */
export async function probeCurvedFallbackHole(
  scope: paper.PaperScope,
  elements: Element[],
  target: unknown,
  point: { x: number; y: number },
  tolerance: number,
  deps: CurvedHolePaperDeps,
): Promise<VectorHoleProbe> {
  const safeTolerance = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0.5;
  const candidates: Array<VectorHoleTarget> = [];
  for (let index = elements.length - 1; index >= 0; index--) {
    const element = elements[index]!;
    let tag = '';
    try {
      tag = element.tagName.toLowerCase();
    } catch {
      continue;
    }
    if (tag !== 'path') continue;
    let data = '';
    try {
      data = element.getAttribute('d') ?? '';
    } catch {
      continue;
    }
    if (!data.trim()) continue;
    // Only curve-containing paths reach the curve helper; straight `d`
    // already had its verdict from the straight fallback above.
    try {
      if (!curvedHoleDataHasCurves(data)) continue;
    } catch {
      continue;
    }
    if (!isPathDataSafeForCurvedHoleGeometry(data)) continue;
    let paintState: ReturnType<typeof classifyHoleEffectiveFill>;
    try {
      paintState = classifyHoleEffectiveFill(element);
    } catch {
      continue;
    }
    if (paintState.kind === 'none') continue;
    const blocked = hasHoleBlockingClipOrMask(element);
    let insideDefs = false;
    try {
      insideDefs = typeof element.closest === 'function' ? element.closest('defs') !== null : false;
    } catch {
      insideDefs = true;
    }
    let fillAttr: string | null = null;
    let strokeAttr: string | null = null;
    let clipAttr: string | null = null;
    let maskAttr: string | null = null;
    let styleAttr: string | null = null;
    let classAttr: string | null = null;
    try {
      fillAttr = element.getAttribute('fill');
      strokeAttr = element.getAttribute('stroke');
      clipAttr = element.getAttribute('clip-path');
      maskAttr = element.getAttribute('mask');
      styleAttr = element.getAttribute('style');
      classAttr = element.getAttribute('class');
    } catch {
      continue;
    }
    const eligibility = isUnitEligibleForHoleGeometry({
      tag,
      fill: fillAttr,
      stroke: strokeAttr,
      clipPath: clipAttr,
      mask: maskAttr,
      style: styleAttr,
      classAttr,
      insideDefs,
    });
    let world: VectorMatrix | undefined;
    try {
      world = worldTransformMatrix(element) ?? undefined;
    } catch {
      return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
    }
    let fillRule = '';
    let fillRuleUnknown: string | undefined;
    try {
      const resolvedRule = resolveEffectiveHoleFillRule(element);
      if (resolvedRule.kind === 'unknown') fillRuleUnknown = resolvedRule.reason;
      else fillRule = resolvedRule.value;
    } catch {
      fillRule = '';
    }
    // Fail-closed unknowns: propagate only when the point is near this
    // unit's curved geometry (flattened bounds + widened radius), so
    // far-outside points stay `none`.
    if (blocked || !eligibility.eligible || paintState.kind === 'unsupported' || fillRuleUnknown !== undefined) {
      try {
        const nearContours = flattenCurvedContours(data, CURVED_FLATTEN_TOLERANCE);
        if (nearContours) {
          let localNear = point;
          if (world) {
            const inv = tryInvertVectorMatrix(world);
            if (!inv) {
              return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
            }
            localNear = transformVectorPoint(inv, point.x, point.y);
          }
          if (Number.isFinite(localNear.x) && Number.isFinite(localNear.y)) {
            const docBase = Number.isFinite(safeTolerance) && safeTolerance > 0 ? safeTolerance : 0;
            const localBase = world
              ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], docBase)
              : docBase;
            const margin = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE);
            const lt = (Number.isFinite(localBase) ? localBase : Number.POSITIVE_INFINITY) + margin;
            const isNear = nearContours.some((c) => {
              const b = contourBounds(c);
              return (
                localNear.x >= b.x - lt &&
                localNear.x <= b.x + b.width + lt &&
                localNear.y >= b.y - lt &&
                localNear.y <= b.y + b.height + lt
              );
            });
            if (isNear) {
              if (blocked) return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
              if (!eligibility.eligible) {
                return { kind: eligibility.verdict, reason: `${eligibility.reason} at unit ${index} (fail-closed)` };
              }
              if (paintState.kind === 'unsupported') {
                return { kind: 'unsupported', reason: `${paintState.reason} at unit ${index} (fail-closed)` };
              }
              if (fillRuleUnknown) {
                return { kind: 'unsupported', reason: `${fillRuleUnknown} at unit ${index} (fail-closed)` };
              }
            }
          }
        } else if (blocked || !eligibility.eligible || paintState.kind === 'unsupported' || fillRuleUnknown !== undefined) {
          // Unreadable geometry with a fail-closed unknown: refuse only when
          // the helper itself cannot prove far-outside below; otherwise keep
          // scanning (distant unknowns never poison other units).
        }
      } catch {
        // Fall through to classification below.
      }
      // When far-outside, an unknown on this unit never blocks other units.
      // When near but geometry is unreadable, the helper verdict below will
      // still fail-closed; continue only if provably far-outside.
      try {
        const nearContours = flattenCurvedContours(data, CURVED_FLATTEN_TOLERANCE);
        if (nearContours) {
          let localNear = point;
          if (world) {
            const inv = tryInvertVectorMatrix(world);
            if (inv) localNear = transformVectorPoint(inv, point.x, point.y);
          }
          if (Number.isFinite(localNear.x) && Number.isFinite(localNear.y)) {
            const docBase = Number.isFinite(safeTolerance) && safeTolerance > 0 ? safeTolerance : 0;
            const localBase = world
              ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], docBase)
              : docBase;
            const margin = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE);
            const lt = (Number.isFinite(localBase) ? localBase : Number.POSITIVE_INFINITY) + margin;
            const isNear = nearContours.some((c) => {
              const b = contourBounds(c);
              return (
                localNear.x >= b.x - lt &&
                localNear.x <= b.x + b.width + lt &&
                localNear.y >= b.y - lt &&
                localNear.y <= b.y + b.height + lt
              );
            });
            if (!isNear) continue;
          }
        }
      } catch {
        // Fail-closed: fall through to the helper verdict below.
      }
    }
    let verdict: ReturnType<typeof classifyCurvedHolePoint>;
    try {
      verdict = classifyCurvedHolePoint({
        pathData: data,
        point,
        fillRule,
        worldMatrix: (world ?? null) as [number, number, number, number, number, number] | null,
        tolerance: safeTolerance,
      });
    } catch {
      continue;
    }
    if (verdict.kind === 'hole') {
      if (blocked) {
        return { kind: 'unsupported', reason: `clip/mask on hole unit ${index} (fail-closed)` };
      }
      if (!eligibility.eligible) {
        return { kind: eligibility.verdict, reason: `${eligibility.reason} at unit ${index} (fail-closed)` };
      }
      if (paintState.kind === 'unsupported') {
        return { kind: 'unsupported', reason: `${paintState.reason} at unit ${index} (fail-closed)` };
      }
      if (fillRuleUnknown) {
        return { kind: 'unsupported', reason: `${fillRuleUnknown} at unit ${index} (fail-closed)` };
      }
      try {
        const strokeState = resolveInheritedHoleProperty(element, 'stroke');
        if (strokeState.status === 'unknown') {
          return { kind: 'unsupported', reason: `${(strokeState as { reason: string }).reason} at unit ${index} (fail-closed)` };
        }
        if (strokeState.status === 'value' && /url\s*\(/i.test(strokeState.value)) {
          return { kind: 'unsupported', reason: `inherited url(#...) stroke needs defs resolution at unit ${index} (fail-closed)` };
        }
      } catch {
        return { kind: 'unsupported', reason: `unreadable stroke at unit ${index} (fail-closed)` };
      }
      // Similarity gate is already enforced inside the helper (a mirror /
      // non-uniform / skew frame yields `ambiguous`, never `hole`), but
      // double-check explicitly so a future helper change cannot slip a hole
      // through anisotropy.
      try {
        if (world) {
          const gate = gateCurvedWorldMatrix(world as [number, number, number, number, number, number]);
          if (!gate.ok) {
            return { kind: 'ambiguous', reason: `${gate.reason} at unit ${index} (fail-closed)` };
          }
        }
      } catch {
        return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
      }
      // Safely cut the original curved subpath for the hole contour.
      const parts = splitCurvedHoleSubpaths(data);
      const holeSlot = verdict.holeIndex;
      const rawHole = parts?.[holeSlot];
      if (!parts || !rawHole) {
        return { kind: 'ambiguous', reason: `hole geometry is unavailable at unit ${index} (fail-closed)` };
      }
      let holePathData = rawHole.trim();
      if (!/[Zz]$/.test(holePathData)) holePathData = `${holePathData}Z`;
      if (!isHolePathDataSafe(holePathData) || !isPathDataSafeForCurvedHoleGeometry(holePathData)) {
        return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
      }
      let parentTransform = '';
      let parentFillRule = '';
      try {
        parentTransform = element.getAttribute('transform') ?? '';
        parentFillRule = element.getAttribute('fill-rule') ?? '';
      } catch {
        return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
      }
      if (!isSafeCurvedHoleSiblingTransform(parentTransform)) {
        return { kind: 'ambiguous', reason: `hole transform is unsupported at unit ${index} (fail-closed)` };
      }
      // Independent Paper-outline confirmation: the helper `hole` must agree
      // with real Paper `contains` on the true outlines. Any Canvas-vs-Paper
      // conflict (notably the 2-segment lens: Canvas hole vs Paper filled)
      // refuses here, never as a hole.
      try {
        const item = deps.importUnit(scope, element);
        if (!item) {
          return { kind: 'ambiguous', reason: `hole geometry is unavailable at unit ${index} (fail-closed)` };
        }
        try {
          const hit = (item as unknown as { hitTest?: (point: unknown, options: unknown) => unknown }).hitTest?.(target, {
            fill: true,
            stroke: true,
            tolerance: safeTolerance,
            guide: false,
          });
          if (hit) {
            return { kind: 'ambiguous', reason: `hole contains/hit mismatch at the painted edge at unit ${index} (fail-closed)` };
          }
          if (safePaperContains(item, target)) {
            return { kind: 'ambiguous', reason: `Canvas and Paper disagree on hole interior at unit ${index} (fail-closed)` };
          }
          let documentMatrix: VectorMatrix | undefined;
          try {
            documentMatrix = worldTransformMatrix(element) ?? [1, 0, 0, 1, 0, 0];
          } catch {
            return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
          }
          let globalMatrix: unknown;
          try {
            globalMatrix = new scope.Matrix(
              documentMatrix[0],
              documentMatrix[1],
              documentMatrix[2],
              documentMatrix[3],
              documentMatrix[4],
              documentMatrix[5],
            );
            if (!globalMatrix) {
              return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
            }
          } catch {
            return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
          }
          const temps: Array<{ path: unknown; localPathData: string }> = [];
          try {
            for (const part of parts) {
              let closedPart = part.trim();
              if (!/[Zz]$/.test(closedPart)) closedPart = `${closedPart}Z`;
              if (!isHolePathDataSafe(closedPart)) {
                return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
              }
              let temp: unknown;
              try {
                const created = new scope.Path() as unknown as { pathData?: string };
                created.pathData = closedPart;
                temp = created;
              } catch {
                return { kind: 'ambiguous', reason: `hole geometry is unreadable at unit ${index} (fail-closed)` };
              }
              let localPathData: string;
              try {
                localPathData = (temp as { pathData?: unknown }).pathData as string;
              } catch {
                try {
                  (temp as { remove?: () => void }).remove?.();
                } catch {
                  // Ignore cleanup failure.
                }
                return { kind: 'ambiguous', reason: `hole geometry is unreadable at unit ${index} (fail-closed)` };
              }
              if (typeof localPathData !== 'string' || !isHolePathDataSafe(localPathData)) {
                try {
                  (temp as { remove?: () => void }).remove?.();
                } catch {
                  // Ignore cleanup failure.
                }
                return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
              }
              try {
                (temp as { transform?: (matrix: unknown) => void }).transform?.(globalMatrix as never);
              } catch {
                try {
                  (temp as { remove?: () => void }).remove?.();
                } catch {
                  // Ignore cleanup failure.
                }
                return { kind: 'ambiguous', reason: `hole transform failed at unit ${index} (fail-closed)` };
              }
              temps.push({ path: temp, localPathData });
            }
            const containingIndices: number[] = [];
            for (let t = 0; t < temps.length; t += 1) {
              if (safePaperContains(temps[t]!.path, target)) containingIndices.push(t);
            }
            if (containingIndices.length !== 2) {
              return { kind: 'ambiguous', reason: `hole overlaps ${containingIndices.length} contours at unit ${index} (fail-closed)` };
            }
            const areas = containingIndices.map((slot) => {
              try {
                return Math.abs((temps[slot]!.path as { area?: number }).area ?? Number.NaN);
              } catch {
                return Number.NaN;
              }
            });
            const resolved = areas.map((area, k) => {
              if (Number.isFinite(area) && (area as number) > 1e-9) return area as number;
              try {
                const b = (temps[containingIndices[k]!]!.path as { bounds?: { width: number; height: number } }).bounds;
                if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) return Math.abs(b.width * b.height);
              } catch {
                // Fall through to NaN below.
              }
              return Number.NaN;
            });
            if (resolved.some((area) => !Number.isFinite(area) || !(area > 1e-9))) {
              return { kind: 'ambiguous', reason: `hole winding area is unreadable at unit ${index} (fail-closed)` };
            }
            let paperHoleSlot = 0;
            let paperOuterSlot = 1;
            if (resolved[1]! < resolved[0]!) {
              paperHoleSlot = 1;
              paperOuterSlot = 0;
            }
            if (resolved[paperHoleSlot]! >= resolved[paperOuterSlot]!) {
              return { kind: 'ambiguous', reason: `hole is not strictly smaller than its outer contour at unit ${index} (fail-closed)` };
            }
            const paperHoleIdx = containingIndices[paperHoleSlot]!;
            // The helper's hole contour must be the same contour Paper
            // confirms (same subpath index); otherwise the two engines
            // disagree about which wall is the hole.
            if (paperHoleIdx !== holeSlot) {
              return { kind: 'ambiguous', reason: `Canvas and Paper disagree on hole contour at unit ${index} (fail-closed)` };
            }
            const hole = temps[paperHoleIdx]!.path;
            const outer = temps[containingIndices[paperOuterSlot]!]!.path;
            const holeOuterCrossings = safePaperIntersectionsCount(hole, outer);
            if (holeOuterCrossings === undefined) {
              return { kind: 'ambiguous', reason: `hole boundary check failed at unit ${index} (fail-closed)` };
            }
            if (holeOuterCrossings > 0) {
              return { kind: 'ambiguous', reason: `hole boundary crosses its outer contour at unit ${index} (fail-closed)` };
            }
            for (let t = 0; t < temps.length; t += 1) {
              if (t === paperHoleIdx) continue;
              const crossings = safePaperIntersectionsCount(hole, temps[t]!.path);
              if (crossings === undefined) {
                return { kind: 'ambiguous', reason: `hole overlap check failed at unit ${index} (fail-closed)` };
              }
              if (crossings > 0) {
                return { kind: 'ambiguous', reason: `hole touches another contour at unit ${index} (fail-closed)` };
              }
            }
            try {
              const holeBounds = (hole as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
              if (!holeBounds) return { kind: 'ambiguous', reason: `hole bounds are unreadable at unit ${index} (fail-closed)` };
              for (let t = 0; t < temps.length; t += 1) {
                if (t === paperHoleIdx || t === containingIndices[paperOuterSlot]!) continue;
                const otherBounds = (temps[t]!.path as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
                if (
                  otherBounds &&
                  holeBounds.x <= otherBounds.x &&
                  holeBounds.y <= otherBounds.y &&
                  holeBounds.x + holeBounds.width >= otherBounds.x + otherBounds.width &&
                  holeBounds.y + holeBounds.height >= otherBounds.y + otherBounds.height &&
                  otherBounds.width > 0 &&
                  otherBounds.height > 0
                ) {
                  return { kind: 'ambiguous', reason: `hole contains an island contour at unit ${index} (fail-closed)` };
                }
              }
              const outerBounds = (outer as { bounds?: { x: number; y: number; width: number; height: number } }).bounds;
              if (!outerBounds) return { kind: 'ambiguous', reason: `hole bounds are unreadable at unit ${index} (fail-closed)` };
              const strictlyInside =
                outerBounds.x <= holeBounds.x &&
                outerBounds.y <= holeBounds.y &&
                outerBounds.x + outerBounds.width >= holeBounds.x + holeBounds.width &&
                outerBounds.y + outerBounds.height >= holeBounds.y + holeBounds.height;
              if (!strictlyInside) {
                return { kind: 'ambiguous', reason: `hole is not strictly inside its outer contour at unit ${index} (fail-closed)` };
              }
              const holeDocumentBounds = { x: holeBounds.x, y: holeBounds.y, width: holeBounds.width, height: holeBounds.height };
              if (!(holeDocumentBounds.width > 0 && holeDocumentBounds.height > 0)) {
                return { kind: 'ambiguous', reason: `degenerate hole bounds at unit ${index} (fail-closed)` };
              }
              if (
                !Number.isFinite(holeDocumentBounds.x) ||
                !Number.isFinite(holeDocumentBounds.y) ||
                !Number.isFinite(holeDocumentBounds.width) ||
                !Number.isFinite(holeDocumentBounds.height)
              ) {
                return { kind: 'ambiguous', reason: `degenerate hole bounds at unit ${index} (fail-closed)` };
              }
              // Coordinate-error safety: the Paper-confirmed hole bounds must
              // agree with the helper's flattened hole bounds (mapped to
              // document space) within the flatten margin + tolerance.
              // A mismatch means the cut subpath index or the flattening
              // drifted, so refuse instead of placing a shifted overlay.
              try {
                const flat = flattenCurvedContours(data, CURVED_FLATTEN_TOLERANCE)?.[holeSlot];
                if (flat) {
                  const helperLocal = contourBounds(flat);
                  const helperDoc = world ? documentBoundsForHole(flat, world) : helperLocal;
                  const centerDx = helperLocal && helperDoc
                    ? Math.abs(helperDoc.x + helperDoc.width / 2 - (holeDocumentBounds.x + holeDocumentBounds.width / 2)) : Number.NaN;
                  const centerDy = helperLocal && helperDoc
                    ? Math.abs(helperDoc.y + helperDoc.height / 2 - (holeDocumentBounds.y + holeDocumentBounds.height / 2)) : Number.NaN;
                  const sizeDx = Math.abs(helperDoc.width - holeDocumentBounds.width);
                  const sizeDy = Math.abs(helperDoc.height - holeDocumentBounds.height);
                  const coordMargin = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE) + safeTolerance + 1e-6;
                  const scaleForMargin = (() => {
                    try {
                      if (!world) return 1;
                      const sx = Math.hypot(world[0]!, world[1]!);
                      const sy = Math.hypot(world[2]!, world[3]!);
                      if (!Number.isFinite(sx) || !Number.isFinite(sy) || !(sx > 0) || !(sy > 0)) return Number.POSITIVE_INFINITY;
                      return Math.max(sx, sy);
                    } catch {
                      return Number.POSITIVE_INFINITY;
                    }
                  })();
                  const allowed = Number.isFinite(scaleForMargin) ? coordMargin * scaleForMargin : Number.POSITIVE_INFINITY;
                  if (!Number.isFinite(centerDx) || !Number.isFinite(centerDy) || !Number.isFinite(sizeDx) || !Number.isFinite(sizeDy)) {
                    return { kind: 'ambiguous', reason: `hole geometry is unavailable at unit ${index} (fail-closed)` };
                  }
                  if (!(centerDx <= allowed && centerDy <= allowed && sizeDx <= allowed && sizeDy <= allowed)) {
                    return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
                  }
                }
              } catch {
                return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
              }
              const confirmedLocal = temps[paperHoleIdx]!.localPathData;
              if (!isHolePathDataSafe(confirmedLocal)) {
                return { kind: 'ambiguous', reason: `hole geometry failed validation at unit ${index} (fail-closed)` };
              }
              candidates.push({ parentIndex: index, holePathData, holeDocumentBounds, parentTransform, parentFillRule });
            } catch {
              return { kind: 'ambiguous', reason: `hole bounds check failed at unit ${index} (fail-closed)` };
            }
          } finally {
            for (const temp of temps) {
              try {
                (temp.path as { remove?: () => void }).remove?.();
              } catch {
                // Best effort cleanup for ephemeral probes.
              }
            }
          }
        } finally {
          try {
            (item as unknown as { remove?: () => void }).remove?.();
          } catch {
            // Best effort cleanup for the ephemeral import.
          }
        }
      } catch {
        return { kind: 'ambiguous', reason: `hole probe failed at unit ${index} (fail-closed)` };
      }
    } else if (verdict.kind === 'ambiguous') {
      // Distant units must not poison outside clicks: propagate only when
      // the point sits inside (or within the widened margin of) this unit's
      // curved bounds. Far-outside stays `none`.
      try {
        const contours = flattenCurvedContours(data, CURVED_FLATTEN_TOLERANCE);
        if (contours) {
          let local = point;
          if (world) {
            const inverse = tryInvertVectorMatrix(world);
            if (!inverse) {
              return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
            }
            local = transformVectorPoint(inverse, point.x, point.y);
            if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) {
              return { kind: 'ambiguous', reason: `hole transform maps point out of range at unit ${index} (fail-closed)` };
            }
          }
          const docBase = Number.isFinite(safeTolerance) && safeTolerance > 0 ? safeTolerance : 0;
          const localBase = world
            ? localToleranceForHoleMatrix(world as [number, number, number, number, number, number], docBase)
            : docBase;
          if (!Number.isFinite(localBase)) {
            return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
          }
          const margin = curvedLocalMarginFor(CURVED_FLATTEN_TOLERANCE);
          const localTolerance = localBase + margin;
          if (!Number.isFinite(localTolerance)) {
            return { kind: 'ambiguous', reason: `hole transform is unreadable at unit ${index} (fail-closed)` };
          }
          const near = contours.some((contour) => {
            const bounds = contourBounds(contour);
            return (
              local.x >= bounds.x - localTolerance &&
              local.x <= bounds.x + bounds.width + localTolerance &&
              local.y >= bounds.y - localTolerance &&
              local.y <= bounds.y + bounds.height + localTolerance
            );
          });
          if (!near) continue;
        }
      } catch {
        // Fall through to fail-closed propagation below.
      }
      return { kind: 'ambiguous', reason: `${verdict.reason} at unit ${index} (fail-closed)` };
    }
    // `filled` / `outside` / `unsupported` (unreadable payloads, single
    // contours) are not this unit's hole: keep scanning lower units.
  }
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length > 1) {
    return { kind: 'ambiguous', reason: `overlapping holes at units ${candidates.map((candidate) => candidate.parentIndex).join(', ')} (fail-closed)` };
  }
  return { kind: 'hole', target: candidates[0]! };
}
