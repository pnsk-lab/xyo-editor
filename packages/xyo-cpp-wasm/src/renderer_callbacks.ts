import type { RuntimeSnapshot, ScratchCanvasRenderer, ScratchTarget } from '../../vm/src/index'

/** wasm32 only. The host must export addFunction/removeFunction and malloc/free. */
export interface RendererWasmModule {
  HEAPU8: Uint8Array
  _malloc(size: number): number
  _free(pointer: number): void
  addFunction(fn: (...args: number[]) => number | void, signature: string): number
  removeFunction(index: number): void
}
export interface RendererTargetMapping {
  /** Borrowed native Target identity; host must remove it before the target dies. */
  targetPointer: number
  drawableId: number
  target: ScratchTarget
}
export interface RendererScene {
  snapshot: RuntimeSnapshot
  /** Back-to-front. Both IDs and target identities must be unique and current. */
  targets: readonly RendererTargetMapping[]
}
export interface RendererCallbacksOptions {
  renderer: ScratchCanvasRenderer
  /** Synchronously obtain a current snapshot and current native-to-JS mappings. */
  sync(): RendererScene
  /** ScratchCanvasRenderer does not expose the native GPU fence rectangle. */
  fenceRect(drawableId: number): readonly [number, number, number, number]
  /** Convert runtime mouse canvas/client coordinates to Scratch coordinates. */
  pickToScratch(x: number, y: number): readonly [number, number]
  /** Mutations must synchronously update the scene owner's order/identity state. */
  setDrawableOrder(drawableId: number, order: number, group: string, relative: boolean): number
  destroyDrawable(drawableId: number): void
  visualChange(targetPointer: number): void
  /** Required acknowledgement: Canvas collision/fencing/skin behavior is approximate. */
  collisionMode: 'approximate'
}

/**
 * Prepare the wasm32 RendererCallbacks struct from renderer_bridge.hpp. This only
 * allocates the table; the embedding must copy it via RendererBridge::create and
 * install the resulting renderer before execution. Dispose only after detaching it.
 * The host owns snapshot freshness, loaded assets, mappings and Target lifetimes.
 * ScratchCanvasRenderer schedules painting asynchronously; geometry/color tests can
 * use approximations or fallbacks, and are NOT guaranteed pixel-perfect.
 */
export function createRendererCallbackTable(wasm: RendererWasmModule, options: RendererCallbacksOptions) {
  if (options.collisionMode !== 'approximate' || typeof options.sync !== 'function' || typeof options.fenceRect !== 'function' || typeof options.pickToScratch !== 'function' || typeof options.setDrawableOrder !== 'function' || typeof options.destroyDrawable !== 'function' || typeof options.visualChange !== 'function') {
    throw new Error('Canvas renderer requires synchronous scene and explicit approximate collision mode')
  }
  const r = options.renderer
  const indices: number[] = []
  let table = 0
  let orderBuffer = 0
  let disposed = false
  const penSkins = new Set<number>()
  const requirePen = (skin: number) => { if (!penSkins.has(skin)) throw new Error('Unknown pen skin') }
  const view = () => new DataView(wasm.HEAPU8.buffer, wasm.HEAPU8.byteOffset, wasm.HEAPU8.byteLength)
  const scene = () => {
    if (disposed) throw new Error('Renderer callback table disposed')
    const s = options.sync()
    if (!s || !s.snapshot || !Array.isArray(s.targets)) throw new Error('Renderer scene must be synchronous and complete')
    const ids = new Set<number>(), pointers = new Set<number>(), names = new Set<string>()
    for (const t of s.targets) {
      const name = t.target.id ?? t.target.name
      if (!t.targetPointer || t.drawableId < 0 || ids.has(t.drawableId) || pointers.has(t.targetPointer) || names.has(name)) throw new Error('Invalid renderer target mapping')
      ids.add(t.drawableId); pointers.add(t.targetPointer); names.add(name)
    }
    r.requestDraw(s.snapshot)
    return s
  }
  const target = (s: RendererScene, id: number) => {
    const t = s.targets.find((t) => t.drawableId === id)
    if (!t) throw new Error(`Unknown drawable ${id}`)
    return t
  }
  const name = (t: RendererTargetMapping) => t.target.id ?? t.target.name
  const writeDoubles = (p: number, values: readonly number[]) => values.forEach((v, i) => view().setFloat64(p + i * 8, v, true))
  const color = (rgb: number) => ({ r: (rgb >>> 16) & 255, g: (rgb >>> 8) & 255, b: rgb & 255, a: 255 })
  const pen = (rgba: number, size: number, x1: number, y1: number, x2: number, y2: number) => {
    const v = view(), c = [0, 1, 2, 3].map((i) => v.getFloat32(rgba + i * 4, true))
    const byte = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255)
    r.penLine({ x1, y1, x2, y2, size, color: `rgb(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])})`, transparency: (1 - Math.max(0, Math.min(1, c[3]))) * 100 })
  }
  const utf8 = (ptr: number) => {
    const end = wasm.HEAPU8.indexOf(0, ptr)
    if (!ptr || end < 0) throw new Error('Invalid group string')
    return new TextDecoder().decode(wasm.HEAPU8.subarray(ptr, end))
  }
  // Exact order and signatures match RendererCallbacks in renderer_bridge.hpp.
  const callbacks: [string, (...args: number[]) => number | void][] = [
    ['iidd', (_c,x,y) => { const s=scene(); const [sx,sy]=options.pickToScratch(x,y); const picked=r.pick(sx,sy); return s.targets.find((t)=>name(t)===picked)?.drawableId ?? -1 }],
    ['vi', () => { scene(); r.draw() }],
    ['iiidd', (_c,id,x,y) => { const s=scene(); return +r.drawableTouchingScratchPoint(name(target(s,id)),x,y) }],
    ['iiiii', (_c,id,p,n) => { const s=scene(); const names=[]; for(let i=0;i<n;i++) names.push(name(target(s,view().getInt32(p+4*i,true)))); return +r.isTouchingDrawables(name(target(s,id)),names) }],
    ['iiii', (_c,id,rgb) => { const s=scene(); return +r.isTouchingColor(name(target(s,id)),color(rgb)) }],
    ['iiiii', (_c,a,b,id) => { const s=scene(); return +r.isColorTouchingColor(name(target(s,id)),color(a),color(b)) }],
    ['viii', (_c,id,p) => { const s=scene(), b=r.getBounds(name(target(s,id))); if(!b) throw new Error('Missing drawable bounds'); writeDoubles(p,[b.left,b.right,b.top,b.bottom]) }],
    ['iii', (_c,id) => +scene().targets.some((t) => t.drawableId===id)],
    ['viiiii', (_c,id,x,y,f) => { const s=scene(); const v=view(); if(f) { const xy=r.getFencedPositionOfDrawable(name(target(s,id)),[v.getFloat64(x,true),v.getFloat64(y,true)]); writeDoubles(x,[xy[0]]); writeDoubles(y,[xy[1]]) } }],
    ['viiii', (_c,id,w,h) => { const s=scene(); target(s,id); const size=r.getCurrentSkinSize(id); writeDoubles(w,[size[0]]); writeDoubles(h,[size[1]]) }],
    ['diidii', (_c,id,o,g,relative) => { const s=scene(); target(s,id); return options.setDrawableOrder(id,o,utf8(g),!!relative) }],
    ['vii', (_c,id) => { const s=scene(); target(s,id); options.destroyDrawable(id) }],
    ['vii', (_c,p) => { const s=scene(); if(p && !s.targets.some((t) => t.targetPointer===p)) throw new Error('Unknown target identity'); options.visualChange(p) }],
    ['iii', (_c,p) => { const s=scene(); if(orderBuffer) wasm._free(orderBuffer); orderBuffer=0; const n=s.targets.length; if(n) { orderBuffer=wasm._malloc(n*4); if(!orderBuffer) throw new Error('Out of memory'); s.targets.forEach((t,i)=>view().setInt32(orderBuffer+i*4,t.drawableId,true)) } view().setUint32(p,n,true); return orderBuffer }],
    ['iii', (_c,p) => scene().targets.find((t)=>t.targetPointer===p)?.drawableId ?? -1],
    ['ii', () => { scene(); if (penSkins.size) return -1; const skin=r.createPenSkin(); if(skin>=0) penSkins.add(skin); return skin }],
    ['viiiddddd', (_c,s,rgba,d,x0,y0,x1,y1) => { scene(); requirePen(s); pen(rgba,d,x0,y0,x1,y1) }],
    ['viiiddd', (_c,s,rgba,d,x,y) => { scene(); requirePen(s); pen(rgba,d,x,y,x,y) }],
    ['vii', (_c,s) => { scene(); requirePen(s); r.penClear() }],
    ['viii', (_c,skin,id) => { const s=scene(); requirePen(skin); r.penStamp(target(s,id).target) }],
    ['viii', (_c,id,p) => { const s=scene(); target(s,id); writeDoubles(p,options.fenceRect(id)) }],
  ]
  try {
    table=wasm._malloc((callbacks.length+1)*4)
    if (!table) throw new Error('Out of memory')
    view().setUint32(table,0,true)
    callbacks.forEach(([sig,fn],i)=> { const index=wasm.addFunction(fn,sig); if(!index) throw new Error('Unable to register callback'); indices.push(index); view().setUint32(table+4*(i+1),index,true) })
  } catch (error) {
    for (const index of indices) wasm.removeFunction(index)
    if (table) wasm._free(table)
    throw error
  }
  return { table, dispose() { if(disposed) return; disposed=true; for(const index of indices) wasm.removeFunction(index); if(orderBuffer) wasm._free(orderBuffer); wasm._free(table) } }
}
