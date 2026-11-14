// Bounded stamp cache for bitmap brush/eraser marks.
//
// A diameter-100 disc is ~100x100px; with unbounded colors the
// `Map<string, HTMLCanvasElement>` in the brush/eraser modules could grow
// without limit (one canvas per diameter/color pair, plus one guide-color
// variant for the eraser). This helper keeps the existing identical-stamp
// identity (same key returns the same canvas while cached) but evicts the
// oldest entry once the limit is exceeded, so peak memory stays bounded.
// Evicted canvases already handed out are never mutated, so in-flight
// drawing references keep working; a later request simply re-renders.

export const BRUSH_MARK_CACHE_LIMIT = 64;
export const ERASER_MARK_CACHE_LIMIT = 64;

/**
 * Return the cached canvas for `key`, creating and storing it first when
 * absent. When the insert pushes the map past `limit`, the oldest entries
 * are dropped (insertion order). The returned canvas is never mutated here,
 * so previously handed-out stamps stay valid after eviction.
 */
export function cacheCanvasMark(
  cache: Map<string, HTMLCanvasElement>,
  key: string,
  create: () => HTMLCanvasElement,
  limit: number = BRUSH_MARK_CACHE_LIMIT,
): HTMLCanvasElement {
  const cached = cache.get(key);
  if (cached) return cached;
  const created = create();
  cache.set(key, created);
  const capped = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : BRUSH_MARK_CACHE_LIMIT;
  while (cache.size > capped) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return created;
}
