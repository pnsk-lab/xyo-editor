import { createDefaultProject, type ScratchProject, type ScratchValue } from '../../src/index'

export type FixtureAction =
  | { action: 'load' }
  | { action: 'greenFlag' }
  | { action: 'step'; frames: number }
  | { action: 'postKeyboard'; key: string; isDown: boolean }
  | { action: 'postMouse'; x: number; y: number; isDown?: boolean; canvasWidth?: number; canvasHeight?: number }
  | { action: 'postIOData'; device: string; data: unknown }
  | { action: 'stopAll' }

export interface ExpectedTargetState {
  name: string
  x?: number
  y?: number
  visible?: boolean
  direction?: number
  size?: number
  volume?: number
  currentCostume?: number
  effects?: Record<string, number>
  variables?: Record<string, ScratchValue>
  lists?: Record<string, ScratchValue[]>
  penDown?: boolean
  penLineCount?: number
}

export interface ExpectedMonitorState {
  id?: string
  opcode?: string
  visible?: boolean
  value?: ScratchValue | ScratchValue[]
}

export interface FixtureExpectation {
  targets?: ExpectedTargetState[]
  targetCount?: number
  spriteCount?: number
  monitors?: ExpectedMonitorState[]
  events?: string[]
  extensions?: string[]
  exportedJsonContains?: string[]
}

export interface ConformanceFixture {
  id: string
  level: 1 | 2 | 3 | 4
  kind: 'project'
  source: 'authored-clean-room'
  description: string
  spec: string
  createProject: () => ScratchProject
  steps: FixtureAction[]
  expect: FixtureExpectation
}

const defaultProjectWith = (mutate: (project: ScratchProject) => void): ScratchProject => {
  const project = createDefaultProject()
  mutate(project)
  return project
}

export const conformanceFixtures: ConformanceFixture[] = [
  {
    id: 'motion-basic-001',
    level: 1,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Green flag moves the default sprite and preserves target selection.',
    spec: 'spec/runtime-semantics.md#motion',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true, x: 40, y: 60 },
        move: { opcode: 'motion_movesteps', parent: 'flag', inputs: { STEPS: [1, [4, '10']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 1 }],
    expect: {
      targetCount: 2,
      spriteCount: 1,
      targets: [{ name: 'Sprite1', x: 10, y: 0 }],
      events: ['PROJECT_LOADED', 'PROJECT_RUN_START'],
      exportedJsonContains: ['event_whenflagclicked', 'motion_movesteps'],
    },
  },
  {
    id: 'events-broadcast-wait-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Broadcast-and-wait pauses the sender until the receiver mutates state.',
    spec: 'spec/runtime-semantics.md#events',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.done = ['done', 0]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'broadcast', topLevel: true },
        broadcast: { opcode: 'event_broadcastandwait', parent: 'flag', next: 'after', inputs: { BROADCAST_INPUT: [1, [10, 'ready']] } },
        after: { opcode: 'data_setvariableto', parent: 'broadcast', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [10, 'after']] } },
        receive: { opcode: 'event_whenbroadcastreceived', next: 'setReceiver', topLevel: true, fields: { BROADCAST_OPTION: ['ready'] } },
        setReceiver: { opcode: 'data_setvariableto', parent: 'receive', fields: { VARIABLE: ['done', 'done'] }, inputs: { VALUE: [1, [10, 'receiver']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 4 }],
    expect: {
      targets: [{ name: 'Sprite1', variables: { done: 'after' } }],
      events: ['PROJECT_LOADED', 'PROJECT_RUN_START'],
    },
  },
  {
    id: 'data-list-monitor-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'List mutation blocks apply Scratch index words and update list monitors.',
    spec: 'spec/runtime-semantics.md#variables-and-lists',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.lists.items = ['items', ['a', 'b']]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'insert', topLevel: true },
        insert: { opcode: 'data_insertatlist', parent: 'flag', next: 'replace', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [10, 'last']], ITEM: [1, [10, 'c']] } },
        replace: { opcode: 'data_replaceitemoflist', parent: 'insert', next: 'delete', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [10, '1']], ITEM: [1, [10, 'first']] } },
        delete: { opcode: 'data_deleteoflist', parent: 'replace', next: 'show', fields: { LIST: ['items', 'items'] }, inputs: { INDEX: [1, [10, '2']] } },
        show: { opcode: 'data_showlist', parent: 'delete', fields: { LIST: ['items', 'items'] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 5 }],
    expect: {
      targets: [{ name: 'Sprite1', lists: { items: ['first', 'c'] } }],
      monitors: [{ opcode: 'data_listcontents', visible: true, value: ['first', 'c'] }],
    },
  },
  {
    id: 'control-clone-cleanup-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Clone-start hats run for clones and stop-all removes clone targets.',
    spec: 'spec/runtime-semantics.md#clones',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.cloned = ['cloned', 0]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'clone', topLevel: true },
        clone: { opcode: 'control_create_clone_of', parent: 'flag', inputs: { CLONE_OPTION: [1, [10, '_myself_']] } },
        startClone: { opcode: 'control_start_as_clone', next: 'setClone', topLevel: true },
        setClone: { opcode: 'data_setvariableto', parent: 'startClone', fields: { VARIABLE: ['cloned', 'cloned'] }, inputs: { VALUE: [1, [4, '1']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 2 }, { action: 'stopAll' }],
    expect: {
      targetCount: 2,
      spriteCount: 1,
      targets: [{ name: 'Sprite1', variables: { cloned: 0 } }],
      events: ['PROJECT_LOADED', 'PROJECT_RUN_START', 'PROJECT_STOP_ALL'],
    },
  },
  {
    id: 'extensions-pen-video-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Pen and video-sensing extension blocks update observable VM state without external services.',
    spec: 'spec/runtime-semantics.md#procedures-and-extensions',
    createProject: () => defaultProjectWith((project) => {
      project.extensions = ['pen', 'videoSensing']
      const sprite = project.targets[1]!
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'penDown', topLevel: true },
        penDown: { opcode: 'pen_penDown', parent: 'flag', next: 'move' },
        move: { opcode: 'motion_movesteps', parent: 'penDown', next: 'video', inputs: { STEPS: [1, [4, '15']] } },
        video: { opcode: 'videoSensing_setVideoTransparency', parent: 'move', inputs: { TRANSPARENCY: [1, [4, '33']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 3 }],
    expect: {
      extensions: ['pen', 'videoSensing'],
      targets: [{ name: 'Sprite1', x: 15, penDown: true, penLineCount: 1 }],
      exportedJsonContains: ['pen_penDown', 'videoSensing_setVideoTransparency'],
    },
  },
  {
    id: 'looks-costume-sound-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Looks and sound commands mutate costume selection, visibility, size, effects, and volume.',
    spec: 'spec/runtime-semantics.md#looks',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.costumes.push({ name: 'second', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 })
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'nextCostume', topLevel: true },
        nextCostume: { opcode: 'looks_nextcostume', parent: 'flag', next: 'hide' },
        hide: { opcode: 'looks_hide', parent: 'nextCostume', next: 'show' },
        show: { opcode: 'looks_show', parent: 'hide', next: 'size' },
        size: { opcode: 'looks_setsizeto', parent: 'show', next: 'effect', inputs: { SIZE: [1, [4, '150']] } },
        effect: { opcode: 'looks_seteffectto', parent: 'size', next: 'volume', fields: { EFFECT: ['ghost'] }, inputs: { VALUE: [1, [4, '40']] } },
        volume: { opcode: 'sound_setvolumeto', parent: 'effect', inputs: { VOLUME: [1, [4, '35']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 7 }],
    expect: {
      targets: [{ name: 'Sprite1', visible: true, currentCostume: 1, size: 150, volume: 35, effects: { ghost: 40 } }],
      exportedJsonContains: ['looks_nextcostume', 'sound_setvolumeto'],
    },
  },
  {
    id: 'operators-coercion-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Operator reporters coerce strings, numbers, comparisons, modulo, and joins through variable blocks.',
    spec: 'spec/runtime-semantics.md#operators',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.joined = ['joined', '']
      sprite.variables.less = ['less', false]
      sprite.variables.mod = ['mod', 0]
      sprite.variables.sum = ['sum', 0]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'setJoined', topLevel: true },
        setJoined: { opcode: 'data_setvariableto', parent: 'flag', next: 'setLess', fields: { VARIABLE: ['joined', 'joined'] }, inputs: { VALUE: [2, 'join'] } },
        join: { opcode: 'operator_join', parent: 'setJoined', inputs: { STRING1: [1, [10, 'hello']], STRING2: [1, [10, ' world']] } },
        setLess: { opcode: 'data_setvariableto', parent: 'setJoined', next: 'setMod', fields: { VARIABLE: ['less', 'less'] }, inputs: { VALUE: [2, 'lessReporter'] } },
        lessReporter: { opcode: 'operator_lt', parent: 'setLess', inputs: { OPERAND1: [1, [10, '9']], OPERAND2: [1, [10, '10']] } },
        setMod: { opcode: 'data_setvariableto', parent: 'setLess', next: 'setSum', fields: { VARIABLE: ['mod', 'mod'] }, inputs: { VALUE: [2, 'modReporter'] } },
        modReporter: { opcode: 'operator_mod', parent: 'setMod', inputs: { NUM1: [1, [4, '-1']], NUM2: [1, [4, '10']] } },
        setSum: { opcode: 'data_setvariableto', parent: 'setMod', fields: { VARIABLE: ['sum', 'sum'] }, inputs: { VALUE: [2, 'sumReporter'] } },
        sumReporter: { opcode: 'operator_add', parent: 'setSum', inputs: { NUM1: [1, [10, 'abc']], NUM2: [1, [4, '5']] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 4 }],
    expect: {
      targets: [{ name: 'Sprite1', variables: { joined: 'hello world', less: true, mod: 9, sum: 5 } }],
      exportedJsonContains: ['operator_join', 'operator_mod'],
    },
  },
  {
    id: 'sensing-key-mouse-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Keyboard hats and mouse reporters update project-visible variables.',
    spec: 'spec/runtime-semantics.md#events',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.keyHit = ['keyHit', 0]
      sprite.variables.mouseX = ['mouseX', 0]
      sprite.blocks = {
        keyHat: { opcode: 'event_whenkeypressed', next: 'setKey', topLevel: true, fields: { KEY_OPTION: ['space', 'space'] } },
        setKey: { opcode: 'data_setvariableto', parent: 'keyHat', next: 'setMouse', fields: { VARIABLE: ['keyHit', 'keyHit'] }, inputs: { VALUE: [1, [4, '1']] } },
        setMouse: { opcode: 'data_setvariableto', parent: 'setKey', fields: { VARIABLE: ['mouseX', 'mouseX'] }, inputs: { VALUE: [2, 'mouseReporter'] } },
        mouseReporter: { opcode: 'sensing_mousex', parent: 'setMouse' },
      }
    }),
    steps: [{ action: 'load' }, { action: 'postMouse', x: 42, y: -7 }, { action: 'postKeyboard', key: 'space', isDown: true }, { action: 'step', frames: 1 }],
    expect: {
      targets: [{ name: 'Sprite1', variables: { keyHit: '1', mouseX: 42 } }],
      events: ['PROJECT_LOADED'],
    },
  },
  {
    id: 'procedures-argument-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Custom procedure calls bind string-number arguments and update caller-visible variables.',
    spec: 'spec/runtime-semantics.md#procedures-and-extensions',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.total = ['total', 0]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'callAdd', topLevel: true },
        callAdd: {
          opcode: 'procedures_call',
          parent: 'flag',
          mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]' },
          inputs: { arg1: [1, [4, '5']] },
        },
        definition: { opcode: 'procedures_definition', next: 'changeTotal', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
        prototype: {
          opcode: 'procedures_prototype',
          parent: 'definition',
          shadow: true,
          mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]', warp: 'false' },
        },
        changeTotal: { opcode: 'data_changevariableby', parent: 'definition', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [2, 'amountReporter'] } },
        amountReporter: { opcode: 'argument_reporter_string_number', parent: 'changeTotal', fields: { VALUE: ['amount'] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 2 }],
    expect: {
      targets: [{ name: 'Sprite1', variables: { total: 5 } }],
      exportedJsonContains: ['procedures_call', 'argument_reporter_string_number'],
    },
  },
  {
    id: 'procedures-definition-argument-names-001',
    level: 2,
    kind: 'project',
    source: 'authored-clean-room',
    description: 'Custom procedure calls use prototype argument names when the call mutation only stores argument ids.',
    spec: 'spec/runtime-semantics.md#procedures-and-extensions',
    createProject: () => defaultProjectWith((project) => {
      const sprite = project.targets[1]!
      sprite.variables.total = ['total', 0]
      sprite.blocks = {
        flag: { opcode: 'event_whenflagclicked', next: 'callAdd', topLevel: true },
        callAdd: {
          opcode: 'procedures_call',
          parent: 'flag',
          mutation: { proccode: 'add %n', argumentids: '["input0"]' },
          inputs: { input0: [1, [4, '7']] },
        },
        definition: { opcode: 'procedures_definition', next: 'setTotal', topLevel: true, inputs: { custom_block: [1, 'prototype'] } },
        prototype: {
          opcode: 'procedures_prototype',
          parent: 'definition',
          shadow: true,
          mutation: { proccode: 'add %n', argumentids: '["input0"]', argumentnames: '["amount"]', argumentdefaults: '["1"]', warp: 'true' },
        },
        setTotal: { opcode: 'data_setvariableto', parent: 'definition', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [2, 'amountReporter'] } },
        amountReporter: { opcode: 'argument_reporter_string_number', parent: 'setTotal', fields: { VALUE: ['amount'] } },
      }
    }),
    steps: [{ action: 'load' }, { action: 'greenFlag' }, { action: 'step', frames: 1 }],
    expect: {
      targets: [{ name: 'Sprite1', variables: { total: '7' } }],
    },
  },
]
