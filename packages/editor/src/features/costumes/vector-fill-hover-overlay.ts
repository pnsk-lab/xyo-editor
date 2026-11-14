// Vector fill-tool hover overlay snapshot (safe, non-destructive, UI-independent).
//
// Purpose: render the existing `resolveFillHoverPreview` result as a
// draw-only overlay without touching the live SVG / VM / history. The live
// document is never mutated here: this module parses the base SVG *text* into
// a detached `DOMParser` document, applies a single-side preview to the clone
// (or inserts one ephemeral hole path as a sibling, mirroring the commit
// path), and serializes the clone. Callers render the returned string in a
// separate `pointer-events: none` layer above the base artwork, so later hover
// passes (which read the live units) never see the overlay.
//
// Contracts honored (mirrors `fillVectorObjectAtPoint` in `Editor.svelte`):
// - Zoom: callers pass the document point + zoom-aware tolerance through to
//   the resolver; this module never remaps points. Ancestor transforms ride
//   the cloned document (whole-doc clone), so `<g transform>` nesting is
//   honored without moving ancestors or siblings.
// - Compound holes: only `isHolePathDataSafe` geometry + the sibling
//   transform allow-list below may render; anything else returns `null`
//   (fail-closed, never a parent recolor, never blocks other objects since the
//   overlay container itself is `pointer-events: none`).
// - Visible target side: exactly one side (`fill` XOR `stroke`) is rewritten
//   on the cloned target; transforms / ids / geometry / opacity / stops / the
//   other side are never touched (gradient defs are appended only).
// - Transparent: `noop-transparent-hole` and invisible paints return `null`
//   (no overlay); callers may still show a hover ring. The snapshot never
//   invents outlines for non-outlined shapes.
// - Dangerous / unknown holes: `ambiguous` / `unsupported` / unsafe `d` /
//   unsafe `transform` / degenerate bounds all return `null`.

import {
  documentPointToLocalGradientPoint,
  editableVectorUnits,
  localVectorGradientBounds,
} from './vector-svg';
import { isHolePathDataSafe } from './paper-vector';
import { isFillInvisible } from './transparent-paint';
import { svgGradientPaint } from './paint-colors';
import { svgStrokePaint } from './vector-stroke-paint';
import type { FillHoverPreviewResult } from './vector-fill-hover-preview';

export type FillHoverOverlayToolbarPaint = {
  paintColor: string;
  secondaryPaintColor: string;
  paintGradient: 'solid' | 'horizontal' | 'vertical' | 'radial';
  fillTransparent: boolean;
  secondaryTransparent: boolean;
  strokeColor: string;
  strokeSecondaryColor: string;
  strokeGradient: 'solid' | 'horizontal' | 'vertical' | 'radial';
  strokeTransparent: boolean;
  secondaryStrokeTransparent: boolean;
  strokeWidth: number;
  vectorOpacity: number;
};

export type FillHoverOverlayHoleInput = {
  holePathData: string;
  parentTransform: string;
  holeDocumentBounds: { x: number; y: number; width: number; height: number };
};

function isSafeHoleSiblingTransform(transform: string): boolean {
  if (!transform) return true;
  if (transform.length > 2000) return false;
  if (/[<>&"']/.test(transform)) return false;
  if (/url\s*\(/i.test(transform)) return false;
  if (/script|javascript:|expression|behaviour/i.test(transform)) return false;
  if (!/^[a-z0-9\s.,+\-()]*$/i.test(transform)) return false;
  return true;
}

export function isFillHoverHolePreviewSafe(hole: FillHoverOverlayHoleInput): boolean {
  if (!isHolePathDataSafe(hole.holePathData)) return false;
  if (!isSafeHoleSiblingTransform(hole.parentTransform)) return false;
  const bounds = hole.holeDocumentBounds;
  if (!bounds || !(bounds.width > 0 && bounds.height > 0)) return false;
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return false;
  if (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) return false;
  return true;
}

function appendPreviewDefs(svg: Element, doc: Document, defsMarkup: string): void {
  if (!defsMarkup) return;
  const envelope = `<svg xmlns="http://www.w3.org/2000/svg">${defsMarkup}</svg>`;
  const parsed = new DOMParser().parseFromString(envelope, 'image/svg+xml');
  const source = parsed.documentElement;
  if (source.nodeName.toLowerCase() !== 'svg' || source.getElementsByTagName('parsererror').length > 0) return;
  const gradients = ['linearGradient', 'radialGradient'].flatMap((tag) =>
    Array.from(source.getElementsByTagName(tag)),
  );
  if (gradients.length === 0) return;
  let defs = svg.getElementsByTagName('defs')[0];
  if (!defs) {
    defs = doc.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  for (const gradient of gradients) {
    try {
      const imported = doc.importNode(gradient, true);
      defs.appendChild(imported);
    } catch {
      // Best effort: the paint attribute write below stands alone.
    }
  }
}

function parseBaseSvg(baseSvgText: string): { doc: Document; svg: Element } | undefined {
  try {
    const doc = new DOMParser().parseFromString(baseSvgText, 'image/svg+xml');
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return undefined;
    if (doc.getElementsByTagName('parsererror').length > 0) return undefined;
    return { doc, svg };
  } catch {
    return undefined;
  }
}

/**
 * Build a full-document preview snapshot for a `body` hover result. Returns
 * `null` when there is nothing visible to show (invisible paint, missing
 * unit) or the input is unusable. The input string is never mutated; the
 * clone is serialized back to text.
 */
export function buildFillHoverBodySnapshot(options: {
  baseSvgText: string;
  index: number;
  property: 'fill' | 'stroke';
  point: { x: number; y: number };
  paint: FillHoverOverlayToolbarPaint;
}): string | null {
  // DOM-free fail-closed paths: invisible paint never shows an overlay, so
  // transparent previews stay allocation-free and unit-testable without a DOM.
  if (options.property === 'fill') {
    if (isFillInvisible(options.paint.fillTransparent, options.paint.secondaryTransparent, options.paint.paintGradient)) {
      return null;
    }
  } else if (options.paint.strokeGradient === 'solid' && options.paint.strokeTransparent) {
    return null;
  }
  const parsed = parseBaseSvg(options.baseSvgText);
  if (!parsed) return null;
  const { doc, svg } = parsed;
  let units: Element[];
  try {
    units = editableVectorUnits(svg);
  } catch {
    return null;
  }
  const target = units[options.index];
  if (!target) return null;
  try {
    if (options.property === 'fill') {
      const bounds = localVectorGradientBounds(target);
      const center = documentPointToLocalGradientPoint(target, options.point);
      const resolved = svgGradientPaint({
        id: 'fill-hover-preview',
        kind: options.paint.paintGradient,
        primary: options.paint.fillTransparent ? null : parseHex(options.paint.paintColor),
        secondary: options.paint.secondaryTransparent ? null : parseHex(options.paint.secondaryPaintColor),
        width: 480,
        height: 360,
        bounds,
        center: options.paint.paintGradient === 'radial' ? center : undefined,
      });
      if (resolved.fill === 'none') return null;
      appendPreviewDefs(svg, doc, resolved.defs);
      target.setAttribute('fill', resolved.fill);
      try {
        target.removeAttribute('fill-opacity');
      } catch {
        // Presentation hygiene only; the fill write stands alone.
      }
    } else {
      const bounds = localVectorGradientBounds(target);
      const center = documentPointToLocalGradientPoint(target, options.point);
      const resolved = svgStrokePaint({
        id: 'stroke-hover-preview',
        gradient: options.paint.strokeGradient,
        primary: options.paint.strokeTransparent ? null : parseHex(options.paint.strokeColor),
        secondary: options.paint.secondaryStrokeTransparent ? null : parseHex(options.paint.strokeSecondaryColor),
        strokeWidth: options.paint.strokeWidth,
        width: 480,
        height: 360,
        bounds,
        center: options.paint.strokeGradient === 'radial' ? center : undefined,
      });
      if (resolved.stroke === 'none') return null;
      appendPreviewDefs(svg, doc, resolved.defs);
      target.setAttribute('stroke', resolved.stroke);
      try {
        target.removeAttribute('stroke-opacity');
      } catch {
        // Presentation hygiene only; the stroke write stands alone.
      }
    }
  } catch {
    return null;
  }
  try {
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return null;
  }
}

/**
 * Build a full-document preview snapshot for a `hole-overlay` hover result.
 * Mirrors the commit path (`fillVectorHoleOverlayAtPoint`) minus history /
 * selection: a fill-only sibling path covering only the hole, with the
 * toolbar fill ramp. Returns `null` for transparent paint, unsafe geometry,
 * or unusable input (fail-closed, never a parent recolor).
 */
export function buildFillHoverHoleSnapshot(options: {
  baseSvgText: string;
  parentIndex: number;
  hole: FillHoverOverlayHoleInput;
  point: { x: number; y: number };
  paint: FillHoverOverlayToolbarPaint;
}): string | null {
  if (!isFillHoverHolePreviewSafe(options.hole)) return null;
  if (isFillInvisible(options.paint.fillTransparent, options.paint.secondaryTransparent, options.paint.paintGradient)) {
    return null;
  }
  const parsed = parseBaseSvg(options.baseSvgText);
  if (!parsed) return null;
  const { doc, svg } = parsed;
  let units: Element[];
  try {
    units = editableVectorUnits(svg);
  } catch {
    return null;
  }
  const source = units[options.parentIndex];
  if (!source) return null;
  let localBounds = {
    x: options.hole.holeDocumentBounds.x,
    y: options.hole.holeDocumentBounds.y,
    width: options.hole.holeDocumentBounds.width,
    height: options.hole.holeDocumentBounds.height,
  };
  try {
    const center = documentPointToLocalGradientPoint(source, options.point);
    const resolved = svgGradientPaint({
      id: 'fill-hover-preview',
      kind: options.paint.paintGradient,
      primary: options.paint.fillTransparent ? null : parseHex(options.paint.paintColor),
      secondary: options.paint.secondaryTransparent ? null : parseHex(options.paint.secondaryPaintColor),
      width: 480,
      height: 360,
      bounds: localBounds,
      center: options.paint.paintGradient === 'radial' ? center : undefined,
    });
    if (resolved.fill === 'none') return null;
    appendPreviewDefs(svg, doc, resolved.defs);
    const overlay = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
    overlay.setAttribute('d', options.hole.holePathData);
    if (options.hole.parentTransform) overlay.setAttribute('transform', options.hole.parentTransform);
    overlay.setAttribute('fill', resolved.fill);
    overlay.setAttribute('stroke', 'none');
    overlay.setAttribute('opacity', String(Math.max(0, Math.min(1, options.paint.vectorOpacity / 100))));
    overlay.setAttribute('pointer-events', 'none');
    const parent = source.parentElement ?? svg;
    parent.insertBefore(overlay, source.nextSibling);
    return new XMLSerializer().serializeToString(doc.documentElement);
  } catch {
    return null;
  }
}

function parseHex(hex: string): { r: number; g: number; b: number; a: number } {
  const match = /^#([0-9a-f]{6})$/i.exec((hex ?? '').trim());
  if (!match) return { r: 0, g: 0, b: 0, a: 255 };
  const value = Number.parseInt(match[1]!, 16);
  return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255, a: 255 };
}

/**
 * Route a resolver result to its snapshot builder. `none` /
 * `noop-transparent-hole` / `ambiguous` / `unsupported` (and invisible or
 * unsafe geometry) all yield `null` so callers render no overlay. Pure apart
 * from detached DOM parsing; never reads or writes live state.
 */
export function buildFillHoverPreviewSnapshot(options: {
  baseSvgText: string;
  result: FillHoverPreviewResult;
  point: { x: number; y: number };
  paint: FillHoverOverlayToolbarPaint;
}): string | null {
  const { result } = options;
  if (result.kind === 'body') {
    return buildFillHoverBodySnapshot({
      baseSvgText: options.baseSvgText,
      index: result.index,
      property: result.property,
      point: options.point,
      paint: options.paint,
    });
  }
  if (result.kind === 'hole-overlay') {
    return buildFillHoverHoleSnapshot({
      baseSvgText: options.baseSvgText,
      parentIndex: result.parentIndex,
      hole: {
        holePathData: result.hole.holePathData,
        parentTransform: result.hole.parentTransform,
        holeDocumentBounds: result.hole.holeDocumentBounds,
      },
      point: options.point,
      paint: options.paint,
    });
  }
  return null;
}
