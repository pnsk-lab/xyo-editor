export type ScratchLiteralCode = 4 | 9 | 10 | 11 | 12 | 13

export type BlockInputKind = 'value' | 'boolean' | 'statement' | 'field'

export interface ShadowInputSpec {
  type: string
  field: string
  value: string
  code: ScratchLiteralCode
}

export interface BlockInputSpec {
  kind: BlockInputKind
  check?: string
  shadow?: ShadowInputSpec
}

export type BlockInputSpecMap = Record<string, Record<string, BlockInputSpec>>

const number = (value: string | number): BlockInputSpec => ({
  kind: 'value',
  shadow: { type: 'math_number', field: 'NUM', value: String(value), code: 4 },
})

const text = (value: string): BlockInputSpec => ({
  kind: 'value',
  shadow: { type: 'text', field: 'TEXT', value, code: 10 },
})

const colour = (value: string): BlockInputSpec => ({
  kind: 'value',
  check: 'Colour',
  shadow: { type: 'colour_picker', field: 'COLOUR', value, code: 9 },
})

const penColour = (value: string): BlockInputSpec => ({
  kind: 'value',
  shadow: { type: 'colour_picker', field: 'COLOUR', value, code: 9 },
})

const menu = (type: string, field: string, value: string): BlockInputSpec => ({
  kind: 'value',
  shadow: { type, field, value, code: field === 'BROADCAST_OPTION' ? 11 : 10 },
})

const boolean = (): BlockInputSpec => ({ kind: 'boolean', check: 'Boolean' })
const field = (): BlockInputSpec => ({ kind: 'field' })

export const blockInputSpecs: BlockInputSpecMap = {
  event_whenkeypressed: { KEY_OPTION: field() },
  event_whentouchingobject: { TOUCHINGOBJECTMENU: menu('sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', '_mouse_') },
  event_whenbackdropswitchesto: { BACKDROP: field() },
  event_whengreaterthan: { WHENGREATERTHANMENU: field(), VALUE: number(10) },
  event_whenbroadcastreceived: { BROADCAST_OPTION: field() },
  event_broadcast: { BROADCAST_INPUT: menu('event_broadcast_menu', 'BROADCAST_OPTION', 'message1') },
  event_broadcastandwait: { BROADCAST_INPUT: menu('event_broadcast_menu', 'BROADCAST_OPTION', 'message1') },

  motion_movesteps: { STEPS: number(10) },
  motion_turnright: { DEGREES: number(15) },
  motion_turnleft: { DEGREES: number(15) },
  motion_pointindirection: { DIRECTION: number(90) },
  motion_pointtowards: { TOWARDS: menu('motion_pointtowards_menu', 'TOWARDS', '_mouse_') },
  motion_goto: { TO: menu('motion_goto_menu', 'TO', '_random_') },
  motion_gotoxy: { X: number(0), Y: number(0) },
  motion_glideto: { SECS: number(1), TO: menu('motion_glideto_menu', 'TO', '_random_') },
  motion_glidesecstoxy: { SECS: number(1), X: number(0), Y: number(0) },
  motion_changexby: { DX: number(10) },
  motion_changeyby: { DY: number(10) },
  motion_setx: { X: number(0) },
  motion_sety: { Y: number(0) },
  motion_setrotationstyle: { STYLE: field() },

  looks_say: { MESSAGE: text('Hello!') },
  looks_sayforsecs: { MESSAGE: text('Hello!'), SECS: number(2) },
  looks_think: { MESSAGE: text('Hmm...') },
  looks_thinkforsecs: { MESSAGE: text('Hmm...'), SECS: number(2) },
  looks_switchcostumeto: { COSTUME: menu('looks_costume', 'COSTUME', 'costume1') },
  looks_switchbackdropto: { BACKDROP: menu('looks_backdrops', 'BACKDROP', 'backdrop1') },
  looks_switchbackdroptoandwait: { BACKDROP: menu('looks_backdrops', 'BACKDROP', 'backdrop1') },
  looks_changeeffectby: { EFFECT: field(), CHANGE: number(25) },
  looks_seteffectto: { EFFECT: field(), VALUE: number(0) },
  looks_changesizeby: { CHANGE: number(10) },
  looks_setsizeto: { SIZE: number(100) },
  looks_costumenumbername: { NUMBER_NAME: field() },
  looks_backdropnumbername: { NUMBER_NAME: field() },
  looks_gotofrontback: { FRONT_BACK: field() },
  looks_goforwardbackwardlayers: { FORWARD_BACKWARD: field(), NUM: number(1) },

  sound_play: { SOUND_MENU: menu('sound_sounds_menu', 'SOUND_MENU', 'pop') },
  sound_playuntildone: { SOUND_MENU: menu('sound_sounds_menu', 'SOUND_MENU', 'pop') },
  sound_changeeffectby: { EFFECT: field(), VALUE: number(10) },
  sound_seteffectto: { EFFECT: field(), VALUE: number(0) },
  sound_changevolumeby: { VOLUME: number(-10) },
  sound_setvolumeto: { VOLUME: number(100) },
  sound_sounds_menu: { SOUND_MENU: field() },
  sound_beats_menu: { BEATS: number(1) },
  sound_effects_menu: { EFFECT: field() },

  control_wait: { DURATION: number(1) },
  control_wait_until: { CONDITION: boolean() },
  control_repeat: { TIMES: number(10), SUBSTACK: { kind: 'statement' } },
  control_repeat_until: { CONDITION: boolean(), SUBSTACK: { kind: 'statement' } },
  control_while: { CONDITION: boolean(), SUBSTACK: { kind: 'statement' } },
  control_for_each: { VARIABLE_NAME: field(), VALUE: number(10), SUBSTACK: { kind: 'statement' } },
  control_forever: { SUBSTACK: { kind: 'statement' } },
  control_if: { CONDITION: boolean(), SUBSTACK: { kind: 'statement' } },
  control_if_else: { CONDITION: boolean(), SUBSTACK: { kind: 'statement' }, SUBSTACK2: { kind: 'statement' } },
  control_stop: { STOP_OPTION: field() },
  control_create_clone_of: { CLONE_OPTION: menu('control_create_clone_of_menu', 'CLONE_OPTION', '_myself_') },

  sensing_askandwait: { QUESTION: text('What is your name?') },
  sensing_touchingobject: { TOUCHINGOBJECTMENU: menu('sensing_touchingobjectmenu', 'TOUCHINGOBJECTMENU', '_mouse_') },
  sensing_touchingcolor: { COLOR: colour('#4c97ff') },
  sensing_coloristouchingcolor: { COLOR: colour('#9966ff'), COLOR2: colour('#59c059') },
  sensing_distanceto: { DISTANCETOMENU: menu('sensing_distancetomenu', 'DISTANCETOMENU', '_mouse_') },
  sensing_keypressed: { KEY_OPTION: menu('sensing_keyoptions', 'KEY_OPTION', 'space') },
  sensing_setdragmode: { DRAG_MODE: field() },
  sensing_of: { PROPERTY: field(), OBJECT: field() },
  sensing_current: { CURRENTMENU: field() },

  operator_add: { NUM1: number(''), NUM2: number('') },
  operator_subtract: { NUM1: number(''), NUM2: number('') },
  operator_multiply: { NUM1: number(''), NUM2: number('') },
  operator_divide: { NUM1: number(''), NUM2: number('') },
  operator_random: { FROM: number(1), TO: number(10) },
  operator_equals: { OPERAND1: text(''), OPERAND2: text('50') },
  operator_gt: { OPERAND1: text(''), OPERAND2: text('50') },
  operator_lt: { OPERAND1: text(''), OPERAND2: text('50') },
  operator_and: { OPERAND1: boolean(), OPERAND2: boolean() },
  operator_or: { OPERAND1: boolean(), OPERAND2: boolean() },
  operator_not: { OPERAND: boolean() },
  operator_join: { STRING1: text('apple '), STRING2: text('banana') },
  operator_letter_of: { LETTER: number(1), STRING: text('apple') },
  operator_length: { STRING: text('apple') },
  operator_contains: { STRING1: text('apple'), STRING2: text('a') },
  operator_mod: { NUM1: number(''), NUM2: number('') },
  operator_round: { NUM: number('') },
  operator_mathop: { OPERATOR: field(), NUM: number('') },

  data_setvariableto: { VARIABLE_NAME: field(), VALUE: text('0') },
  data_changevariableby: { VARIABLE_NAME: field(), VALUE: number(1) },
  data_addtolist: { ITEM: text('thing'), LIST_NAME: field() },
  data_deleteoflist: { INDEX: text('1'), LIST_NAME: field() },
  data_insertatlist: { ITEM: text('thing'), INDEX: text('1'), LIST_NAME: field() },
  data_replaceitemoflist: { INDEX: text('1'), LIST_NAME: field(), ITEM: text('thing') },
  data_itemoflist: { INDEX: text('1'), LIST_NAME: field() },
  data_itemnumoflist: { ITEM: text('thing'), LIST_NAME: field() },
  data_listcontainsitem: { LIST_NAME: field(), ITEM: text('thing') },
  data_showlist: { LIST_NAME: field() },
  data_hidelist: { LIST_NAME: field() },

  pen_setPenColorToColor: { COLOR: penColour('#4c97ff') },
  pen_changePenColorParamBy: { COLOR_PARAM: text('color'), VALUE: number(10) },
  pen_setPenColorParamTo: { COLOR_PARAM: text('color'), VALUE: number(50) },
  pen_setPenHueToNumber: { HUE: number(0) },
  pen_changePenHueBy: { HUE: number(10) },
  pen_setPenShadeToNumber: { SHADE: number(50) },
  pen_changePenShadeBy: { SHADE: number(10) },
  pen_changePenSizeBy: { SIZE: number(1) },
  pen_setPenSizeTo: { SIZE: number(1) },
  boost_whenColor: { COLOR: colour('#ff0000') },
  boost_seeingColor: { COLOR: colour('#ff0000') },
}

export function blockInputSpec(opcode: string, inputName: string): BlockInputSpec | undefined {
  return blockInputSpecs[opcode]?.[inputName]
}

export function valueInputNames(opcode: string): string[] {
  return Object.entries(blockInputSpecs[opcode] ?? {})
    .filter(([, spec]) => spec.kind === 'value')
    .map(([name]) => name)
}

export function toolboxShadowInputsForOpcode(opcode: string): Record<string, { shadow: { type: string; fields?: Record<string, string> } }> {
  const inputs: Record<string, { shadow: { type: string; fields?: Record<string, string> } }> = {}
  for (const [name, spec] of Object.entries(blockInputSpecs[opcode] ?? {})) {
    if (spec.kind !== 'value' || !spec.shadow) continue
    inputs[name] = { shadow: { type: spec.shadow.type, fields: { [spec.shadow.field]: spec.shadow.value } } }
  }
  return inputs
}

export function scratchMenuShadowFieldName(type: string): string | undefined {
  const map: Record<string, string> = {
    event_broadcast_menu: 'BROADCAST_OPTION',
    motion_pointtowards_menu: 'TOWARDS',
    motion_goto_menu: 'TO',
    motion_glideto_menu: 'TO',
    looks_costume: 'COSTUME',
    looks_backdrops: 'BACKDROP',
    sound_sounds_menu: 'SOUND_MENU',
    control_create_clone_of_menu: 'CLONE_OPTION',
    sensing_touchingobjectmenu: 'TOUCHINGOBJECTMENU',
    sensing_distancetomenu: 'DISTANCETOMENU',
    sensing_keyoptions: 'KEY_OPTION',
  }
  return map[type]
}

export function literalShadowTypeForInput(opcode: string, inputName: string, code: unknown): string {
  const spec = blockInputSpec(opcode, inputName)
  if (code === 9 || spec?.shadow?.code === 9) return 'colour_picker'
  if (code === 11 || spec?.shadow?.code === 11) return 'event_broadcast_menu'
  if (code === 12) return 'data_variable'
  if (code === 13) return 'data_listcontents'
  if (code === 10) return spec?.shadow?.type ?? 'text'
  return spec?.shadow?.type ?? 'math_number'
}

export function literalCodeForInput(opcode: string, inputName: string): ScratchLiteralCode {
  return blockInputSpec(opcode, inputName)?.shadow?.code ?? 4
}
