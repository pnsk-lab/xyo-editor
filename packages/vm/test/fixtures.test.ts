import { describe, expect, it } from 'bun:test'
import { ScratchVM, type ScratchMonitor, type ScratchTarget, type ScratchValue } from '../src/index'
import { conformanceFixtures, type ConformanceFixture, type ExpectedTargetState, type FixtureAction } from './fixtures/conformance-fixtures'

interface Trace {
  fixtureId: string
  actionStep: number
  action: FixtureAction
  events: string[]
}

const eventNames = [
  'PROJECT_LOADED',
  'PROJECT_CHANGED',
  'PROJECT_RUN_START',
  'PROJECT_RUN_STOP',
  'PROJECT_STOP_ALL',
  'TARGETS_UPDATE',
  'MONITORS_UPDATE',
  'RUNTIME_STEP',
  'ERROR',
]

const runFixture = (fixture: ConformanceFixture) => {
  const vm = new ScratchVM()
  const events: string[] = []
  const penLines: unknown[] = []
  vm.attachRenderer({ penLine: (line) => penLines.push(line) })
  for (const eventName of eventNames) {
    vm.on(eventName, () => events.push(eventName))
  }

  fixture.steps.forEach((action, index) => {
    const trace = { fixtureId: fixture.id, actionStep: index, action, events }
    switch (action.action) {
      case 'load':
        vm.loadProject(fixture.createProject())
        break
      case 'greenFlag':
        vm.greenFlag()
        break
      case 'step':
        for (let frame = 0; frame < action.frames; frame += 1) vm.step()
        break
      case 'postKeyboard':
        vm.postKeyboard({ key: action.key, isDown: action.isDown })
        break
      case 'postMouse':
        vm.postMouse(action)
        break
      case 'postIOData':
        vm.postIOData(action.device, action.data)
        break
      case 'stopAll':
        vm.stopAll()
        break
      default:
        failWithTrace(trace, `Unsupported fixture action ${(action as FixtureAction).action}`)
    }
  })

  const actual = vm.snapshot()
  const finalTrace = { fixtureId: fixture.id, actionStep: fixture.steps.length - 1, action: fixture.steps.at(-1)!, events }
  if (fixture.expect.targetCount !== undefined) {
    expect(actual.project.targets.length, formatFailure(finalTrace, 'targetCount', fixture.expect.targetCount, actual.project.targets.length)).toBe(fixture.expect.targetCount)
  }
  if (fixture.expect.spriteCount !== undefined) {
    const spriteCount = actual.project.targets.filter((target) => !target.isStage && !target.isClone).length
    expect(spriteCount, formatFailure(finalTrace, 'spriteCount', fixture.expect.spriteCount, spriteCount)).toBe(fixture.expect.spriteCount)
  }
  for (const targetExpect of fixture.expect.targets ?? []) {
    const target = actual.project.targets.find((candidate) => candidate.name === targetExpect.name && !candidate.isClone)
    expect(target, formatFailure(finalTrace, `target:${targetExpect.name}`, targetExpect, actual.project.targets.map(targetSummary))).toBeDefined()
    assertTarget(finalTrace, target!, targetExpect, penLines.length)
  }
  for (const monitorExpect of fixture.expect.monitors ?? []) {
    const monitor = findMonitor(actual.project.monitors, monitorExpect)
    expect(monitor, formatFailure(finalTrace, 'monitor', monitorExpect, actual.project.monitors)).toBeDefined()
    for (const [key, expectedValue] of Object.entries(monitorExpect)) {
      if (expectedValue !== undefined && key !== 'id' && key !== 'opcode') {
        expect((monitor as unknown as Record<string, unknown>)[key], formatFailure(finalTrace, `monitor.${key}`, expectedValue, monitor)).toEqual(expectedValue)
      }
    }
  }
  for (const expectedEvent of fixture.expect.events ?? []) {
    expect(events, formatFailure(finalTrace, 'events', expectedEvent, events)).toContain(expectedEvent)
  }
  for (const extension of fixture.expect.extensions ?? []) {
    expect(actual.project.extensions, formatFailure(finalTrace, 'extensions', extension, actual.project.extensions)).toContain(extension)
  }
  const exportedJson = vm.toJSON()
  for (const text of fixture.expect.exportedJsonContains ?? []) {
    expect(exportedJson, formatFailure(finalTrace, 'exportedJsonContains', text, exportedJson)).toContain(text)
  }
}

describe('ScratchVM clean-room conformance fixtures', () => {
  for (const fixture of conformanceFixtures) {
    it(`${fixture.id}: ${fixture.description}`, () => {
      runFixture(fixture)
    })
  }
})

const assertTarget = (trace: Trace, target: ScratchTarget, expected: ExpectedTargetState, penLineCount: number): void => {
  const comparisons: Array<[keyof ExpectedTargetState, unknown]> = [
    ['x', target.x],
    ['y', target.y],
    ['visible', target.visible],
    ['direction', target.direction],
    ['size', target.size],
    ['volume', target.volume],
    ['currentCostume', target.currentCostume],
  ]
  for (const [key, actual] of comparisons) {
    const expectedValue = expected[key]
    if (expectedValue !== undefined) expect(actual, formatFailure(trace, `target.${expected.name}.${key}`, expectedValue, actual)).toEqual(expectedValue)
  }
  for (const [nameOrId, value] of Object.entries(expected.variables ?? {})) {
    const actual = recordValue(target.variables, nameOrId)
    expect(actual, formatFailure(trace, `target.${expected.name}.variables.${nameOrId}`, value, actual)).toEqual(value)
  }
  for (const [nameOrId, value] of Object.entries(expected.lists ?? {})) {
    const actual = recordValue(target.lists, nameOrId)
    expect(actual, formatFailure(trace, `target.${expected.name}.lists.${nameOrId}`, value, actual)).toEqual(value)
  }
  if (expected.penDown !== undefined) {
    expect(target.pen?.down, formatFailure(trace, `target.${expected.name}.pen.down`, expected.penDown, target.pen?.down)).toBe(expected.penDown)
  }
  if (expected.penLineCount !== undefined) {
    expect(penLineCount, formatFailure(trace, `target.${expected.name}.penLineCount`, expected.penLineCount, penLineCount)).toBe(expected.penLineCount)
  }
  for (const [effect, value] of Object.entries(expected.effects ?? {})) {
    const actual = target.effects?.[effect]
    expect(actual, formatFailure(trace, `target.${expected.name}.effects.${effect}`, value, actual)).toEqual(value)
  }
}

const findMonitor = (monitors: ScratchMonitor[], expected: Partial<ScratchMonitor>): ScratchMonitor | undefined =>
  monitors.find((monitor) =>
    (expected.id === undefined || monitor.id === expected.id)
    && (expected.opcode === undefined || monitor.opcode === expected.opcode))

const recordValue = <T extends ScratchValue | ScratchValue[]>(records: Record<string, [string, T, boolean?]>, nameOrId: string): T | undefined =>
  records[nameOrId]?.[1] ?? Object.values(records).find((record) => record[0] === nameOrId)?.[1]

const targetSummary = (target: ScratchTarget) => ({
  name: target.name,
  isStage: target.isStage,
  isClone: target.isClone,
  x: target.x,
  y: target.y,
  variables: target.variables,
  lists: target.lists,
})

const formatFailure = (trace: Trace, field: string, expected: unknown, actual: unknown): string =>
  JSON.stringify({
    fixtureId: trace.fixtureId,
    actionStep: trace.actionStep,
    action: trace.action,
    field,
    expected,
    actual,
    eventHistory: trace.events,
  }, null, 2)

const failWithTrace = (trace: Trace, message: string): never => {
  throw new Error(`${message}\n${formatFailure(trace, 'action', 'supported action', trace.action)}`)
}
