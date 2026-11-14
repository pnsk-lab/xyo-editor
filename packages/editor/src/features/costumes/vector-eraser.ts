// Vector eraser ported from scratch-paint `blob.js#mergeEraser`.
// A drag builds an eraser stroke shape (union of circles along the drag) and
// subtracts it from intersected paths, so only the brushed area disappears
// instead of deleting the whole object.

import { SVG_PLACEHOLDER, cleanSvgElementAttributes, sanitizeSvgFragmentForPaperImport } from './svg-sanitize';

export const VECTOR_ERASER_DEFAULT_SIZE = 40;

type Point = { x: number; y: number };

function lerpPoints(points: Point[], maxStep: number): Point[] {
  if (points.length <= 1) return [...points];
  const out: Point[] = [points[0]!];
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(distance / Math.max(0.5, maxStep)));
    for (let step = 1; step <= steps; step += 1) {
      out.push({ x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps });
    }
  }
  return out;
}

function firstEnclosesSecond(path1: paper.Item, path2: paper.Item): boolean {
  const second = path2 as paper.Path;
  if (!path1 || !path2 || !second.firstSegment?.point) return false;
  try {
    return Boolean((path1 as paper.Path).hitTest(second.firstSegment.point));
  } catch {
    return false;
  }
}

function touches(path1: paper.Item | undefined, path2: paper.Item | undefined): boolean {
  if (!path1 || !path2) return false;
  try {
    if ((path1 as unknown as paper.PathItem).intersects(path2 as unknown as paper.PathItem)) return true;
  } catch {
    // Fall through to containment checks.
  }
  return firstEnclosesSecond(path1, path2) || firstEnclosesSecond(path2, path1);
}

function pathHasVisibleFill(item: paper.Item): boolean {
  const fill = (item as paper.Path).fillColor;
  if (!fill) return false;
  const alpha = (fill as unknown as { _alpha?: number; alpha?: number })._alpha
    ?? (fill as unknown as { alpha?: number }).alpha;
  if (typeof alpha === 'number') return alpha !== 0;
  return true;
}

export function separateCompoundPath(compoundPath: paper.CompoundPath): paper.Item[] {
  const compound = compoundPath as unknown as {
    clockwise: boolean;
    reverse(): void;
    children: paper.Path[];
  };
  if (!compound.clockwise) compound.reverse();
  // Split subpaths by winding: clockwise loops are solid regions and
  // counter-clockwise loops are holes punched out of them.
  const solids: paper.Path[] = [];
  const holes: paper.Path[] = [];
  for (const child of Array.from(compound.children)) {
    if (child.clockwise) solids.push(child);
    else holes.push(child);
  }
  const absArea = (path: paper.Path) => Math.abs(path.area ?? 0);
  solids.sort((a, b) => absArea(a) - absArea(b));
  holes.sort((a, b) => absArea(a) - absArea(b));

  const pieces: paper.Item[] = [];
  const consumedHoles = new Set<paper.Path>();
  for (const solid of solids) {
    solid.copyAttributes(compoundPath, false);
    solid.fillColor = compoundPath.fillColor;
    solid.strokeColor = compoundPath.strokeColor;
    solid.strokeWidth = compoundPath.strokeWidth;
    solid.insertAbove(compoundPath);
    let current: paper.PathItem = solid as unknown as paper.PathItem;
    // Carve out only the holes sitting inside this solid, largest first so
    // nested windings resolve from the outside in.
    const owned = holes
      .filter((hole) => !consumedHoles.has(hole) && firstEnclosesSecond(solid, hole as unknown as paper.Item))
      .sort((a, b) => absArea(b) - absArea(a));
    for (const hole of owned) {
      // Detach both operands first: paper.js boolean ops return an empty
      // result when the operands are still children of the compound.
      (current as unknown as paper.Item).remove();
      (hole as unknown as paper.Item).remove();
      let carved: paper.PathItem;
      try {
        carved = (current as unknown as paper.Path).subtract(hole as unknown as paper.PathItem) as unknown as paper.PathItem;
      } catch {
        // Keep the uncarved solid rather than losing the shape entirely.
        carved = current;
      }
      carved.insertAbove(compoundPath);
      consumedHoles.add(hole);
      current = carved;
    }
    pieces.push(current as unknown as paper.Item);
  }
  // Holes belonging to no solid (degenerate input) must not vanish along
  // with the compound container: keep them as their own pieces.
  for (const hole of holes) {
    if (consumedHoles.has(hole)) continue;
    (hole as unknown as paper.Item).insertAbove(compoundPath);
    pieces.push(hole as unknown as paper.Item);
  }
  try {
    (compoundPath as unknown as paper.Item).remove();
  } catch {
    // Already detached; the collected pieces are still valid.
  }
  return pieces;
}

function buildEraserItem(scope: paper.PaperScope, points: Point[], size: number): paper.PathItem | undefined {
  const radius = Math.max(0.5, size / 2);
  const dense = lerpPoints(points, Math.max(1, size / 4));
  if (dense.length === 0) return undefined;
  let eraser: paper.PathItem | undefined;
  for (const point of dense) {
    const circle = new scope.Path.Circle({
      center: new scope.Point(point.x, point.y),
      radius,
      fillColor: 'black',
    }) as unknown as paper.PathItem;
    if (!eraser) {
      eraser = circle;
    } else {
      const united = (eraser as paper.Path).unite(circle as unknown as paper.PathItem);
      (eraser as paper.Item).remove();
      (circle as paper.Item).remove();
      eraser = united;
    }
  }
  return eraser;
}

function importSingleElement(scope: paper.PaperScope, element: Element): paper.Item | undefined {
  try {
    // Trust boundary: same fragment-safe wrapper as the reshape path. The
    // serialized live Element is untrusted markup — sanitize (fresh `<svg>`
    // root + full display-sanitizer pass, incl. `data-paper-data` removal)
    // so handler breakout tags are stripped while the element's own transform
    // and children survive for faithful boolean ops. Placeholder means the
    // fragment was unsalvageable — refuse instead of importing it raw.
    const raw = new XMLSerializer().serializeToString(element);
    const svg = sanitizeSvgFragmentForPaperImport(raw);
    if (!svg || svg === SVG_PLACEHOLDER) return undefined;
    const imported = (
      scope.project as unknown as { importSVG: (svg: string, options?: { insert?: boolean; expandShapes?: boolean }) => paper.Item }
    ).importSVG(svg, { insert: false, expandShapes: true });
    return imported ?? undefined;
  } catch {
    return undefined;
  }
}

function exportItemsToElements(items: paper.Item[], doc: Document): Element[] {
  const elements: Element[] = [];
  for (const item of items) {
    try {
      const exported = item.exportSVG({ asString: false }) as Element;
      const node = doc.importNode(exported, true) as Element;
      // Defense in depth: Paper exports fresh geometry nodes, but run the
      // same post-pass before they go live so no import-time attribute
      // (e.g. a retained `data-paper-data`) reaches the document unchecked.
      cleanSvgElementAttributes(node);
      elements.push(node);
    } catch {
      // Skip items that cannot be exported.
    }
  }
  return elements;
}

// Paper.js imports SVG basic shapes (`<rect>`, `<ellipse>`, ...) as `Shape`
// items, which have no boolean methods. Expand them to paths first so the
// subtract below really cuts instead of throwing (which used to be reported
// as a touch that rewrote the element unchanged).
function expandShapeItem(item: paper.Item): paper.Item {
  if ((item as unknown as { className?: string }).className !== 'Shape') return item;
  const convert = (item as unknown as { toPath?: (insert?: boolean) => paper.Item }).toPath;
  if (typeof convert !== 'function') return item;
  try {
    const converted = convert.call(item, Boolean((item as paper.Item).parent));
    if (converted && converted !== (item as unknown as paper.Item)) {
      try {
        (item as paper.Item).remove();
      } catch {
        // Already detached.
      }
      return converted;
    }
  } catch {
    // Keep the original shape; the subtract below fails soft and the target
    // survives untouched.
  }
  return item;
}

// Erase the eraser shape from one imported top-level item. Returns the
// surviving items (possibly empty when fully erased).
export function eraseFromItem(item: paper.Item, eraser: paper.PathItem): { touched: boolean; survivors: paper.Item[] } {
  const itemClass = (item as unknown as { className?: string }).className;
  if (itemClass === 'Group') {
    // Keep group transforms, clipping and stacking while changing its paths.
    let touched = false;
    for (const child of Array.from((item as paper.Group).children)) {
      const result = eraseFromItem(child, eraser);
      touched ||= result.touched;
    }
    return { touched, survivors: [item] };
  }
  const targets: paper.PathItem[] = [expandShapeItem(item) as paper.PathItem];

  let touched = false;
  const survivors: paper.Item[] = [];
  for (const target of targets) {
    if (!touches(eraser, target as paper.Item)) {
      survivors.push(target as paper.Item);
      continue;
    }
    const asPath = target as unknown as paper.Path;
    const isUnfilledPath = Array.isArray(asPath.segments) && !pathHasVisibleFill(target as paper.Item);

    if (isUnfilledPath) {
      // Port of the unfilled-path branch in `mergeEraser`: split at every
      // intersection and drop the pieces inside the eraser stroke.
      touched = true;
      const subpaths: paper.Path[] = [];
      let intersections: paper.CurveLocation[] = [];
      try {
        intersections = asPath.getIntersections(eraser);
      } catch {
        intersections = [];
      }
      for (let j = intersections.length - 1; j >= 0; j -= 1) {
        const split = asPath.splitAt(intersections[j]!);
        // Splitting a closed path first opens it and returns the same path.
        if (split && split !== asPath) {
          split.insertAbove(asPath);
          subpaths.push(split as paper.Path);
        }
      }
      subpaths.push(asPath);
      for (let k = subpaths.length - 1; k >= 0; k -= 1) {
        const midpoint = subpaths[k]!.getLocationAt(subpaths[k]!.length / 2)?.point;
        if (midpoint && (eraser as unknown as paper.Path).contains(midpoint)) {
          subpaths[k]!.remove();
          subpaths.splice(k, 1);
        }
      }
      survivors.push(...subpaths);
      continue;
    }

    let newPath: paper.PathItem | undefined;
    try {
      newPath = (target as unknown as paper.Path).subtract(eraser);
    } catch {
      survivors.push(target as paper.Item);
      continue;
    }
    touched = true;
    newPath.insertBelow(target as paper.Item);

    if (Array.isArray(asPath.segments) && !asPath.closed) {
      // Keep open-path fragments that `subtract` turned into a shape from
      // disappearing entirely, mirroring `mergeEraser`.
      const firstSeg = (target as unknown as paper.Path).clone() as paper.Path;
      let intersections: paper.CurveLocation[] = [];
      try {
        intersections = firstSeg.getIntersections(eraser);
      } catch {
        intersections = [];
      }
      const subpaths: paper.Path[] = [];
      for (let j = intersections.length - 1; j >= 0; j -= 1) {
        const split = firstSeg.splitAt(intersections[j]!);
        if (split) {
          split.insertAbove(firstSeg);
          subpaths.push(split as paper.Path);
        }
      }
      subpaths.push(firstSeg);
      for (let k = subpaths.length - 1; k >= 0; k -= 1) {
        const midpoint = subpaths[k]!.getLocationAt(subpaths[k]!.length / 2)?.point;
        if (
          midpoint &&
          ((eraser as unknown as paper.Path).contains(midpoint) ||
            (newPath as unknown as paper.Path).contains(midpoint))
        ) {
          subpaths[k]!.remove();
          subpaths.splice(k, 1);
        }
      }
      // Fragments outside both shapes are not represented by the subtraction.
      survivors.push(...subpaths.reverse());
    }

    const newCompound = newPath as unknown as paper.CompoundPath;
    if ((newCompound as unknown as { children?: unknown }).children) {
      // Splitting can yield several disjoint shapes (and holes). Keep every
      // piece the splitter returns so untouched geometry never disappears.
      const pieces = separateCompoundPath(newCompound);
      (target as paper.Item).remove();
      survivors.push(...pieces);
    } else {
      survivors.push(newPath as paper.Item);
      (target as paper.Item).remove();
    }
  }
  return { touched, survivors };
}

export type VectorEraseResult = {
  erased: boolean;
  erasedFromSelection: boolean;
};

/**
 * Subtract an eraser stroke from SVG children, mirroring scratch-paint.
 * When `selectedIndices` is non-empty, only those objects are tried first;
 * if nothing was hit every object is tried (scratch-paint then clears the
 * selection and erases from all).
 */
export function eraseVectorStrokeFromSvg(
  scope: paper.PaperScope,
  svg: Element,
  children: Element[],
  points: Point[],
  size: number,
  selectedIndices: number[],
): VectorEraseResult {
  const eraser = buildEraserItem(scope, points, Math.max(1, size));
  if (!eraser) return { erased: false, erasedFromSelection: false };
  try {
    const normalizedSelected = [...new Set(selectedIndices)].filter(
      (index) => index >= 0 && index < children.length,
    );
    const attempt = (indices: number[]): boolean => {
      let erased = false;
      for (const index of [...indices].sort((a, b) => b - a)) {
        const element = children[index];
        const parent = element?.parentNode;
        if (!element || !parent || !svg.contains(element)) continue;
        // Editable units can be nested under SVG wrapper groups. Their Paper
        // import uses parent-local coordinates, whereas the brush is in SVG
        // coordinates. Transform a copy of the brush into that local space.
        const matrix = new scope.Matrix();
        const ancestors: Element[] = [];
        for (let node = element.parentElement; node && node !== svg; node = node.parentElement) ancestors.unshift(node);
        for (const ancestor of ancestors) {
          const copy = ancestor.cloneNode(false) as SVGGraphicsElement;
          const transform = copy.transform?.baseVal?.consolidate()?.matrix;
          if (transform) matrix.append(new scope.Matrix(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f));
        }
        if (!matrix.isInvertible()) continue;
        const localEraser = (eraser as paper.Item).clone({ insert: false }) as paper.PathItem;
        localEraser.transform(matrix.inverted());
        const imported = importSingleElement(scope, element);
        if (!imported) {
          localEraser.remove();
          continue;
        }
        const owned: paper.Item[] = [imported, localEraser];
        try {
          const groupChildren = (imported as paper.Group).children;
          if (groupChildren && !Array.isArray((imported as paper.Path).segments)) {
            for (const child of Array.from(groupChildren)) owned.push(child as paper.Item);
          }
          const { touched, survivors } = eraseFromItem(imported, localEraser);
          owned.push(...survivors);
          if (!touched) continue;
          const replacements = exportItemsToElements(
            survivors.filter((item) => {
              try {
                const path = item as paper.Path;
                if (Array.isArray(path.segments)) {
                  if (path.length <= 0.001 && !pathHasVisibleFill(item)) return false;
                }
                return true;
              } catch {
                return true;
              }
            }),
            element.ownerDocument,
          );
          if (replacements.length === 0) element.remove();
          else {
            let anchor: Node | null = element;
            for (const replacement of replacements) {
              parent.insertBefore(replacement, anchor);
              anchor = replacement.nextSibling;
            }
            element.remove();
          }
          erased = true;
        } finally {
          for (const item of owned) {
            try {
              item.remove();
            } catch {
              // Already removed via replacement.
            }
          }
          try {
            (eraser as paper.Item).bringToFront?.();
          } catch {
            // ignore
          }
        }
      }
      return erased;
    };

    if (normalizedSelected.length > 0) {
      if (attempt(normalizedSelected)) return { erased: true, erasedFromSelection: true };
    }
    if (attempt(children.map((_, index) => index))) return { erased: true, erasedFromSelection: false };
    return { erased: false, erasedFromSelection: false };
  } finally {
    (eraser as paper.Item).remove();
  }
}
