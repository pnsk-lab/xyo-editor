import { expect, test } from 'bun:test'
import { createDefaultProject, ScratchCanvasRenderer, ScratchVM } from '../../vm/src/index'
import { createRendererCallbackTable, type RendererWasmModule } from '../src/renderer_callbacks'

test('wasm32 callbacks forward scene, memory and target identities synchronously', () => {
  const heap = new Uint8Array(65536)
  const functions = new Map<number, { fn: (...args: number[]) => number | void; sig: string }>()
  const freed: number[] = []
  let next = 1024, index = 1
  const wasm: RendererWasmModule = {
    HEAPU8: heap,
    _malloc(n) { const p=next; next += n+8; return p },
    _free(p) { freed.push(p) },
    addFunction(fn,sig) { const id=index++; functions.set(id,{fn,sig}); return id },
    removeFunction(id) { functions.delete(id) },
  }
  const vm = new ScratchVM(), project = createDefaultProject()
  project.targets[1]!.id = 'sprite-id'
  vm.loadProject(project)
  const renderer = new ScratchCanvasRenderer(), drawable = renderer.createDrawable('sprite')
  renderer.updateDrawableSkinId(drawable,renderer.createSVGSkin('<svg/>'))
  let syncs=0, change=0
  let mappings = [{targetPointer: 999, drawableId: drawable, target: vm.snapshot().project.targets[1]!}]
  const bridge = createRendererCallbackTable(wasm, {
    renderer, collisionMode:'approximate',
    sync() { syncs++; const snapshot=vm.snapshot(); mappings=mappings.map(m=>({...m,target:snapshot.project.targets[1]!})); return {snapshot,targets:mappings} },
    fenceRect() { return [-240,240,-180,180] },
    pickToScratch(x,y) { return [x-240,180-y] },
    setDrawableOrder(id,order,group,relative) { renderer.setDrawableOrder(id,order,group,relative); return renderer.getDrawableOrder(id) },
    destroyDrawable(id) { renderer.destroyDrawable(id); mappings=mappings.filter(m=>m.drawableId!==id) },
    visualChange(p) { change=p },
  })
  const v = new DataView(heap.buffer)
  const call = (slot: number,...args: number[]) => functions.get(v.getUint32(bridge.table+slot*4,true))!.fn(0,...args)
  expect(functions.size).toBe(21)
  expect(functions.get(v.getUint32(bridge.table+4,true))!.sig).toBe('iidd')
  expect(call(1,240,180)).toBe(drawable)
  expect(call(8,drawable)).toBe(1)
  expect(call(15,999)).toBe(drawable)
  expect(call(15,998)).toBe(-1)
  call(7,drawable,100); expect(v.getFloat64(100,true)).toBeLessThan(v.getFloat64(108,true))
  call(21,drawable,160); expect([0,1,2,3].map(i=>v.getFloat64(160+8*i,true))).toEqual([-240,240,-180,180])
  const order=call(14,200) as number; expect(v.getUint32(200,true)).toBe(1); expect(v.getInt32(order,true)).toBe(drawable)
  call(13,999); expect(change).toBe(999)
  const skin=call(16) as number; expect(skin).toBeGreaterThanOrEqual(0); expect(call(16)).toBe(-1)
  for(const [i,n] of [1,0,0,1].entries()) v.setFloat32(300+i*4,n,true)
  call(17,skin,300,2,1,2,3,4); call(18,skin,300,2,1,2); call(19,skin)
  expect(() => call(19,skin+999)).toThrow('Unknown pen skin')
  call(12,drawable); expect(call(8,drawable)).toBe(0)
  expect(syncs).toBeGreaterThan(10)
  bridge.dispose(); bridge.dispose()
  expect(functions.size).toBe(0); expect(freed).toContain(order); expect(freed).toContain(bridge.table)
})

test('registration failure rolls back all function pointers', () => {
  let count=0, removed=0, freed=0
  const wasm: RendererWasmModule = { HEAPU8:new Uint8Array(4096), _malloc:()=>64, _free:()=>{freed++}, addFunction:()=>{if(++count===4) throw Error('failure');return count}, removeFunction:()=>{removed++} }
  expect(() => createRendererCallbackTable(wasm, { renderer:new ScratchCanvasRenderer(), collisionMode:'approximate', sync:()=>{throw Error('unused')}, fenceRect:()=>[-1,1,-1,1], pickToScratch:(x,y)=>[x,y], setDrawableOrder:()=>0, destroyDrawable:()=>{}, visualChange:()=>{} })).toThrow('failure')
  expect(removed).toBe(3); expect(freed).toBe(1)
})
