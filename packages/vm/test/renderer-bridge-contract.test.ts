import { describe, expect, it } from 'bun:test'
import { createDefaultProject, ScratchCanvasRenderer, ScratchVM } from '../src/index'

// Characterization tests, not claims of pixel-accurate Scratch rendering. A WASM
// bridge must not treat numeric drawables and snapshot target IDs as the same
// namespace or assume an unchanged snapshot reflects runtime mutations.
describe('renderer bridge integration constraints', () => {
  it('picks from the snapshot, not from the numeric drawable registry', () => {
    const project = createDefaultProject()
    project.targets[1]!.id = 'target-a'
    project.targets[1]!.x = 0
    project.targets[1]!.y = 0
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    renderer.requestDraw(vm.snapshot())
    const id = renderer.createDrawable('sprite')
    renderer.updateDrawableSkinId(id, renderer.createSVGSkin('<svg/>'))
    renderer.updateDrawablePosition(id, [200, 100])
    expect(renderer.pick(0, 0)).toBe('target-a')
    expect(renderer.pick(200, 100)).toBeNull()
    expect(renderer.drawableTouchingScratchPoint(id, 200, 100)).toBe(true)
    renderer.destroyDrawable(id)
    expect(renderer.pick(0, 0)).toBe('target-a')
  })

  it('does not update picking until a new snapshot is supplied', () => {
    const project = createDefaultProject()
    project.targets[1]!.id = 'target-a'
    project.targets[1]!.x = 0
    project.targets[1]!.y = 0
    const vm = new ScratchVM()
    vm.loadProject(project)
    const renderer = new ScratchCanvasRenderer()
    renderer.requestDraw(vm.snapshot())
    vm.getTarget('target-a')!.x = 200
    expect(renderer.pick(0, 0)).toBe('target-a')
    renderer.requestDraw(vm.snapshot())
    expect(renderer.pick(0, 0)).toBeNull()
    expect(renderer.pick(200, 0)).toBe('target-a')
  })

  it('numeric point touching uses bounds even for an empty SVG', () => {
    const renderer = new ScratchCanvasRenderer()
    const id = renderer.createDrawable('sprite')
    renderer.updateDrawableSkinId(id, renderer.createSVGSkin('<svg xmlns="http://www.w3.org/2000/svg"/>'))
    renderer.updateDrawablePosition(id, [0, 0])
    // This is a known approximation, not a correct alpha-pixel hit.
    expect(renderer.drawableTouchingScratchPoint(id, 0, 0)).toBe(true)
  })
})
