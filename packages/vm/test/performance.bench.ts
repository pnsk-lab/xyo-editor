import { describe, expect, it } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ScratchVM, createDefaultProject, type ScratchBlock, type ScratchProject } from '../src/index'

const artifactRoot = join(import.meta.dir, 'test-artifacts')

describe('ScratchVM performance baseline', () => {
  it('records scale metrics for sprites, blocks, lists, monitors, clones, and turbo stepping', () => {
    mkdirSync(artifactRoot, { recursive: true })
    const project = makeScaleProject()
    const vm = new ScratchVM()

    const loadStart = performance.now()
    vm.loadProject(project)
    const loadMs = performance.now() - loadStart

    const runStart = performance.now()
    vm.greenFlag()
    for (let frame = 0; frame < 60; frame += 1) vm.step()
    const normalStepMs = performance.now() - runStart

    vm.setTurboMode(true)
    const turboStart = performance.now()
    for (let frame = 0; frame < 120; frame += 1) vm.step()
    const turboStepMs = performance.now() - turboStart

    const exportStart = performance.now()
    const exported = vm.exportProject()
    const exportMs = performance.now() - exportStart
    const cloneStress = runCloneStress()
    const costumeEditStress = runRepeatedCostumeEditStress()

    const report = {
      generated: '2026-05-15',
      scenarios: {
        sprites: exported.targets.filter((target) => !target.isStage && !target.isClone).length,
        blocks: exported.targets.reduce((sum, target) => sum + Object.keys(target.blocks).length, 0),
        listItems: exported.targets.reduce((sum, target) => sum + Object.values(target.lists).reduce((listSum, list) => listSum + list[1].length, 0), 0),
        monitors: exported.monitors.length,
        clones: cloneStress.cloneCount,
        repeatedCostumeEdits: costumeEditStress.edits,
      },
      metricsMs: {
        loadMs,
        normalStep60FramesMs: normalStepMs,
        turboStep120FramesMs: turboStepMs,
        exportMs,
        clone300Ms: cloneStress.ms,
        repeatedCostumeEditMs: costumeEditStress.ms,
      },
      memoryBytes: {
        repeatedCostumeEditHeapDelta: costumeEditStress.heapDelta,
        repeatedCostumeEditHeapBefore: costumeEditStress.heapBefore,
        repeatedCostumeEditHeapAfter: costumeEditStress.heapAfter,
      },
    }
    writeFileSync(join(artifactRoot, 'performance-report.json'), `${JSON.stringify(report, null, 2)}\n`)

    expect(report.scenarios.sprites).toBe(100)
    expect(report.scenarios.blocks).toBeGreaterThanOrEqual(1000)
    expect(report.scenarios.listItems).toBe(10000)
    expect(report.scenarios.monitors).toBeGreaterThanOrEqual(2)
    expect(report.scenarios.clones).toBe(300)
    expect(report.scenarios.repeatedCostumeEdits).toBe(300)
    expect(loadMs).toBeLessThan(5000)
    expect(normalStepMs).toBeLessThan(10000)
    expect(turboStepMs).toBeLessThan(10000)
    expect(exportMs).toBeLessThan(5000)
    expect(cloneStress.ms).toBeLessThan(5000)
    expect(costumeEditStress.ms).toBeLessThan(10000)
    expect(costumeEditStress.heapDelta).toBeLessThan(128 * 1024 * 1024)
  }, 20000)
})

const makeScaleProject = (): ScratchProject => {
  const project = createDefaultProject()
  const base = project.targets[1]!
  project.targets = [project.targets[0]!]
  for (let index = 0; index < 100; index += 1) {
    const sprite = structuredClone(base)
    sprite.id = `sprite-${index}`
    sprite.name = `Sprite${index + 1}`
    sprite.x = (index % 20) * 12 - 120
    sprite.y = Math.floor(index / 20) * 24 - 60
    sprite.layerOrder = index + 1
    sprite.variables = { count: ['count', 0] }
    sprite.lists = index === 0 ? { large: ['large', Array.from({ length: 10000 }, (_value, item) => item)] } : {}
    sprite.blocks = makeBlockStack(index)
    project.targets.push(sprite)
  }
  project.monitors = [
    { id: 'sprite-0:count', mode: 'default', opcode: 'data_variable', params: { VARIABLE: 'count' }, spriteName: 'Sprite1', visible: true },
    { id: 'sprite-0:large', mode: 'list', opcode: 'data_listcontents', params: { LIST: 'large' }, spriteName: 'Sprite1', visible: true, width: 200, height: 120 },
  ]
  return project
}

const makeBlockStack = (spriteIndex: number) => {
  const blocks: Record<string, ScratchBlock> = {
    flag: { opcode: 'event_whenflagclicked', next: 'move-0', topLevel: true, x: 20 + spriteIndex, y: 20 + spriteIndex },
  }
  for (let index = 0; index < 10; index += 1) {
    blocks[`move-${index}`] = {
      opcode: 'motion_movesteps',
      parent: index === 0 ? 'flag' : `change-${index - 1}`,
      next: `change-${index}`,
      inputs: { STEPS: [1, [4, '1']] },
    }
    blocks[`change-${index}`] = {
      opcode: 'data_changevariableby',
      parent: `move-${index}`,
      next: index === 9 ? null : `move-${index + 1}`,
      fields: { VARIABLE: ['count', 'count'] },
      inputs: { VALUE: [1, [4, '1']] },
    }
  }
  return blocks
}

const runCloneStress = () => {
  const project = createDefaultProject()
  const sprite = project.targets[1]!
  sprite.blocks = {
    flag: { opcode: 'event_whenflagclicked', next: 'repeat', topLevel: true },
    repeat: { opcode: 'control_repeat', parent: 'flag', inputs: { TIMES: [1, [4, '300']], SUBSTACK: [2, 'clone'] } },
    clone: { opcode: 'control_create_clone_of', parent: 'repeat', inputs: { CLONE_OPTION: [1, [10, '_myself_']] } },
    startClone: { opcode: 'control_start_as_clone', topLevel: true },
  }
  const vm = new ScratchVM()
  vm.loadProject(project)
  const start = performance.now()
  vm.greenFlag()
  for (let frame = 0; frame < 1200 && vm.exportProject().targets.filter((target) => target.isClone).length < 300; frame += 1) {
    vm.step()
  }
  const ms = performance.now() - start
  const cloneCount = vm.exportProject().targets.filter((target) => target.isClone).length
  vm.stopAll()
  return { cloneCount, ms }
}

const runRepeatedCostumeEditStress = () => {
  const vm = new ScratchVM()
  vm.loadProject(createDefaultProject())
  runGc()
  const heapBefore = process.memoryUsage().heapUsed
  const start = performance.now()
  for (let index = 0; index < 300; index += 1) {
    const color = (0x100000 + ((index * 7919) % 0xffffff)).toString(16).slice(-6)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#${color}"/><text x="48" y="54" font-size="18" text-anchor="middle">${index}</text></svg>`
    vm.updateCostume('Sprite1', 0, { name: 'costume1', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 }, new TextEncoder().encode(svg))
  }
  const ms = performance.now() - start
  runGc()
  const heapAfter = process.memoryUsage().heapUsed
  return { edits: 300, ms, heapBefore, heapAfter, heapDelta: Math.max(0, heapAfter - heapBefore) }
}

const runGc = () => {
  const maybeGc = (globalThis as typeof globalThis & { gc?: () => void }).gc
  if (typeof maybeGc === 'function') maybeGc()
}
