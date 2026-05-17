import * as BlocklyModule from 'blockly/core'
import { blockPalette as moduleBlockPalette } from '@hikkaku/vm'
import type { ScratchBlock as ModuleScratchBlock, ScratchMonitor as ModuleScratchMonitor, ScratchTarget as ModuleScratchTarget } from '@hikkaku/vm'
import { blockInputSpec, literalCodeForInput, literalShadowTypeForInput, scratchMenuShadowFieldName, toolboxShadowInputsForOpcode, valueInputNames } from './block-input-specs'
import { extensionLibrary } from './editor-libraries'

let scratchBlocksRegistered = false
let variableMenuOptions: Array<[string, string]> = [['my variable', 'my variable']]
let listMenuOptions: Array<[string, string]> = [['list', 'list']]
let destinationMenuOptions: Array<[string, string]> = [['どこかの場所', '_random_'], ['マウスのポインター', '_mouse_']]
let pointTowardsMenuOptions: Array<[string, string]> = [['マウスのポインター', '_mouse_']]
let touchingObjectMenuOptions: Array<[string, string]> = [['マウスのポインター', '_mouse_'], ['端', '_edge_']]
let cloneTargetMenuOptions: Array<[string, string]> = [['自分自身', '_myself_']]
let broadcastMenuOptions: Array<[string, string]> = [['message1', 'message1'], ['新しいメッセージ', '__new_broadcast__']]
let backdropMenuOptions: Array<[string, string]> = [['backdrop1', 'backdrop1']]
let backdropChoiceMenuOptions: Array<[string, string]> = [['backdrop1', 'backdrop1'], ['次の背景', 'next backdrop'], ['前の背景', 'previous backdrop'], ['どれかの背景', 'random backdrop']]
let costumeMenuOptions: Array<[string, string]> = [['costume1', 'costume1']]
let costumeChoiceMenuOptions: Array<[string, string]> = [['costume1', 'costume1'], ['次のコスチューム', 'next costume'], ['前のコスチューム', 'previous costume'], ['どれかのコスチューム', 'random costume']]
let soundMenuOptions: Array<[string, string]> = [['pop', 'pop']]
let sensingObjectMenuOptions: Array<[string, string]> = [['ステージ', '_stage_']]

const dataVariableColour = '#ff8c1a'
const dataListColour = '#ff661a'

class ScratchDataDropdown extends BlocklyModule.FieldDropdown {
  private readonly optionKind: 'variable' | 'list'

  constructor(optionKind: 'variable' | 'list', value?: string) {
    super(() => optionKind === 'variable' ? variableMenuOptions : listMenuOptions)
    this.optionKind = optionKind
    if (value) this.setValue(value)
  }

  static fromJson(options: BlocklyModule.FieldConfig) {
    const config = options as BlocklyModule.FieldConfig & { kind?: 'variable' | 'list'; text?: string; value?: string }
    return new ScratchDataDropdown(config.kind ?? 'variable', config.value ?? config.text)
  }

  doClassValidation_(newValue: unknown) {
    return typeof newValue === 'string' && newValue.length > 0 ? newValue : null
  }

  getOptions(useCache?: boolean): ReturnType<BlocklyModule.FieldDropdown['getOptions']> {
    const options = super.getOptions(useCache) as Array<[unknown, string]>
    const value = String(this.getValue() ?? '')
    if (!value || options.some(([, optionValue]) => optionValue === value)) return options as ReturnType<BlocklyModule.FieldDropdown['getOptions']>
    return [[value, value], ...options] as ReturnType<BlocklyModule.FieldDropdown['getOptions']>
  }
}

type ScratchMenuKind = 'destination' | 'towards' | 'touchingObject' | 'cloneTarget' | 'broadcast' | 'backdrop' | 'backdropChoice' | 'costume' | 'costumeChoice' | 'sound' | 'sensingObject'

class ScratchMenuDropdown extends BlocklyModule.FieldDropdown {
  constructor(private readonly menuKind: ScratchMenuKind, value?: string) {
    super(() => scratchMenuOptions(menuKind))
    if (value) this.setValue(initialScratchMenuValue(menuKind, value))
  }

  static fromJson(options: BlocklyModule.FieldConfig) {
    const config = options as BlocklyModule.FieldConfig & { kind?: ScratchMenuKind; text?: string; value?: string }
    return new ScratchMenuDropdown(config.kind ?? 'destination', config.value ?? config.text)
  }

  doClassValidation_(newValue: unknown) {
    return typeof newValue === 'string' && newValue.length > 0 ? newValue : null
  }

  doValueUpdate_(newValue: string) {
    if (this.menuKind === 'broadcast' && newValue === '__new_broadcast__' && typeof window !== 'undefined') {
      const name = window.prompt('新しいメッセージ', 'message1')?.trim()
      if (name) {
        broadcastMenuOptions = insertMenuOption(broadcastMenuOptions, name)
        super.doValueUpdate_(name)
        return
      }
    }
    super.doValueUpdate_(newValue)
  }

  getOptions(useCache?: boolean): ReturnType<BlocklyModule.FieldDropdown['getOptions']> {
    const options = super.getOptions(useCache) as Array<[unknown, string]>
    const value = String(this.getValue() ?? '')
    if (!value || options.some(([, optionValue]) => optionValue === value)) return options as ReturnType<BlocklyModule.FieldDropdown['getOptions']>
    return [[value, value], ...options] as ReturnType<BlocklyModule.FieldDropdown['getOptions']>
  }
}

class ScratchColourField extends BlocklyModule.FieldTextInput {
  constructor(value = '#000000') {
    super(normalizeScratchColour(value) ?? '#000000')
  }

  static fromJson(options: BlocklyModule.FieldConfig) {
    const config = options as BlocklyModule.FieldConfig & { text?: string; value?: string; colour?: string }
    return new ScratchColourField(config.value ?? config.text ?? config.colour)
  }

  initView() {
    super.initView()
    this.paintSwatch()
  }

  protected doClassValidation_(newValue?: unknown) {
    return normalizeScratchColour(newValue)
  }

  protected doValueUpdate_(newValue: string) {
    super.doValueUpdate_(newValue)
    this.paintSwatch()
  }

  protected getDisplayText_() {
    return '      '
  }

  protected render_() {
    super.render_()
    this.paintSwatch()
  }

  protected showEditor_() {
    const block = this.getSourceBlock()
    if (!block?.isEditable()) return
    BlocklyModule.DropDownDiv.clearContent()
    BlocklyModule.DropDownDiv.setColour('#ffffff', '#111827')
    const content = BlocklyModule.DropDownDiv.getContentDiv()
    content.appendChild(this.pickerDom())
    BlocklyModule.DropDownDiv.showPositionedByField(this as BlocklyModule.Field<string>)
  }

  applyColour() {
    super.applyColour()
    this.paintSwatch()
  }

  private paintSwatch() {
    try {
      const color = String(this.getValue())
      const border = this.getBorderRect()
      border.setAttribute('fill', color)
      border.setAttribute('stroke', '#ffffff')
      border.setAttribute('stroke-width', '2')
      border.setAttribute('rx', '12')
      border.setAttribute('ry', '12')
      this.getTextElement().setAttribute('fill', 'transparent')
      if (this.getSourceBlock()?.type === 'colour_picker') {
        const blockPath = (this.getSourceBlock() as BlocklyModule.BlockSvg | null)?.getSvgRoot()?.querySelector<SVGPathElement>('.blocklyPath')
        blockPath?.setAttribute('fill', color)
        blockPath?.setAttribute('stroke', '#ffffff')
        blockPath?.setAttribute('stroke-width', '2')
      }
    } catch {
      // The SVG nodes are not available until Blockly attaches the field.
    }
  }

  private pickerDom() {
    const wrapper = document.createElement('div')
    wrapper.className = 'hikkaku-colour-popover'
    const style = document.createElement('style')
    style.textContent = `
      .hikkaku-colour-popover {
        box-sizing: border-box;
        width: 190px;
        padding: 12px 12px 10px;
        color: #4b5563;
        font: 600 12px/1.2 "Helvetica Neue", Helvetica, Arial, sans-serif;
        background: #fff;
      }
      .hikkaku-colour-row { margin-bottom: 16px; }
      .hikkaku-colour-label { display: flex; gap: 10px; align-items: baseline; margin-bottom: 8px; }
      .hikkaku-colour-value { color: #6b7280; font-weight: 500; }
      .hikkaku-colour-slider {
        appearance: none;
        width: 100%;
        height: 24px;
        margin: 0;
        border: 0;
        border-radius: 999px;
        outline: none;
        cursor: pointer;
      }
      .hikkaku-colour-slider::-webkit-slider-thumb {
        appearance: none;
        width: 30px;
        height: 30px;
        border: 4px solid #fff;
        border-radius: 999px;
        background: transparent;
        box-shadow: 0 0 0 4px rgb(0 0 0 / 0.14);
      }
      .hikkaku-colour-slider::-moz-range-thumb {
        width: 22px;
        height: 22px;
        border: 4px solid #fff;
        border-radius: 999px;
        background: transparent;
        box-shadow: 0 0 0 4px rgb(0 0 0 / 0.14);
      }
      .hikkaku-colour-divider { height: 1px; margin: 2px -6px 8px; background: #e5e7eb; }
      .hikkaku-colour-eyedropper {
        display: flex;
        width: 32px;
        height: 26px;
        margin: 0 auto;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 4px;
        color: #5b6478;
        background: transparent;
        cursor: default;
      }
      .hikkaku-colour-eyedropper svg { width: 21px; height: 21px; }
    `
    wrapper.appendChild(style)

    const field = this
    const hsv = rgbToHsv(hexToRgb(String(this.getValue())))
    const hue = this.slider('色', hsv.h, () => hueBackground(), (value) => {
      hsv.h = value
      sync()
    })
    const saturation = this.slider('鮮やかさ', hsv.s, () => saturationBackground(hsv.h, hsv.v), (value) => {
      hsv.s = value
      sync()
    })
    const value = this.slider('明るさ', hsv.v, () => valueBackground(hsv.h, hsv.s), (nextValue) => {
      hsv.v = nextValue
      sync()
    })
    wrapper.append(hue.row, saturation.row, value.row)

    const divider = document.createElement('div')
    divider.className = 'hikkaku-colour-divider'
    const eyedropper = document.createElement('button')
    eyedropper.type = 'button'
    eyedropper.className = 'hikkaku-colour-eyedropper'
    eyedropper.title = '色を選ぶ'
    eyedropper.ariaLabel = '色を選ぶ'
    eyedropper.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 4.1 19.9 9.3 9 20.2H4.1V15.3L15 4.4c-.1-.1-.2-.2-.3-.3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.2 5.8 18.2 10.8M7 15l2 2M4.1 20.2h7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>'
    wrapper.append(divider, eyedropper)
    sync()
    return wrapper

    function sync() {
      const color = rgbToHex(hsvToRgb(hsv))
      hue.input.value = String(Math.round(hsv.h))
      saturation.input.value = String(Math.round(hsv.s))
      value.input.value = String(Math.round(hsv.v))
      hue.value.textContent = String(Math.round(hsv.h))
      saturation.value.textContent = String(Math.round(hsv.s))
      value.value.textContent = String(Math.round(hsv.v))
      hue.input.style.background = hue.background()
      saturation.input.style.background = saturation.background()
      value.input.style.background = value.background()
      field.setValue(color)
    }
  }

  private slider(labelText: string, initialValue: number, background: () => string, onInput: (value: number) => void) {
    const row = document.createElement('label')
    row.className = 'hikkaku-colour-row'
    const label = document.createElement('span')
    label.className = 'hikkaku-colour-label'
    const labelName = document.createElement('span')
    labelName.textContent = labelText
    const value = document.createElement('span')
    value.className = 'hikkaku-colour-value'
    value.textContent = String(Math.round(initialValue))
    label.append(labelName, value)
    const input = document.createElement('input')
    input.className = 'hikkaku-colour-slider'
    input.type = 'range'
    input.min = '0'
    input.max = '100'
    input.step = '1'
    input.value = String(Math.round(initialValue))
    input.style.background = background()
    input.addEventListener('input', () => onInput(Number(input.value)))
    row.append(label, input)
    return { row, input, value, background }
  }
}

function normalizeScratchColour(value: unknown): string | null {
  const text = String(value ?? '').trim()
  const shortHex = /^#?([0-9a-fA-F]{3})$/.exec(text)
  if (shortHex) {
    const [r, g, b] = shortHex[1]!.split('')
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase()
  }
  const longHex = /^#?([0-9a-fA-F]{6})$/.exec(text)
  return longHex ? `#${longHex[1]}`.toLowerCase() : null
}

type ScratchRgb = { r: number; g: number; b: number }
type ScratchHsv = { h: number; s: number; v: number }

function hueBackground() {
  return 'linear-gradient(90deg, #e07171 0%, #d9d87a 17%, #80d98a 33%, #83dada 50%, #8587db 67%, #d582d6 83%, #d77696 100%)'
}

function saturationBackground(h: number, v: number) {
  const muted = rgbToHex(hsvToRgb({ h, s: 0, v }))
  const vivid = rgbToHex(hsvToRgb({ h, s: 100, v }))
  return `linear-gradient(90deg, ${muted}, ${vivid})`
}

function valueBackground(h: number, s: number) {
  const bright = rgbToHex(hsvToRgb({ h, s, v: 100 }))
  return `linear-gradient(90deg, #000000, ${bright})`
}

function hexToRgb(hex: string): ScratchRgb {
  const normalized = normalizeScratchColour(hex) ?? '#000000'
  const value = Number.parseInt(normalized.slice(1), 16)
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  }
}

function rgbToHex(rgb: ScratchRgb) {
  const r = clampByte(rgb.r).toString(16).padStart(2, '0')
  const g = clampByte(rgb.g).toString(16).padStart(2, '0')
  const b = clampByte(rgb.b).toString(16).padStart(2, '0')
  return `#${r}${g}${b}`
}

function rgbToHsv(rgb: ScratchRgb): ScratchHsv {
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  let hue = 0
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue *= 60
    if (hue < 0) hue += 360
  }
  return {
    h: hue / 3.6,
    s: max === 0 ? 0 : (delta / max) * 100,
    v: max * 100,
  }
}

function hsvToRgb(hsv: ScratchHsv): ScratchRgb {
  const h = (((hsv.h % 100) + 100) % 100) * 3.6
  const s = Math.max(0, Math.min(100, hsv.s)) / 100
  const v = Math.max(0, Math.min(100, hsv.v)) / 100
  const chroma = v * s
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - chroma
  const [r1, g1, b1] = h < 60
    ? [chroma, x, 0]
    : h < 120
      ? [x, chroma, 0]
      : h < 180
        ? [0, chroma, x]
        : h < 240
          ? [0, x, chroma]
          : h < 300
            ? [x, 0, chroma]
            : [chroma, 0, x]
  return {
    r: (r1 + m) * 255,
    g: (g1 + m) * 255,
    b: (b1 + m) * 255,
  }
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function scratchMenuOptions(kind: ScratchMenuKind) {
  if (kind === 'towards') return pointTowardsMenuOptions
  if (kind === 'touchingObject') return touchingObjectMenuOptions
  if (kind === 'cloneTarget') return cloneTargetMenuOptions
  if (kind === 'broadcast') return broadcastMenuOptions
  if (kind === 'backdrop') return backdropMenuOptions
  if (kind === 'backdropChoice') return backdropChoiceMenuOptions
  if (kind === 'costume') return costumeMenuOptions
  if (kind === 'costumeChoice') return costumeChoiceMenuOptions
  if (kind === 'sound') return soundMenuOptions
  if (kind === 'sensingObject') return sensingObjectMenuOptions
  return destinationMenuOptions
}

function initialScratchMenuValue(kind: ScratchMenuKind, value: string) {
  const options = scratchMenuOptions(kind)
  if (options.some(([, optionValue]) => optionValue === value)) return value
  if ((kind === 'sound' && value === 'pop') || ((kind === 'costume' || kind === 'costumeChoice') && value === 'costume1') || ((kind === 'backdrop' || kind === 'backdropChoice') && value === 'backdrop1')) {
    return options[0]?.[1] ?? value
  }
  return value
}

function insertMenuOption(options: Array<[string, string]>, value: string) {
  if (options.some(([, optionValue]) => optionValue === value)) return options
  const withoutNew = options.filter(([, optionValue]) => optionValue !== '__new_broadcast__')
  return [...withoutNew, [value, value] as [string, string], ...options.filter(([, optionValue]) => optionValue === '__new_broadcast__')]
}

const blockDefinitions = [
  { type: 'colour_picker', message0: '%1', args0: [{ type: 'field_scratch_colour', name: 'COLOUR', value: '#000000' }], output: 'Colour', colour: '#5cb1d6' },
  { type: 'event_whenflagclicked', message0: 'when green flag clicked', colour: '#ffbf00', nextStatement: null },
  { type: 'event_whenkeypressed', message0: 'when %1 key pressed', args0: [{ type: 'field_input', name: 'KEY_OPTION', text: 'space' }], colour: '#ffbf00', nextStatement: null },
  { type: 'event_whenthisspriteclicked', message0: 'when this sprite clicked', colour: '#ffbf00', nextStatement: null },
  { type: 'event_whentouchingobject', message0: 'when touching %1', args0: [{ type: 'input_value', name: 'TOUCHINGOBJECTMENU' }], colour: '#ffbf00', nextStatement: null },
  { type: 'event_whenbackdropswitchesto', message0: 'when backdrop switches to %1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'BACKDROP', kind: 'backdrop', value: 'backdrop1' }], colour: '#ffbf00', nextStatement: null },
  { type: 'event_whengreaterthan', message0: 'when %1 > %2', args0: [{ type: 'field_dropdown', name: 'WHENGREATERTHANMENU', options: [['loudness', 'LOUDNESS'], ['timer', 'TIMER']] }, { type: 'field_number', name: 'VALUE', value: 10 }], colour: '#ffbf00', nextStatement: null },
  { type: 'event_whenbroadcastreceived', message0: 'when I receive %1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'BROADCAST_OPTION', kind: 'broadcast', value: 'message1' }], colour: '#ffbf00', nextStatement: null },
  { type: 'event_broadcast', message0: 'broadcast %1', args0: [{ type: 'input_value', name: 'BROADCAST_INPUT' }], colour: '#ffbf00', previousStatement: null, nextStatement: null },
  { type: 'event_broadcastandwait', message0: 'broadcast %1 and wait', args0: [{ type: 'input_value', name: 'BROADCAST_INPUT' }], colour: '#ffbf00', previousStatement: null, nextStatement: null },
  { type: 'event_broadcast_menu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'BROADCAST_OPTION', kind: 'broadcast', value: 'message1' }], output: 'String', colour: '#ffbf00' },
  { type: 'motion_movesteps', message0: '%1 歩動かす', args0: [{ type: 'field_number', name: 'STEPS', value: 10 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_turnright', message0: '↻ %1 度回す', args0: [{ type: 'field_number', name: 'DEGREES', value: 15 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_turnleft', message0: '↺ %1 度回す', args0: [{ type: 'field_number', name: 'DEGREES', value: 15 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_pointindirection', message0: '%1 度に向ける', args0: [{ type: 'field_number', name: 'DIRECTION', value: 90 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_pointtowards', message0: '%1 へ向ける', args0: [{ type: 'input_value', name: 'TOWARDS' }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_pointtowards_menu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'TOWARDS', kind: 'towards', value: '_mouse_' }], output: 'String', colour: '#4c97ff' },
  { type: 'motion_goto', message0: '%1 へ行く', args0: [{ type: 'input_value', name: 'TO' }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_goto_menu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'TO', kind: 'destination', value: '_random_' }], output: 'String', colour: '#4c97ff' },
  { type: 'motion_glideto_menu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'TO', kind: 'destination', value: '_random_' }], output: 'String', colour: '#4c97ff' },
  { type: 'motion_gotoxy', message0: 'x座標を %1、y座標を %2 にする', args0: [{ type: 'field_number', name: 'X', value: 0 }, { type: 'field_number', name: 'Y', value: 0 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_glideto', message0: '%1 秒で %2 へ行く', args0: [{ type: 'field_number', name: 'SECS', value: 1, min: 0 }, { type: 'input_value', name: 'TO' }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_glidesecstoxy', message0: '%1 秒でx座標を %2 に、y座標を %3 に変える', args0: [{ type: 'field_number', name: 'SECS', value: 1, min: 0 }, { type: 'field_number', name: 'X', value: 0 }, { type: 'field_number', name: 'Y', value: 0 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_changexby', message0: 'x座標を %1 ずつ変える', args0: [{ type: 'field_number', name: 'DX', value: 10 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_changeyby', message0: 'y座標を %1 ずつ変える', args0: [{ type: 'field_number', name: 'DY', value: 10 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_setx', message0: 'x座標を %1 にする', args0: [{ type: 'field_number', name: 'X', value: 0 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_sety', message0: 'y座標を %1 にする', args0: [{ type: 'field_number', name: 'Y', value: 0 }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_ifonedgebounce', message0: 'もし端に着いたら、跳ね返る', colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_setrotationstyle', message0: '回転方法を %1 にする', args0: [{ type: 'field_dropdown', name: 'STYLE', options: [['左右のみ', 'left-right'], ['自由に回転', 'all around'], ['回転しない', "don't rotate"]] }], colour: '#4c97ff', previousStatement: null, nextStatement: null },
  { type: 'motion_xposition', message0: 'x座標', output: 'Number', colour: '#4c97ff' },
  { type: 'motion_yposition', message0: 'y座標', output: 'Number', colour: '#4c97ff' },
  { type: 'motion_direction', message0: '向き', output: 'Number', colour: '#4c97ff' },
  { type: 'looks_say', message0: 'say %1', args0: [{ type: 'field_input', name: 'MESSAGE', text: 'Hello!' }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_sayforsecs', message0: 'say %1 for %2 seconds', args0: [{ type: 'field_input', name: 'MESSAGE', text: 'Hello!' }, { type: 'field_number', name: 'SECS', value: 2, min: 0 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_think', message0: 'think %1', args0: [{ type: 'field_input', name: 'MESSAGE', text: 'Hmm...' }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_thinkforsecs', message0: 'think %1 for %2 seconds', args0: [{ type: 'field_input', name: 'MESSAGE', text: 'Hmm...' }, { type: 'field_number', name: 'SECS', value: 2, min: 0 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_show', message0: 'show', colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_hide', message0: 'hide', colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_nextcostume', message0: 'next costume', colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_switchcostumeto', message0: 'switch costume to %1', args0: [{ type: 'input_value', name: 'COSTUME' }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_switchbackdropto', message0: 'switch backdrop to %1', args0: [{ type: 'input_value', name: 'BACKDROP' }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_switchbackdroptoandwait', message0: 'switch backdrop to %1 and wait', args0: [{ type: 'input_value', name: 'BACKDROP' }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_nextbackdrop', message0: 'next backdrop', colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_changeeffectby', message0: 'change %1 effect by %2', args0: [{ type: 'field_dropdown', name: 'EFFECT', options: [['color', 'color'], ['fisheye', 'fisheye'], ['whirl', 'whirl'], ['pixelate', 'pixelate'], ['mosaic', 'mosaic'], ['brightness', 'brightness'], ['ghost', 'ghost']] }, { type: 'field_number', name: 'CHANGE', value: 25 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_seteffectto', message0: 'set %1 effect to %2', args0: [{ type: 'field_dropdown', name: 'EFFECT', options: [['color', 'color'], ['fisheye', 'fisheye'], ['whirl', 'whirl'], ['pixelate', 'pixelate'], ['mosaic', 'mosaic'], ['brightness', 'brightness'], ['ghost', 'ghost']] }, { type: 'field_number', name: 'VALUE', value: 0 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_cleargraphiceffects', message0: 'clear graphic effects', colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_changesizeby', message0: 'change size by %1', args0: [{ type: 'field_number', name: 'CHANGE', value: 10 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_setsizeto', message0: 'set size to %1%', args0: [{ type: 'field_number', name: 'SIZE', value: 100 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_size', message0: 'size', output: 'Number', colour: '#9966ff' },
  { type: 'looks_costumenumbername', message0: 'costume %1', args0: [{ type: 'field_dropdown', name: 'NUMBER_NAME', options: [['number', 'number'], ['name', 'name']] }], output: null, colour: '#9966ff' },
  { type: 'looks_backdropnumbername', message0: 'backdrop %1', args0: [{ type: 'field_dropdown', name: 'NUMBER_NAME', options: [['number', 'number'], ['name', 'name']] }], output: null, colour: '#9966ff' },
  { type: 'looks_costume', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'COSTUME', kind: 'costumeChoice', value: 'costume1' }], output: 'String', colour: '#9966ff' },
  { type: 'looks_backdrops', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'BACKDROP', kind: 'backdropChoice', value: 'backdrop1' }], output: 'String', colour: '#9966ff' },
  { type: 'looks_gotofrontback', message0: 'go to %1 layer', args0: [{ type: 'field_dropdown', name: 'FRONT_BACK', options: [['front', 'front'], ['back', 'back']] }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'looks_goforwardbackwardlayers', message0: 'go %1 %2 layers', args0: [{ type: 'field_dropdown', name: 'FORWARD_BACKWARD', options: [['forward', 'forward'], ['backward', 'backward']] }, { type: 'field_number', name: 'NUM', value: 1, min: 0 }], colour: '#9966ff', previousStatement: null, nextStatement: null },
  { type: 'sound_play', message0: 'start sound %1', args0: [{ type: 'input_value', name: 'SOUND_MENU' }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_playuntildone', message0: 'play sound %1 until done', args0: [{ type: 'input_value', name: 'SOUND_MENU' }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_stopallsounds', message0: 'stop all sounds', colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_changeeffectby', message0: 'change %1 effect by %2', args0: [{ type: 'field_dropdown', name: 'EFFECT', options: [['pitch', 'PITCH'], ['pan left/right', 'PAN']] }, { type: 'field_number', name: 'VALUE', value: 10 }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_seteffectto', message0: 'set %1 effect to %2', args0: [{ type: 'field_dropdown', name: 'EFFECT', options: [['pitch', 'PITCH'], ['pan left/right', 'PAN']] }, { type: 'field_number', name: 'VALUE', value: 0 }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_cleareffects', message0: 'clear sound effects', colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_changevolumeby', message0: 'change volume by %1', args0: [{ type: 'field_number', name: 'VOLUME', value: -10 }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_setvolumeto', message0: 'set volume to %1%', args0: [{ type: 'field_number', name: 'VOLUME', value: 100 }], colour: '#cf63cf', previousStatement: null, nextStatement: null },
  { type: 'sound_volume', message0: 'volume', output: 'Number', colour: '#cf63cf' },
  { type: 'sound_sounds_menu', message0: 'sound %1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'SOUND_MENU', kind: 'sound', value: 'pop' }], output: 'String', colour: '#cf63cf' },
  { type: 'sound_beats_menu', message0: 'beats %1', args0: [{ type: 'field_number', name: 'BEATS', value: 1 }], output: 'Number', colour: '#cf63cf' },
  { type: 'sound_effects_menu', message0: 'effect %1', args0: [{ type: 'field_dropdown', name: 'EFFECT', options: [['pitch', 'PITCH'], ['pan left/right', 'PAN']] }], output: 'String', colour: '#cf63cf' },
  { type: 'control_wait', message0: 'wait %1 seconds', args0: [{ type: 'field_number', name: 'DURATION', value: 1, min: 0 }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_wait_until', message0: 'wait until %1', args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_repeat', message0: 'repeat %1 %2 %3', args0: [{ type: 'field_number', name: 'TIMES', value: 10, min: 0 }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_repeat_until', message0: 'repeat until %1 %2 %3', args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_while', message0: 'while %1 %2 %3', args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_for_each', message0: 'for %1 from 1 to %2 %3 %4', args0: [{ type: 'field_input', name: 'VARIABLE_NAME', text: 'i' }, { type: 'field_number', name: 'VALUE', value: 10, min: 0 }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_forever', message0: 'forever %1 %2', args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null },
  { type: 'control_if', message0: 'if %1 then %2 %3', args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_if_else', message0: 'if %1 then %2 %3 else %4 %5', args0: [{ type: 'input_value', name: 'CONDITION', check: 'Boolean' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }, { type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK2' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_stop', message0: 'stop %1', args0: [{ type: 'field_dropdown', name: 'STOP_OPTION', options: [['all', 'all'], ['this script', 'this script'], ['other scripts in sprite', 'other scripts in sprite']] }], colour: '#ffab19', previousStatement: null },
  { type: 'control_start_as_clone', message0: 'when I start as a clone', colour: '#ffab19', nextStatement: null },
  { type: 'control_create_clone_of', message0: 'create clone of %1', args0: [{ type: 'input_value', name: 'CLONE_OPTION' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_create_clone_of_menu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'CLONE_OPTION', kind: 'cloneTarget', value: '_myself_' }], output: 'String', colour: '#ffab19' },
  { type: 'control_delete_this_clone', message0: 'delete this clone', colour: '#ffab19', previousStatement: null },
  { type: 'control_get_counter', message0: 'counter', output: 'Number', colour: '#ffab19' },
  { type: 'control_incr_counter', message0: 'increment counter', colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_clear_counter', message0: 'clear counter', colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'control_all_at_once', message0: 'all at once %1 %2', args0: [{ type: 'input_dummy' }, { type: 'input_statement', name: 'SUBSTACK' }], colour: '#ffab19', previousStatement: null, nextStatement: null },
  { type: 'sensing_askandwait', message0: 'ask %1 and wait', args0: [{ type: 'field_input', name: 'QUESTION', text: 'What is your name?' }], colour: '#5cb1d6', previousStatement: null, nextStatement: null },
  { type: 'sensing_touchingobject', message0: 'touching %1?', args0: [{ type: 'input_value', name: 'TOUCHINGOBJECTMENU' }], output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_touchingobjectmenu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'TOUCHINGOBJECTMENU', kind: 'touchingObject', value: '_mouse_' }], output: 'String', colour: '#5cb1d6' },
  { type: 'sensing_touchingcolor', message0: '%1 色に触れた', args0: [{ type: 'input_value', name: 'COLOR', check: 'Colour' }], output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_coloristouchingcolor', message0: '%1 色が %2 に触れた', args0: [{ type: 'input_value', name: 'COLOR', check: 'Colour' }, { type: 'input_value', name: 'COLOR2', check: 'Colour' }], output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_distanceto', message0: 'distance to %1', args0: [{ type: 'input_value', name: 'DISTANCETOMENU' }], output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_distancetomenu', message0: '%1', args0: [{ type: 'field_scratch_menu_dropdown', name: 'DISTANCETOMENU', kind: 'towards', value: '_mouse_' }], output: 'String', colour: '#5cb1d6' },
  { type: 'sensing_keypressed', message0: 'key %1 pressed?', args0: [{ type: 'field_input', name: 'KEY_OPTION', text: 'space' }], output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_keyoptions', message0: '%1', args0: [{ type: 'field_dropdown', name: 'KEY_OPTION', options: [['space', 'space'], ['up arrow', 'up arrow'], ['down arrow', 'down arrow'], ['right arrow', 'right arrow'], ['left arrow', 'left arrow'], ['any', 'any'], ['a', 'a'], ['b', 'b'], ['c', 'c']] }], output: 'String', colour: '#5cb1d6' },
  { type: 'sensing_mousedown', message0: 'mouse down?', output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_mousex', message0: 'mouse x', output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_mousey', message0: 'mouse y', output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_setdragmode', message0: 'set drag mode %1', args0: [{ type: 'field_dropdown', name: 'DRAG_MODE', options: [['draggable', 'draggable'], ['not draggable', 'not draggable']] }], colour: '#5cb1d6', previousStatement: null, nextStatement: null },
  { type: 'sensing_loudness', message0: 'loudness', output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_loud', message0: 'loud?', output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_of', message0: '%1 of %2', args0: [{ type: 'field_dropdown', name: 'PROPERTY', options: [['x position', 'x position'], ['y position', 'y position'], ['direction', 'direction'], ['costume #', 'costume #'], ['costume name', 'costume name'], ['size', 'size'], ['volume', 'volume'], ['backdrop #', 'backdrop #'], ['backdrop name', 'backdrop name']] }, { type: 'field_scratch_menu_dropdown', name: 'OBJECT', kind: 'sensingObject', value: '_stage_' }], output: null, colour: '#5cb1d6' },
  { type: 'sensing_answer', message0: 'answer', output: 'String', colour: '#5cb1d6' },
  { type: 'sensing_timer', message0: 'timer', output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_resettimer', message0: 'reset timer', colour: '#5cb1d6', previousStatement: null, nextStatement: null },
  { type: 'sensing_current', message0: 'current %1', args0: [{ type: 'field_dropdown', name: 'CURRENTMENU', options: [['year', 'YEAR'], ['month', 'MONTH'], ['date', 'DATE'], ['day of week', 'DAYOFWEEK'], ['hour', 'HOUR'], ['minute', 'MINUTE'], ['second', 'SECOND']] }], output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_dayssince2000', message0: 'days since 2000', output: 'Number', colour: '#5cb1d6' },
  { type: 'sensing_online', message0: 'online?', output: 'Boolean', colour: '#5cb1d6' },
  { type: 'sensing_username', message0: 'username', output: 'String', colour: '#5cb1d6' },
  { type: 'operator_add', message0: '%1 + %2', args0: [{ type: 'input_value', name: 'NUM1' }, { type: 'input_value', name: 'NUM2' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_subtract', message0: '%1 - %2', args0: [{ type: 'input_value', name: 'NUM1' }, { type: 'input_value', name: 'NUM2' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_multiply', message0: '%1 * %2', args0: [{ type: 'input_value', name: 'NUM1' }, { type: 'input_value', name: 'NUM2' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_divide', message0: '%1 / %2', args0: [{ type: 'input_value', name: 'NUM1' }, { type: 'input_value', name: 'NUM2' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_random', message0: 'pick random %1 to %2', args0: [{ type: 'input_value', name: 'FROM' }, { type: 'input_value', name: 'TO' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_equals', message0: '%1 = %2', args0: [{ type: 'input_value', name: 'OPERAND1' }, { type: 'input_value', name: 'OPERAND2' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_gt', message0: '%1 > %2', args0: [{ type: 'input_value', name: 'OPERAND1' }, { type: 'input_value', name: 'OPERAND2' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_lt', message0: '%1 < %2', args0: [{ type: 'input_value', name: 'OPERAND1' }, { type: 'input_value', name: 'OPERAND2' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_and', message0: '%1 and %2', args0: [{ type: 'input_value', name: 'OPERAND1', check: 'Boolean' }, { type: 'input_value', name: 'OPERAND2', check: 'Boolean' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_or', message0: '%1 or %2', args0: [{ type: 'input_value', name: 'OPERAND1', check: 'Boolean' }, { type: 'input_value', name: 'OPERAND2', check: 'Boolean' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_not', message0: 'not %1', args0: [{ type: 'input_value', name: 'OPERAND', check: 'Boolean' }], output: 'Boolean', colour: '#59c059' },
  { type: 'operator_join', message0: 'join %1 %2', args0: [{ type: 'input_value', name: 'STRING1' }, { type: 'input_value', name: 'STRING2' }], output: 'String', colour: '#59c059', inputsInline: true },
  { type: 'operator_letter_of', message0: 'letter %1 of %2', args0: [{ type: 'input_value', name: 'LETTER' }, { type: 'input_value', name: 'STRING' }], output: 'String', colour: '#59c059', inputsInline: true },
  { type: 'operator_length', message0: 'length of %1', args0: [{ type: 'input_value', name: 'STRING' }], output: 'Number', colour: '#59c059' },
  { type: 'operator_contains', message0: '%1 contains %2?', args0: [{ type: 'input_value', name: 'STRING1' }, { type: 'input_value', name: 'STRING2' }], output: 'Boolean', colour: '#59c059', inputsInline: true },
  { type: 'operator_mod', message0: '%1 mod %2', args0: [{ type: 'input_value', name: 'NUM1' }, { type: 'input_value', name: 'NUM2' }], output: 'Number', colour: '#59c059', inputsInline: true },
  { type: 'operator_round', message0: 'round %1', args0: [{ type: 'input_value', name: 'NUM' }], output: 'Number', colour: '#59c059' },
  { type: 'operator_mathop', message0: '%1 of %2', args0: [{ type: 'field_dropdown', name: 'OPERATOR', options: [['abs', 'abs'], ['floor', 'floor'], ['ceiling', 'ceiling'], ['sqrt', 'sqrt'], ['sin', 'sin'], ['cos', 'cos'], ['tan', 'tan'], ['ln', 'ln'], ['log', 'log']] }, { type: 'input_value', name: 'NUM' }], output: 'Number', colour: '#59c059' },
  { type: 'data_variable', message0: '%1', args0: [{ type: 'field_label_serializable', name: 'VARIABLE_NAME', text: 'my variable' }], output: null, colour: dataVariableColour },
  { type: 'data_setvariableto', message0: 'set %1 to %2', args0: [{ type: 'field_scratch_data_dropdown', name: 'VARIABLE_NAME', kind: 'variable', text: 'my variable' }, { type: 'input_value', name: 'VALUE' }], colour: dataVariableColour, previousStatement: null, nextStatement: null },
  { type: 'data_changevariableby', message0: 'change %1 by %2', args0: [{ type: 'field_scratch_data_dropdown', name: 'VARIABLE_NAME', kind: 'variable', text: 'my variable' }, { type: 'input_value', name: 'VALUE', check: 'Number' }], colour: dataVariableColour, previousStatement: null, nextStatement: null },
  { type: 'data_showvariable', message0: 'show variable %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'VARIABLE_NAME', kind: 'variable', text: 'my variable' }], colour: dataVariableColour, previousStatement: null, nextStatement: null },
  { type: 'data_hidevariable', message0: 'hide variable %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'VARIABLE_NAME', kind: 'variable', text: 'my variable' }], colour: dataVariableColour, previousStatement: null, nextStatement: null },
  { type: 'data_listcontents', message0: '%1', args0: [{ type: 'field_label_serializable', name: 'LIST_NAME', text: 'list' }], output: null, colour: dataListColour },
  { type: 'data_addtolist', message0: 'add %1 to %2', args0: [{ type: 'field_input', name: 'ITEM', text: 'thing' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_deleteoflist', message0: 'delete %1 of %2', args0: [{ type: 'field_input', name: 'INDEX', text: '1' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_deletealloflist', message0: 'delete all of %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_insertatlist', message0: 'insert %1 at %2 of %3', args0: [{ type: 'field_input', name: 'ITEM', text: 'thing' }, { type: 'field_input', name: 'INDEX', text: '1' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_replaceitemoflist', message0: 'replace item %1 of %2 with %3', args0: [{ type: 'field_input', name: 'INDEX', text: '1' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }, { type: 'field_input', name: 'ITEM', text: 'thing' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_itemoflist', message0: 'item %1 of %2', args0: [{ type: 'field_input', name: 'INDEX', text: '1' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], output: null, colour: dataListColour },
  { type: 'data_itemnumoflist', message0: 'item # of %1 in %2', args0: [{ type: 'field_input', name: 'ITEM', text: 'thing' }, { type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], output: 'Number', colour: dataListColour },
  { type: 'data_lengthoflist', message0: 'length of %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], output: 'Number', colour: dataListColour },
  { type: 'data_listcontainsitem', message0: '%1 contains %2?', args0: [{ type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }, { type: 'field_input', name: 'ITEM', text: 'thing' }], output: 'Boolean', colour: dataListColour },
  { type: 'data_showlist', message0: 'show list %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'data_hidelist', message0: 'hide list %1', args0: [{ type: 'field_scratch_data_dropdown', name: 'LIST_NAME', kind: 'list', text: 'list' }], colour: dataListColour, previousStatement: null, nextStatement: null },
  { type: 'procedures_definition', message0: 'define %1', args0: [{ type: 'input_statement', name: 'custom_block' }], colour: '#ff6680', nextStatement: null },
  { type: 'procedures_prototype', message0: '%1', args0: [{ type: 'field_input', name: 'PROC_LABEL', text: 'ブロック名' }], colour: '#ff6680', previousStatement: null },
  { type: 'procedures_call', message0: '%1', args0: [{ type: 'field_input', name: 'PROC_LABEL', text: 'ブロック名' }], colour: '#ff6680', previousStatement: null, nextStatement: null },
  { type: 'argument_reporter_string_number', message0: 'arg %1', args0: [{ type: 'field_input', name: 'VALUE', text: 'arg' }], output: null, colour: '#ff6680' },
  { type: 'argument_reporter_boolean', message0: 'arg %1?', args0: [{ type: 'field_input', name: 'VALUE', text: 'arg' }], output: 'Boolean', colour: '#ff6680' },
  { type: 'pen_clear', message0: 'erase all', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_stamp', message0: 'stamp', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_penDown', message0: 'pen down', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_penUp', message0: 'pen up', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_setPenColorToColor', message0: 'set pen color to %1', args0: [{ type: 'input_value', name: 'COLOR', check: 'Colour' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_changePenColorParamBy', message0: 'change pen %1 by %2', args0: [{ type: 'input_value', name: 'COLOR_PARAM' }, { type: 'input_value', name: 'VALUE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_setPenColorParamTo', message0: 'set pen %1 to %2', args0: [{ type: 'input_value', name: 'COLOR_PARAM' }, { type: 'input_value', name: 'VALUE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_setPenHueToNumber', message0: 'set pen color to %1', args0: [{ type: 'input_value', name: 'HUE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_changePenHueBy', message0: 'change pen color by %1', args0: [{ type: 'input_value', name: 'HUE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_setPenShadeToNumber', message0: 'set pen shade to %1', args0: [{ type: 'input_value', name: 'SHADE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_changePenShadeBy', message0: 'change pen shade by %1', args0: [{ type: 'input_value', name: 'SHADE' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_changePenSizeBy', message0: 'change pen size by %1', args0: [{ type: 'field_number', name: 'SIZE', value: 1 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'pen_setPenSizeTo', message0: 'set pen size to %1', args0: [{ type: 'field_number', name: 'SIZE', value: 1, min: 1 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_playDrumForBeats', message0: 'play drum %1 for %2 beats', args0: [{ type: 'field_number', name: 'DRUM', value: 1 }, { type: 'field_number', name: 'BEATS', value: 0.25, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_restForBeats', message0: 'rest for %1 beats', args0: [{ type: 'field_number', name: 'BEATS', value: 0.25, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_playNoteForBeats', message0: 'play note %1 for %2 beats', args0: [{ type: 'field_number', name: 'NOTE', value: 60 }, { type: 'field_number', name: 'BEATS', value: 0.5, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_setInstrument', message0: 'set instrument to %1', args0: [{ type: 'field_number', name: 'INSTRUMENT', value: 1, min: 1 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_setTempo', message0: 'set tempo to %1', args0: [{ type: 'field_number', name: 'TEMPO', value: 60, min: 20 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_changeTempo', message0: 'change tempo by %1', args0: [{ type: 'field_number', name: 'TEMPO', value: 20 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'music_getTempo', message0: 'tempo', output: 'Number', colour: '#0fbd8c' },
  { type: 'videoSensing_videoOn', message0: 'video %1 on %2', args0: [{ type: 'field_dropdown', name: 'ATTRIBUTE', options: [['motion', 'motion'], ['direction', 'direction']] }, { type: 'field_input', name: 'SUBJECT', text: 'this sprite' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'videoSensing_videoToggle', message0: 'turn video %1', args0: [{ type: 'field_dropdown', name: 'VIDEO_STATE', options: [['on', 'on'], ['off', 'off'], ['on flipped', 'on flipped']] }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'videoSensing_setVideoTransparency', message0: 'set video transparency to %1', args0: [{ type: 'field_number', name: 'TRANSPARENCY', value: 50, min: 0, max: 100 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'translate_getTranslate', message0: 'translate %1 to %2', args0: [{ type: 'field_input', name: 'WORDS', text: 'hello' }, { type: 'field_input', name: 'LANGUAGE', text: 'en' }], output: 'String', colour: '#0fbd8c' },
  { type: 'translate_getViewerLanguage', message0: 'language', output: 'String', colour: '#0fbd8c' },
  { type: 'text2speech_speakAndWait', message0: 'speak %1', args0: [{ type: 'field_input', name: 'WORDS', text: 'hello' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'text2speech_setVoice', message0: 'set voice to %1', args0: [{ type: 'field_input', name: 'VOICE', text: 'alto' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'text2speech_setLanguage', message0: 'set language to %1', args0: [{ type: 'field_input', name: 'LANGUAGE', text: 'en' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'speech2text_listenAndWait', message0: 'listen and wait', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'speech2text_whenIHearHat', message0: 'when I hear %1', args0: [{ type: 'field_input', name: 'PHRASE', text: 'hello' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'speech2text_getSpeech', message0: 'speech', output: 'String', colour: '#0fbd8c' },
  { type: 'makeymakey_whenMakeyKeyPressed', message0: 'when %1 key pressed', args0: [{ type: 'field_input', name: 'KEY', text: 'space' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'makeymakey_whenCodePressed', message0: 'when %1 pressed in order', args0: [{ type: 'field_input', name: 'SEQUENCE', text: 'up up down down' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'microbit_whenButtonPressed', message0: 'when button %1 pressed', args0: [{ type: 'field_dropdown', name: 'BTN', options: [['A', 'A'], ['B', 'B'], ['any', 'any']] }], colour: '#0fbd8c', nextStatement: null },
  { type: 'microbit_isButtonPressed', message0: 'button %1 pressed?', args0: [{ type: 'field_dropdown', name: 'BTN', options: [['A', 'A'], ['B', 'B'], ['any', 'any']] }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'microbit_whenGesture', message0: 'when %1', args0: [{ type: 'field_input', name: 'GESTURE', text: 'moved' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'microbit_displaySymbol', message0: 'display symbol %1', args0: [{ type: 'field_input', name: 'MATRIX', text: '01010111110101001010' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'microbit_displayText', message0: 'display text %1', args0: [{ type: 'field_input', name: 'TEXT', text: 'hello' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'microbit_displayClear', message0: 'clear display', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'microbit_whenTilted', message0: 'when tilted %1', args0: [{ type: 'field_input', name: 'DIRECTION', text: 'any' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'microbit_isTilted', message0: 'tilted %1?', args0: [{ type: 'field_input', name: 'DIRECTION', text: 'any' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'microbit_getTiltAngle', message0: 'tilt angle %1', args0: [{ type: 'field_input', name: 'DIRECTION', text: 'front' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'microbit_whenPinConnected', message0: 'when pin %1 connected', args0: [{ type: 'field_input', name: 'PIN', text: '0' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'ev3_motorTurnClockwise', message0: 'motor %1 turn this way for %2 seconds', args0: [{ type: 'field_input', name: 'PORT', text: 'A' }, { type: 'field_number', name: 'TIME', value: 1, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'ev3_motorTurnCounterClockwise', message0: 'motor %1 turn that way for %2 seconds', args0: [{ type: 'field_input', name: 'PORT', text: 'A' }, { type: 'field_number', name: 'TIME', value: 1, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'ev3_motorSetPower', message0: 'set motor %1 power to %2', args0: [{ type: 'field_input', name: 'PORT', text: 'A' }, { type: 'field_number', name: 'POWER', value: 50 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'ev3_getMotorPosition', message0: 'motor %1 position', args0: [{ type: 'field_input', name: 'PORT', text: 'A' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'ev3_whenButtonPressed', message0: 'when button %1 pressed', args0: [{ type: 'field_input', name: 'BUTTON', text: 'up' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'ev3_whenDistanceLessThan', message0: 'when distance < %1', args0: [{ type: 'field_number', name: 'DISTANCE', value: 10 }], colour: '#0fbd8c', nextStatement: null },
  { type: 'ev3_whenBrightnessLessThan', message0: 'when brightness < %1', args0: [{ type: 'field_number', name: 'DISTANCE', value: 50 }], colour: '#0fbd8c', nextStatement: null },
  { type: 'ev3_buttonPressed', message0: 'button %1 pressed?', args0: [{ type: 'field_input', name: 'BUTTON', text: 'up' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'ev3_getDistance', message0: 'distance', output: 'Number', colour: '#0fbd8c' },
  { type: 'ev3_getBrightness', message0: 'brightness', output: 'Number', colour: '#0fbd8c' },
  { type: 'ev3_beep', message0: 'beep note %1 for %2 seconds', args0: [{ type: 'field_number', name: 'NOTE', value: 60 }, { type: 'field_number', name: 'TIME', value: 0.5, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_motorOnFor', message0: 'turn motor %1 on for %2 seconds', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'motor' }, { type: 'field_number', name: 'DURATION', value: 1, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_motorOn', message0: 'turn motor %1 on', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'motor' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_motorOff', message0: 'turn motor %1 off', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'motor' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_startMotorPower', message0: 'set motor %1 power to %2', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'motor' }, { type: 'field_number', name: 'POWER', value: 50 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_setMotorDirection', message0: 'set motor %1 direction %2', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'motor' }, { type: 'field_input', name: 'MOTOR_DIRECTION', text: 'this way' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_setLightHue', message0: 'set light color to %1', args0: [{ type: 'field_number', name: 'HUE', value: 50 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_playNoteFor', message0: 'play note %1 for %2 seconds', args0: [{ type: 'field_number', name: 'NOTE', value: 60 }, { type: 'field_number', name: 'DURATION', value: 0.5, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'wedo2_whenDistance', message0: 'when distance %1', args0: [{ type: 'field_input', name: 'OP', text: '< 10' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'wedo2_whenTilted', message0: 'when tilted %1', args0: [{ type: 'field_input', name: 'TILT_DIRECTION_ANY', text: 'any' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'wedo2_getDistance', message0: 'distance', output: 'Number', colour: '#0fbd8c' },
  { type: 'wedo2_isTilted', message0: 'tilted %1?', args0: [{ type: 'field_input', name: 'TILT_DIRECTION_ANY', text: 'any' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'wedo2_getTiltAngle', message0: 'tilt angle %1', args0: [{ type: 'field_input', name: 'TILT_DIRECTION', text: 'up' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'boost_motorOnFor', message0: 'turn motor %1 on for %2 seconds', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }, { type: 'field_number', name: 'DURATION', value: 1, min: 0 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_motorOnForRotation', message0: 'turn motor %1 for %2 rotations', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }, { type: 'field_number', name: 'ROTATION', value: 1 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_motorOn', message0: 'turn motor %1 on', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_motorOff', message0: 'turn motor %1 off', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_setMotorPower', message0: 'set motor %1 power to %2', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }, { type: 'field_number', name: 'POWER', value: 50 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_setMotorDirection', message0: 'set motor %1 direction %2', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }, { type: 'field_input', name: 'MOTOR_DIRECTION', text: 'this way' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'boost_getMotorPosition', message0: 'motor %1 position', args0: [{ type: 'field_input', name: 'MOTOR_ID', text: 'A' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'boost_whenTilted', message0: 'when tilted %1', args0: [{ type: 'field_input', name: 'TILT_DIRECTION_ANY', text: 'any' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'boost_isTilted', message0: 'tilted %1?', args0: [{ type: 'field_input', name: 'TILT_DIRECTION_ANY', text: 'any' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'boost_getTiltAngle', message0: 'tilt angle %1', args0: [{ type: 'field_input', name: 'TILT_DIRECTION', text: 'up' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'boost_whenColor', message0: 'when seeing color %1', args0: [{ type: 'input_value', name: 'COLOR', check: 'Colour' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'boost_seeingColor', message0: 'seeing color %1?', args0: [{ type: 'input_value', name: 'COLOR', check: 'Colour' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'boost_setLightHue', message0: 'set light color to %1', args0: [{ type: 'field_number', name: 'HUE', value: 50 }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'gdxfor_whenForcePushedOrPulled', message0: 'when force sensor %1', args0: [{ type: 'field_input', name: 'PUSH_PULL', text: 'pushed' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'gdxfor_getForce', message0: 'force', output: 'Number', colour: '#0fbd8c' },
  { type: 'gdxfor_whenGesture', message0: 'when gesture %1', args0: [{ type: 'field_input', name: 'GESTURE', text: 'shaken' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'gdxfor_whenTilted', message0: 'when tilted %1', args0: [{ type: 'field_input', name: 'TILT', text: 'any' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'gdxfor_isTilted', message0: 'tilted %1?', args0: [{ type: 'field_input', name: 'TILT', text: 'any' }], output: 'Boolean', colour: '#0fbd8c' },
  { type: 'gdxfor_getTilt', message0: 'tilt %1', args0: [{ type: 'field_input', name: 'TILT', text: 'up' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'gdxfor_getSpinSpeed', message0: 'spin speed %1', args0: [{ type: 'field_input', name: 'AXIS', text: 'x' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'gdxfor_getAcceleration', message0: 'acceleration %1', args0: [{ type: 'field_input', name: 'AXIS', text: 'x' }], output: 'Number', colour: '#0fbd8c' },
  { type: 'gdxfor_isFreeFalling', message0: 'falling?', output: 'Boolean', colour: '#0fbd8c' },
  { type: 'faceSensing_whenFaceDetected', message0: 'when face detected', colour: '#0fbd8c', nextStatement: null },
  { type: 'faceSensing_faceIsDetected', message0: 'face detected?', output: 'Boolean', colour: '#0fbd8c' },
  { type: 'faceSensing_faceSize', message0: 'face size', output: 'Number', colour: '#0fbd8c' },
  { type: 'faceSensing_setSizeToFaceSize', message0: 'set size to face size', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'faceSensing_faceTilt', message0: 'face tilt', output: 'Number', colour: '#0fbd8c' },
  { type: 'faceSensing_whenTilted', message0: 'when face tilted %1', args0: [{ type: 'field_input', name: 'TILT_DIRECTION', text: 'left' }], colour: '#0fbd8c', nextStatement: null },
  { type: 'faceSensing_pointInFaceTiltDirection', message0: 'point in face tilt direction', colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'faceSensing_goToPart', message0: 'go to face part %1', args0: [{ type: 'field_input', name: 'FACE_PART', text: 'nose' }], colour: '#0fbd8c', previousStatement: null, nextStatement: null },
  { type: 'faceSensing_whenSpriteTouchesPart', message0: 'when sprite touches face part %1', args0: [{ type: 'field_input', name: 'FACE_PART', text: 'nose' }], colour: '#0fbd8c', nextStatement: null },
]

export function registerScratchBlocklyBlocks() {
  if (scratchBlocksRegistered) return
  BlocklyModule.fieldRegistry.register('field_scratch_data_dropdown', ScratchDataDropdown)
  BlocklyModule.fieldRegistry.register('field_scratch_menu_dropdown', ScratchMenuDropdown)
  BlocklyModule.fieldRegistry.register('field_scratch_colour', ScratchColourField)
  registerScratchPrimitiveBlocks()
  BlocklyModule.common.defineBlocksWithJsonArray(scratchCompatibleBlockDefinitions())
  registerScratchProcedureBlocks()
  registerScratchDataBlocks()
  const fallbackDefinitions = moduleBlockPalette
    .flatMap((group) => [...group.opcodes])
    .filter((opcode) => !BlocklyModule.Blocks[opcode])
    .map(fallbackBlockDefinition)
  if (fallbackDefinitions.length > 0) BlocklyModule.common.defineBlocksWithJsonArray(fallbackDefinitions)
  scratchBlocksRegistered = true
}

function registerScratchPrimitiveBlocks() {
  BlocklyModule.Blocks.math_number = {
    init() {
      const block = this as BlocklyModule.Block
      block.appendDummyInput().appendField(new BlocklyModule.FieldNumber(0), 'NUM')
      block.setOutput(true, 'Number')
      block.setColour('#ffffff')
    },
  }
  BlocklyModule.Blocks.text = {
    init() {
      const block = this as BlocklyModule.Block
      block.appendDummyInput().appendField(new BlocklyModule.FieldTextInput(''), 'TEXT')
      block.setOutput(true, 'String')
      block.setColour('#ffffff')
    },
  }
}

function registerScratchProcedureBlocks() {
  BlocklyModule.Blocks.procedures_definition = {
    init() {
      const block = this as BlocklyModule.Block
      block.appendValueInput('custom_block').appendField('define')
      block.setColour('#ff6680')
      block.setNextStatement(true)
    },
  }
  BlocklyModule.Blocks.procedures_prototype = {
    init() {
      const block = this as BlocklyModule.Block
      block.setColour('#ff6680')
      block.setOutput(true)
      applyProcedureShape(block, { proccode: 'ブロック名', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]', warp: 'false' })
    },
    loadExtraState(state: unknown) {
      applyProcedureShape(this as BlocklyModule.Block, procedureMutationFromUnknown(state, true))
    },
    saveExtraState() {
      const block = this as BlocklyModule.Block & ScratchProcedureBlock
      return block.__hikkakuProcedureMutation ?? procedureMutationFromLabel('ブロック名', true)
    },
  }
  BlocklyModule.Blocks.procedures_call = {
    init() {
      const block = this as BlocklyModule.Block
      block.setColour('#ff6680')
      block.setPreviousStatement(true)
      block.setNextStatement(true)
      applyProcedureShape(block, { proccode: 'ブロック名', argumentids: '[]', argumentnames: '[]', argumentdefaults: '[]' })
    },
    loadExtraState(state: unknown) {
      applyProcedureShape(this as BlocklyModule.Block, procedureMutationFromUnknown(state, false))
    },
    saveExtraState() {
      const block = this as BlocklyModule.Block & ScratchProcedureBlock
      return block.__hikkakuProcedureMutation ?? procedureMutationFromLabel('ブロック名', false)
    },
  }
}

interface ScratchProcedureMutation {
  proccode: string
  argumentids: string
  argumentnames: string
  argumentdefaults: string
  warp?: string
}

type ScratchProcedureBlock = BlocklyModule.Block & { __hikkakuProcedureMutation?: ScratchProcedureMutation }

function applyProcedureShape(block: BlocklyModule.Block, mutation: ScratchProcedureMutation) {
  const procedureBlock = block as ScratchProcedureBlock
  procedureBlock.__hikkakuProcedureMutation = structuredClone(mutation)
  const argumentIds = parseProcedureStringList(mutation.argumentids)
  const argumentNames = parseProcedureStringList(mutation.argumentnames)
  const parts = procedureParts(mutation.proccode)
  for (const input of [...block.inputList]) {
    block.removeInput(input.name, true)
  }
  let argumentIndex = 0
  let textBuffer = ''
  const flushText = (input: BlocklyModule.Input) => {
    const text = textBuffer.replace(/\s+/g, ' ').trim()
    if (text) input.appendField(text)
    textBuffer = ''
  }
  for (const part of parts) {
    if (part === '%n' || part === '%s' || part === '%b') {
      const id = argumentIds[argumentIndex] ?? `input${argumentIndex}`
      const input = block.appendValueInput(id)
      if (part === '%b') input.setCheck('Boolean')
      flushText(input)
      if (block.type === 'procedures_prototype') input.appendField(argumentNames[argumentIndex] ?? id)
      argumentIndex += 1
    } else {
      textBuffer += part
    }
  }
  if (argumentIndex === 0) {
    const input = block.appendDummyInput('PROC_LABEL')
    const text = mutation.proccode.trim() || 'ブロック名'
    input.appendField(text)
  } else if (textBuffer.trim()) {
    block.appendDummyInput(`PROC_TEXT_${argumentIndex}`).appendField(textBuffer.replace(/\s+/g, ' ').trim())
  }
  block.setInputsInline(true)
}

function procedureParts(proccode: string) {
  return proccode.split(/(%[nsb])/g).filter((part) => part.length > 0)
}

function procedureMutationFromUnknown(value: unknown, prototype: boolean): ScratchProcedureMutation {
  const state = isObjectRecord(value) ? value : {}
  const proccode = typeof state.proccode === 'string' ? state.proccode : 'ブロック名'
  return {
    proccode,
    argumentids: typeof state.argumentids === 'string' ? state.argumentids : '[]',
    argumentnames: typeof state.argumentnames === 'string' ? state.argumentnames : '[]',
    argumentdefaults: typeof state.argumentdefaults === 'string' ? state.argumentdefaults : '[]',
    ...(prototype ? { warp: typeof state.warp === 'string' ? state.warp : 'false' } : {}),
  }
}

function procedureMutationFromLabel(proccode: string, prototype: boolean): ScratchProcedureMutation {
  return {
    proccode,
    argumentids: '[]',
    argumentnames: '[]',
    argumentdefaults: '[]',
    ...(prototype ? { warp: 'false' } : {}),
  }
}

function parseProcedureStringList(value: string): string[] {
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : []
  } catch {
    return []
  }
}

function scratchCompatibleBlockDefinitions() {
  return blockDefinitions.map((definition) => {
    const args0 = Array.isArray(definition.args0)
      ? definition.args0.map((arg) => {
          if (!isObjectRecord(arg) || typeof arg.name !== 'string') return arg
          const spec = blockInputSpec(String(definition.type), arg.name)
          if (!spec || (spec.kind !== 'value' && spec.kind !== 'boolean')) return arg
          return {
            type: 'input_value',
            name: arg.name,
            ...(spec.check ? { check: spec.check } : {}),
          }
        })
      : undefined
    return args0 ? { ...definition, args0 } : definition
  })
}

function registerScratchDataBlocks() {
  const variableField = () => new ScratchDataDropdown('variable', variableMenuOptions[0]?.[1] ?? 'my variable') as unknown as BlocklyModule.Field
  const listField = () => new ScratchDataDropdown('list', listMenuOptions[0]?.[1] ?? 'list') as unknown as BlocklyModule.Field
  const variableStatement = (type: string, label: string, valueInput?: string) => {
    BlocklyModule.Blocks[type] = {
      init() {
        const block = this as BlocklyModule.Block
        const input = valueInput ? block.appendValueInput(valueInput) : block.appendDummyInput()
        input
          .appendField(label)
          .appendField(variableField(), 'VARIABLE_NAME')
        if (type === 'data_setvariableto') input.appendField('to')
        block.setColour(dataVariableColour)
        block.setPreviousStatement(true)
        block.setNextStatement(true)
      },
    }
  }
  variableStatement('data_setvariableto', 'set', 'VALUE')
  variableStatement('data_changevariableby', 'change', 'VALUE')
  variableStatement('data_showvariable', 'show variable')
  variableStatement('data_hidevariable', 'hide variable')

  const listStatement = (type: string, build: (block: BlocklyModule.Block) => void) => {
    BlocklyModule.Blocks[type] = {
      init() {
        const block = this as BlocklyModule.Block
        build(block)
        block.setColour(dataListColour)
        block.setPreviousStatement(true)
        block.setNextStatement(true)
      },
    }
  }
  listStatement('data_addtolist', (block) => {
    block.appendValueInput('ITEM').appendField('add')
    block.appendDummyInput().appendField('to').appendField(listField(), 'LIST_NAME')
  })
  listStatement('data_deleteoflist', (block) => {
    block.appendValueInput('INDEX').appendField('delete')
    block.appendDummyInput().appendField('of').appendField(listField(), 'LIST_NAME')
  })
  listStatement('data_deletealloflist', (block) => block.appendDummyInput().appendField('delete all of').appendField(listField(), 'LIST_NAME'))
  listStatement('data_insertatlist', (block) => {
    block.appendValueInput('ITEM').appendField('insert')
    block.appendValueInput('INDEX').appendField('at')
    block.appendDummyInput().appendField('of').appendField(listField(), 'LIST_NAME')
  })
  listStatement('data_replaceitemoflist', (block) => {
    block.appendValueInput('INDEX').appendField('replace item')
    block.appendDummyInput().appendField('of').appendField(listField(), 'LIST_NAME').appendField('with')
    block.appendValueInput('ITEM')
  })
  listStatement('data_showlist', (block) => block.appendDummyInput().appendField('show list').appendField(listField(), 'LIST_NAME'))
  listStatement('data_hidelist', (block) => block.appendDummyInput().appendField('hide list').appendField(listField(), 'LIST_NAME'))

  const listReporter = (type: string, build: (block: BlocklyModule.Block) => void) => {
    BlocklyModule.Blocks[type] = {
      init() {
        const block = this as BlocklyModule.Block
        build(block)
        block.setColour(dataListColour)
        block.setOutput(true)
      },
    }
  }
  listReporter('data_itemoflist', (block) => {
    block.appendValueInput('INDEX').appendField('item')
    block.appendDummyInput().appendField('of').appendField(listField(), 'LIST_NAME')
  })
  listReporter('data_itemnumoflist', (block) => {
    block.appendValueInput('ITEM').appendField('item # of')
    block.appendDummyInput().appendField('in').appendField(listField(), 'LIST_NAME')
  })
  listReporter('data_lengthoflist', (block) => block.appendDummyInput().appendField('length of').appendField(listField(), 'LIST_NAME'))
  listReporter('data_listcontainsitem', (block) => {
    block.appendValueInput('ITEM').appendField(listField(), 'LIST_NAME').appendField('contains')
    block.appendDummyInput().appendField('?')
  })
}

function fallbackBlockDefinition(opcode: string) {
  const isHat = opcode.includes('_when') || opcode.startsWith('when')
  const isReporter = /(^|_)(get|is|seeing|face|videoOn|loud|online|buttonPressed|getSpeech|getTranslate|getViewerLanguage|getTempo|getDistance|getBrightness|getForce|getTilt|getTiltAngle|getSpinSpeed|getAcceleration|getMotorPosition|faceIsDetected|faceSize|faceTilt|isFreeFalling)/.test(opcode)
  return {
    type: opcode,
    message0: opcode.replace(/_/g, ' '),
    colour: '#0fbd8c',
    ...(isHat ? { nextStatement: null } : isReporter ? { output: null } : { previousStatement: null, nextStatement: null }),
  }
}

const extensionOpcodePrefixes: Record<string, string[]> = {
  pen: ['pen_'],
  music: ['music_', 'music_midi'],
  videoSensing: ['videoSensing_'],
  translate: ['translate_'],
  text2speech: ['text2speech_'],
  speech2text: ['speech2text_'],
  microbit: ['microbit_'],
  makeymakey: ['makeymakey_'],
  ev3: ['ev3_'],
  wedo2: ['wedo2_'],
  boost: ['boost_'],
  gdxfor: ['gdxfor_'],
  faceSensing: ['faceSensing_'],
}

const categoryLabels: Record<string, string> = {
  motion: '動き',
  looks: '見た目',
  sound: '音',
  events: 'イベント',
  control: '制御',
  sensing: '調べる',
  operators: '演算',
  variables: '変数',
  'my blocks': 'ブロック定義',
}

export interface MonitorableReporterSpec {
  opcode: string
  label: string
  params?: Record<string, string>
}

export const monitorableReporterSpecs: readonly MonitorableReporterSpec[] = [
  { opcode: 'motion_xposition', label: 'x座標' },
  { opcode: 'motion_yposition', label: 'y座標' },
  { opcode: 'motion_direction', label: '向き' },
  { opcode: 'looks_size', label: '大きさ' },
  { opcode: 'looks_costumenumbername', label: 'コスチュームの番号', params: { NUMBER_NAME: 'number' } },
  { opcode: 'looks_backdropnumbername', label: '背景の番号', params: { NUMBER_NAME: 'number' } },
  { opcode: 'sound_volume', label: '音量' },
  { opcode: 'sensing_answer', label: '答え' },
  { opcode: 'sensing_mousedown', label: 'マウスが押された' },
  { opcode: 'sensing_mousex', label: 'マウスのx座標' },
  { opcode: 'sensing_mousey', label: 'マウスのy座標' },
  { opcode: 'sensing_loudness', label: '音量' },
  { opcode: 'sensing_timer', label: 'タイマー' },
  { opcode: 'sensing_current', label: '現在の年', params: { CURRENTMENU: 'YEAR' } },
  { opcode: 'sensing_dayssince2000', label: '2000年からの日数' },
  { opcode: 'sensing_username', label: 'ユーザー名' },
  { opcode: 'control_get_counter', label: 'カウンター' },
  { opcode: 'music_getTempo', label: 'テンポ' },
  { opcode: 'translate_getViewerLanguage', label: '言語' },
  { opcode: 'speech2text_getSpeech', label: 'スピーチ' },
] as const

const monitorableReporterByOpcode = new Map<string, MonitorableReporterSpec>(monitorableReporterSpecs.map((spec) => [spec.opcode, spec]))

export function makeToolbox(target?: ModuleScratchTarget, loadedExtensions: readonly string[] = [], stage?: ModuleScratchTarget, targets: readonly ModuleScratchTarget[] = [], monitors: readonly ModuleScratchMonitor[] = []) {
  setScratchDataFieldOptions(target, stage)
  setScratchMenuFieldOptions(target, targets)
  const builtInCategories = moduleBlockPalette
    .filter((group) => group.category !== 'extensions')
    .map((group) => ({
      name: categoryLabels[group.category] ?? group.category,
      colour: group.color,
      contents: group.category === 'variables'
        ? variableToolboxContents(target, stage, monitors)
        : group.category === 'my blocks'
          ? procedureToolboxContents(target)
        : blockToolboxContents(group.opcodes, target, monitors),
    }))
  const extensionCategories = extensionToolboxCategories(loadedExtensions, target, monitors)
  const categories = [...builtInCategories, ...extensionCategories]
  const continuousContents = continuousToolboxContents(categories)
  return {
    kind: 'categoryToolbox',
    contents: categories.map((category) => ({
      kind: 'category',
      name: category.name,
      colour: category.colour,
      contents: continuousContents,
    })),
  }
}

function blockToolboxContents(opcodes: readonly string[], target: ModuleScratchTarget | undefined, monitors: readonly ModuleScratchMonitor[]) {
  return opcodes
    .filter((opcode) => BlocklyModule.Blocks[opcode])
    .map((opcode) => toolboxBlockForOpcode(opcode))
}

function toolboxBlockForOpcode(opcode: string): Record<string, unknown> {
  const inputs = toolboxShadowInputs(opcode)
  return Object.keys(inputs).length > 0 ? { kind: 'block', type: opcode, inputs } : { kind: 'block', type: opcode }
}

function toolboxShadowInputs(opcode: string): Record<string, unknown> {
  return toolboxShadowInputsForOpcode(opcode)
}

function procedureToolboxContents(target?: ModuleScratchTarget) {
  const contents: Array<Record<string, unknown>> = [
    { kind: 'button', text: 'ブロックを作る', callbackKey: 'CREATE_BLOCK' },
  ]
  for (const procedure of targetProcedures(target)) {
    contents.push({
      kind: 'block',
      type: 'procedures_call',
      fields: { PROC_LABEL: procedure.proccode },
      extraState: {
        proccode: procedure.proccode,
        argumentids: procedure.argumentids,
        argumentnames: procedure.argumentnames,
        argumentdefaults: procedure.argumentdefaults,
        warp: procedure.warp,
      },
    })
  }
  return contents
}

function targetProcedures(target?: ModuleScratchTarget) {
  const procedures: Array<{ proccode: string; argumentids: string; argumentnames: string; argumentdefaults: string; warp: string }> = []
  const seen = new Set<string>()
  const blocks = target?.blocks ?? {}
  for (const block of Object.values(blocks)) {
    if (block.opcode !== 'procedures_definition') continue
    const prototypeId = typeof block.inputs?.custom_block?.[1] === 'string' ? block.inputs.custom_block[1] : undefined
    const prototype = prototypeId ? blocks[prototypeId] : undefined
    const mutation = prototype?.mutation
    const proccode = typeof mutation?.proccode === 'string' ? mutation.proccode : undefined
    if (!proccode || seen.has(proccode)) continue
    seen.add(proccode)
    procedures.push({
      proccode,
      argumentids: typeof mutation?.argumentids === 'string' ? mutation.argumentids : '[]',
      argumentnames: typeof mutation?.argumentnames === 'string' ? mutation.argumentnames : '[]',
      argumentdefaults: typeof mutation?.argumentdefaults === 'string' ? mutation.argumentdefaults : '[]',
      warp: typeof mutation?.warp === 'string' ? mutation.warp : 'false',
    })
  }
  return procedures
}

function continuousToolboxContents(categories: Array<{ name: string; colour: string; contents: Array<Record<string, unknown>> }>) {
  const contents: Array<Record<string, unknown>> = []
  for (const category of categories) {
    if (contents.length > 0) contents.push({ kind: 'sep', gap: 24 })
    contents.push({ kind: 'label', text: category.name, 'web-class': 'hikkakuFlyoutCategoryLabel' })
    contents.push(...category.contents)
  }
  return contents
}

function setScratchDataFieldOptions(target?: ModuleScratchTarget, stage?: ModuleScratchTarget) {
  const globalVariables = target?.isStage ? [] : Object.values(stage?.variables ?? {})
  const localVariables = Object.values(target?.variables ?? {})
  const globalLists = target?.isStage ? [] : Object.values(stage?.lists ?? {})
  const localLists = Object.values(target?.lists ?? {})
  variableMenuOptions = menuOptions([...globalVariables, ...localVariables].map((variable) => variable[0]), 'my variable')
  listMenuOptions = menuOptions([...globalLists, ...localLists].map((list) => list[0]), 'list')
}

function setScratchMenuFieldOptions(target: ModuleScratchTarget | undefined, targets: readonly ModuleScratchTarget[]) {
  const currentId = target?.id ?? target?.name
  const spriteOptions = targets
    .filter((candidate) => !candidate.isStage && !candidate.isClone && (candidate.id ?? candidate.name) !== currentId)
    .map((candidate) => [candidate.name, candidate.name] as [string, string])
  const allSpriteOptions = targets
    .filter((candidate) => !candidate.isStage && !candidate.isClone)
    .map((candidate) => [candidate.name, candidate.name] as [string, string])
  const stage = targets.find((candidate) => candidate.isStage)
  destinationMenuOptions = [['どこかの場所', '_random_'], ['マウスのポインター', '_mouse_'], ...spriteOptions]
  pointTowardsMenuOptions = [['マウスのポインター', '_mouse_'], ...spriteOptions]
  touchingObjectMenuOptions = [['マウスのポインター', '_mouse_'], ['端', '_edge_'], ...spriteOptions]
  cloneTargetMenuOptions = [['自分自身', '_myself_'], ...spriteOptions]
  sensingObjectMenuOptions = [['ステージ', '_stage_'], ...allSpriteOptions]
  costumeMenuOptions = assetMenuOptions(target?.costumes.map((costume) => costume.name) ?? [], 'costume1')
  backdropMenuOptions = assetMenuOptions(stage?.costumes.map((costume) => costume.name) ?? [], 'backdrop1')
  costumeChoiceMenuOptions = [
    ...costumeMenuOptions,
    ['次のコスチューム', 'next costume'],
    ['前のコスチューム', 'previous costume'],
    ['どれかのコスチューム', 'random costume'],
  ]
  backdropChoiceMenuOptions = [
    ...backdropMenuOptions,
    ['次の背景', 'next backdrop'],
    ['前の背景', 'previous backdrop'],
    ['どれかの背景', 'random backdrop'],
  ]
  soundMenuOptions = assetMenuOptions(target?.sounds.map((sound) => sound.name) ?? [], 'pop')
  broadcastMenuOptions = [
    ...menuOptions(broadcastNames(targets), 'message1'),
    ['新しいメッセージ', '__new_broadcast__'],
  ]
}

function menuOptions(names: string[], fallback: string): Array<[string, string]> {
  const unique = [...new Set(names.filter(Boolean))]
  return (unique.length > 0 ? unique : [fallback]).map((name) => [name, name])
}

function assetMenuOptions(names: string[], fallback: string): Array<[string, string]> {
  return menuOptions(names, fallback)
}

function broadcastNames(targets: readonly ModuleScratchTarget[]) {
  const names: string[] = []
  for (const target of targets) {
    for (const block of Object.values(target.blocks ?? {})) {
      const field = block.fields?.BROADCAST_OPTION?.[0]
      if (typeof field === 'string' && field) names.push(field)
      const input = block.inputs?.BROADCAST_INPUT
      const value = Array.isArray(input) ? input[1] : undefined
      if (Array.isArray(value) && typeof value[1] === 'string' && value[1]) names.push(value[1])
      if (typeof value === 'string') {
        const child = target.blocks?.[value]
        const childField = child?.opcode === 'event_broadcast_menu' ? child.fields?.BROADCAST_OPTION?.[0] : undefined
        if (typeof childField === 'string' && childField) names.push(childField)
      }
    }
  }
  return names
}

function extensionToolboxCategories(loadedExtensions: readonly string[], target?: ModuleScratchTarget, monitors: readonly ModuleScratchMonitor[] = []) {
  const extensionOpcodes = moduleBlockPalette.find((group) => group.category === 'extensions')?.opcodes ?? []
  const loaded = new Set(loadedExtensions)
  return extensionLibrary
    .filter((extension) => loaded.has(extension.extensionId))
    .map((extension) => ({
      kind: 'category',
      name: `${extension.icon} ${extension.name}`,
      colour: extension.color,
      contents: blockToolboxContents(extensionOpcodes
        .filter((opcode) => (extensionOpcodePrefixes[extension.extensionId] ?? []).some((prefix) => opcode.startsWith(prefix)))
        .filter((opcode) => BlocklyModule.Blocks[opcode]), target, monitors),
    }))
}

function variableToolboxContents(target?: ModuleScratchTarget, stage?: ModuleScratchTarget, monitors: readonly ModuleScratchMonitor[] = []) {
  const globalVariables = target?.isStage ? [] : Object.entries(stage?.variables ?? {})
  const localVariables = Object.entries(target?.variables ?? {})
  const globalLists = target?.isStage ? [] : Object.entries(stage?.lists ?? {})
  const localLists = Object.entries(target?.lists ?? {})
  const variables = [...globalVariables, ...localVariables]
  const lists = [...globalLists, ...localLists]
  const contents: Array<Record<string, unknown>> = [
    { kind: 'button', text: 'Make a Variable', callbackKey: 'CREATE_VARIABLE' },
  ]
  for (const [id, variable] of variables) {
    contents.push(
      { kind: 'block', type: 'data_variable', fields: { VARIABLE_NAME: variable[0] }, extraState: { variableId: id } },
    )
  }
  const defaultVariable = variables[0]
  if (defaultVariable) {
    const [id, variable] = defaultVariable
    contents.push(
      { kind: 'block', type: 'data_setvariableto', fields: { VARIABLE_NAME: variable[0] }, inputs: { VALUE: { shadow: { type: 'text', fields: { TEXT: '0' } } } }, extraState: { variableId: id } },
      { kind: 'block', type: 'data_changevariableby', fields: { VARIABLE_NAME: variable[0] }, inputs: { VALUE: { shadow: { type: 'math_number', fields: { NUM: 1 } } } }, extraState: { variableId: id } },
      { kind: 'block', type: 'data_showvariable', fields: { VARIABLE_NAME: variable[0] }, extraState: { variableId: id } },
      { kind: 'block', type: 'data_hidevariable', fields: { VARIABLE_NAME: variable[0] }, extraState: { variableId: id } },
    )
  }
  contents.push({ kind: 'button', text: 'Make a List', callbackKey: 'CREATE_LIST' })
  for (const [id, list] of lists) {
    contents.push(
      { kind: 'block', type: 'data_listcontents', fields: { LIST_NAME: list[0] }, extraState: { listId: id } },
    )
  }
  const defaultList = lists[0]
  if (defaultList) {
    const [id, list] = defaultList
    contents.push(
      { kind: 'block', type: 'data_addtolist', fields: { LIST_NAME: list[0] }, inputs: { ITEM: { shadow: { type: 'text', fields: { TEXT: 'thing' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_deleteoflist', fields: { LIST_NAME: list[0] }, inputs: { INDEX: { shadow: { type: 'text', fields: { TEXT: '1' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_deletealloflist', fields: { LIST_NAME: list[0] }, extraState: { listId: id } },
      { kind: 'block', type: 'data_insertatlist', fields: { LIST_NAME: list[0] }, inputs: { ITEM: { shadow: { type: 'text', fields: { TEXT: 'thing' } } }, INDEX: { shadow: { type: 'text', fields: { TEXT: '1' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_replaceitemoflist', fields: { LIST_NAME: list[0] }, inputs: { INDEX: { shadow: { type: 'text', fields: { TEXT: '1' } } }, ITEM: { shadow: { type: 'text', fields: { TEXT: 'thing' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_itemoflist', fields: { LIST_NAME: list[0] }, inputs: { INDEX: { shadow: { type: 'text', fields: { TEXT: '1' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_itemnumoflist', fields: { LIST_NAME: list[0] }, inputs: { ITEM: { shadow: { type: 'text', fields: { TEXT: 'thing' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_lengthoflist', fields: { LIST_NAME: list[0] }, extraState: { listId: id } },
      { kind: 'block', type: 'data_listcontainsitem', fields: { LIST_NAME: list[0] }, inputs: { ITEM: { shadow: { type: 'text', fields: { TEXT: 'thing' } } } }, extraState: { listId: id } },
      { kind: 'block', type: 'data_showlist', fields: { LIST_NAME: list[0] }, extraState: { listId: id } },
      { kind: 'block', type: 'data_hidelist', fields: { LIST_NAME: list[0] }, extraState: { listId: id } },
    )
  }
  return contents
}

function variableOwnerForId(id: string, target?: ModuleScratchTarget, stage?: ModuleScratchTarget) {
  if (target?.variables[id]) return target
  if (stage?.variables[id]) return stage
  return target ?? stage
}

function listOwnerForId(id: string, target?: ModuleScratchTarget, stage?: ModuleScratchTarget) {
  if (target?.lists[id]) return target
  if (stage?.lists[id]) return stage
  return target ?? stage
}

function monitorVisible(owner: ModuleScratchTarget | undefined, id: string, opcode: string, monitors: readonly ModuleScratchMonitor[]) {
  const monitorId = `${owner?.id ?? owner?.name ?? ''}:${id}`
  return monitors.some((monitor) => monitor.opcode === opcode && monitor.visible && (monitor.id === monitorId || monitor.id.endsWith(`:${id}`)))
}

export function monitorCallbackKey(spec: Pick<MonitorableReporterSpec, 'opcode' | 'params'>) {
  return `TOGGLE_BLOCK_MONITOR_${spec.opcode}_${Object.entries(spec.params ?? {}).map(([key, value]) => `${key}:${value}`).join('_')}`
}

function monitorVisibleForSpec(target: ModuleScratchTarget | undefined, spec: MonitorableReporterSpec, monitors: readonly ModuleScratchMonitor[]) {
  return monitors.some((monitor) => {
    if (monitor.opcode !== spec.opcode || !monitor.visible) return false
    if (monitor.spriteName && target && monitor.spriteName !== target.name) return false
    return Object.entries(spec.params ?? {}).every(([key, value]) => String(monitor.params[key] ?? '') === String(value))
  })
}

export function workspaceToScratchBlocks(workspace: BlocklyModule.WorkspaceSvg, target?: ModuleScratchTarget, stage?: ModuleScratchTarget): Record<string, ModuleScratchBlock> {
  const blocks: Record<string, ModuleScratchBlock> = {}
  const syntheticShadows: Record<string, ModuleScratchBlock> = {}
  for (const block of workspace.getAllBlocks(false) as BlocklyModule.BlockSvg[]) {
    if (block.isShadow() && !shouldSerializeShadowBlock(block)) continue
    if (!block.isShadow() && block.getParent() && primitiveReporterLiteral(block)) continue
    blocks[block.id] = blockToScratch(block, target, stage, syntheticShadows)
  }
  preserveProcedurePrototypeArgumentShadows(blocks, target)
  return { ...blocks, ...syntheticShadows }
}

function preserveProcedurePrototypeArgumentShadows(blocks: Record<string, ModuleScratchBlock>, target?: ModuleScratchTarget) {
  const sourceBlocks = target?.blocks ?? {}
  for (const [id, block] of Object.entries(sourceBlocks)) {
    if (blocks[id] || !block.shadow || !block.opcode.startsWith('argument_reporter_')) continue
    const parentId = typeof block.parent === 'string' ? block.parent : undefined
    if (!parentId || blocks[parentId]?.opcode !== 'procedures_prototype') continue
    blocks[id] = structuredClone(block)
  }
}

function blockToScratch(block: BlocklyModule.BlockSvg, target?: ModuleScratchTarget, stage?: ModuleScratchTarget, syntheticShadows: Record<string, ModuleScratchBlock> = {}): ModuleScratchBlock {
  const position = block.getRelativeToSurfaceXY()
  const next = block.nextConnection?.targetBlock()?.id ?? null
  const parentBlock = block.getParent()
  const source = scratchBlockState(block)
  const inputs: Record<string, [number, unknown, unknown?]> = {}
  const visibleInputNames = new Set<string>()
  for (const input of block.inputList) {
    if (input.name) visibleInputNames.add(input.name)
    const target = input.connection?.targetBlock()
    const literal = target ? literalFromShadowBlock(target as BlocklyModule.BlockSvg) : undefined
    if (literal) inputs[input.name] = [1, literal]
    else if (target?.isShadow()) inputs[input.name] = [1, target.id]
    else if (target) {
      const childLiteral = primitiveReporterLiteral(target as BlocklyModule.BlockSvg)
      const shadowLiteral = literalFromShadowState(input.connection)
      if (childLiteral) {
        inputs[input.name] = shadowLiteral ? [3, childLiteral, shadowLiteral] : [2, childLiteral]
        continue
      }
      if (shadowLiteral) {
        inputs[input.name] = [3, target.id, shadowLiteral]
        continue
      }
      const shadow = scratchBlockFromShadowState(input.connection, block.id)
      if (shadow) {
        const shadowId = preservedScratchShadowId(input.connection) ?? syntheticShadowId(block, input.name)
        syntheticShadows[shadowId] = shadow
        inputs[input.name] = [3, target.id, shadowId]
      } else {
        inputs[input.name] = [2, target.id]
      }
    }
  }
  addFieldInputs(block, inputs)
  mergePreservedInputs(inputs, source?.inputs, visibleInputNames)
  reorderInputsLikeSource(inputs, source?.inputs)
  const fields = scratchFields(block, target, stage)
  discardInputsReplacedByFields(inputs, fields)
  mergePreservedFields(fields, source?.fields)
  const mutation = scratchMutation(block, source)
  return {
    opcode: block.type,
    next,
    parent: parentBlock?.id ?? null,
    inputs,
    fields,
    ...(mutation ? { mutation } : {}),
    shadow: block.isShadow(),
    topLevel: !parentBlock,
    x: Math.round(position.x),
    y: Math.round(position.y),
  }
}

function discardInputsReplacedByFields(inputs: Record<string, [number, unknown, unknown?]>, fields: Record<string, [string, string?]>) {
  if (fields.BROADCAST_OPTION) delete inputs.BROADCAST_INPUT
  if (fields.COSTUME) delete inputs.COSTUME
  if (fields.BACKDROP) delete inputs.BACKDROP
  if (fields.SOUND_MENU) delete inputs.SOUND_MENU
  if (fields.OBJECT) delete inputs.OBJECT
  if (fields.TO) delete inputs.TO
  if (fields.TOWARDS) delete inputs.TOWARDS
  if (fields.TOUCHINGOBJECTMENU) delete inputs.TOUCHINGOBJECTMENU
  if (fields.DISTANCETOMENU) delete inputs.DISTANCETOMENU
  if (fields.CLONE_OPTION) delete inputs.CLONE_OPTION
}

export function attachScratchBlockState(block: BlocklyModule.BlockSvg, scratch: ModuleScratchBlock) {
  ;(block as BlocklyModule.BlockSvg & { __hikkakuScratchBlock?: ModuleScratchBlock }).__hikkakuScratchBlock = structuredClone(scratch)
}

function scratchBlockState(block: BlocklyModule.BlockSvg): ModuleScratchBlock | undefined {
  return (block as BlocklyModule.BlockSvg & { __hikkakuScratchBlock?: ModuleScratchBlock }).__hikkakuScratchBlock
}

function shouldSerializeShadowBlock(block: BlocklyModule.BlockSvg): boolean {
  if (block.type === 'procedures_prototype') return true
  if (block.type === 'event_broadcast_menu') return false
  if (scratchMenuShadowFieldName(block.type)) return true
  const source = scratchBlockState(block)
  if (source?.opcode === 'colour_picker') return false
  return !!source && source.opcode !== 'math_number' && source.opcode !== 'text'
}

function syntheticShadowId(block: BlocklyModule.BlockSvg, inputName: string) {
  return `${block.id}_${inputName}_shadow`
}

function preservedScratchShadowId(connection: BlocklyModule.Connection | null | undefined): string | undefined {
  return (connection as BlocklyModule.Connection & { __hikkakuScratchShadowId?: string } | null | undefined)?.__hikkakuScratchShadowId
}

function scratchBlockFromShadowState(connection: BlocklyModule.Connection | null | undefined, parentId: string): ModuleScratchBlock | undefined {
  const state = (connection as BlocklyModule.Connection & { getShadowState?: (includeCurrent?: boolean) => unknown } | null | undefined)?.getShadowState?.(false)
  if (!isObjectRecord(state)) return undefined
  const type = typeof state.type === 'string' ? state.type : undefined
  const fieldName = type ? scratchMenuShadowFieldName(type) : undefined
  if (!type || !fieldName) return undefined
  const fields = isObjectRecord(state.fields) ? state.fields : {}
  const value = fieldValueFromState(fields[fieldName])
  return {
    opcode: type,
    fields: { [fieldName]: [value] },
    inputs: {},
    shadow: true,
    topLevel: false,
    parent: parentId,
  } as ModuleScratchBlock & { id?: string }
}

function literalFromShadowState(connection: BlocklyModule.Connection | null | undefined): [number, string, string?] | undefined {
  const state = (connection as BlocklyModule.Connection & { getShadowState?: (includeCurrent?: boolean) => unknown } | null | undefined)?.getShadowState?.(false)
  if (!isObjectRecord(state)) return undefined
  const type = typeof state.type === 'string' ? state.type : undefined
  const fields = isObjectRecord(state.fields) ? state.fields : {}
  if (type === 'math_number') return [4, fieldValueFromState(fields.NUM)]
  if (type === 'colour_picker') return [9, fieldValueFromState(fields.COLOUR)]
  if (type === 'text') return [10, fieldValueFromState(fields.TEXT)]
  if (type === 'event_broadcast_menu') return [11, fieldValueFromState(fields.BROADCAST_OPTION)]
  return undefined
}

function fieldValueFromState(value: unknown) {
  if (isObjectRecord(value) && typeof value.value === 'string') return value.value
  if (typeof value === 'string') return value
  return ''
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mergePreservedInputs(inputs: Record<string, [number, unknown, unknown?]>, source: Record<string, [number, unknown, unknown?]> | undefined, visibleInputNames: Set<string>) {
  for (const [name, input] of Object.entries(source ?? {})) {
    if (visibleInputNames.has(name) && name in inputs) continue
    if (!(name in inputs)) inputs[name] = structuredClone(input)
  }
}

function reorderInputsLikeSource(inputs: Record<string, [number, unknown, unknown?]>, source: Record<string, [number, unknown, unknown?]> | undefined) {
  if (!source) return
  const ordered: Record<string, [number, unknown, unknown?]> = {}
  for (const name of Object.keys(source)) {
    if (name in inputs) ordered[name] = inputs[name]!
  }
  for (const [name, input] of Object.entries(inputs)) {
    if (!(name in ordered)) ordered[name] = input
  }
  for (const name of Object.keys(inputs)) delete inputs[name]
  Object.assign(inputs, ordered)
}

function mergePreservedFields(fields: Record<string, [string, string?]>, source: Record<string, [string, string?]> | undefined) {
  for (const [name, field] of Object.entries(source ?? {})) {
    if (!(name in fields)) fields[name] = structuredClone(field)
  }
}

function scratchMutation(block: BlocklyModule.BlockSvg, source?: ModuleScratchBlock): Record<string, unknown> | undefined {
  if (source?.mutation) return structuredClone(source.mutation)
  if (block.type !== 'procedures_call' && block.type !== 'procedures_prototype') return undefined
  const dynamicMutation = (block as BlocklyModule.BlockSvg & ScratchProcedureBlock).__hikkakuProcedureMutation
  if (dynamicMutation) return structuredClone(dynamicMutation) as unknown as Record<string, unknown>
  const proccode = String(block.getFieldValue('PROC_LABEL') ?? '')
  return proccode
    ? {
        proccode,
        argumentids: '[]',
        argumentnames: '[]',
        argumentdefaults: '[]',
        ...(block.type === 'procedures_prototype' ? { warp: 'false' } : {}),
      }
    : undefined
}

function literalFromShadowBlock(block: BlocklyModule.BlockSvg): [number, string, string?] | undefined {
  if (!block.isShadow()) return undefined
  return primitiveLiteralFromBlock(block)
}

function primitiveReporterLiteral(block: BlocklyModule.BlockSvg): [number, string, string?] | undefined {
  if (block.type === 'data_variable' || block.type === 'data_listcontents') return undefined
  return undefined
}

function primitiveLiteralFromBlock(block: BlocklyModule.BlockSvg): [number, string, string?] | undefined {
  if (block.type === 'math_number') return [4, String(block.getFieldValue('NUM') ?? 0)]
  if (block.type === 'colour_picker') return [9, String(block.getFieldValue('COLOUR') ?? '#000000')]
  if (block.type === 'text') return [10, String(block.getFieldValue('TEXT') ?? '')]
  if (block.type === 'event_broadcast_menu') {
    const value = String(block.getFieldValue('BROADCAST_OPTION') ?? 'message1')
    const source = scratchBlockState(block)
    return [11, value, source?.fields?.BROADCAST_OPTION?.[1] ?? value]
  }
  if (block.type === 'data_variable') {
    const value = String(block.getFieldValue('VARIABLE_NAME') ?? 'my variable')
    const source = scratchBlockState(block)
    return [12, value, source?.fields?.VARIABLE?.[1] ?? value]
  }
  if (block.type === 'data_listcontents') {
    const value = String(block.getFieldValue('LIST_NAME') ?? 'list')
    const source = scratchBlockState(block)
    return [13, value, source?.fields?.LIST?.[1] ?? value]
  }
  return undefined
}

function scratchFields(block: BlocklyModule.BlockSvg, target?: ModuleScratchTarget, stage?: ModuleScratchTarget): Record<string, [string, string?]> {
  const fields: Record<string, [string, string?]> = {}
  for (const input of block.inputList) {
    for (const field of input.fieldRow) {
      if (!field.name) continue
      fields[field.name] = [String(field.getValue())]
    }
  }
  if (block.type === 'event_whenbroadcastreceived' && fields.BROADCAST_OPTION) {
    fields.BROADCAST_OPTION = [fields.BROADCAST_OPTION[0], fields.BROADCAST_OPTION[0]]
  }
  if (fields.KEY_OPTION) fields.KEY_OPTION = [fields.KEY_OPTION[0], fields.KEY_OPTION[0]]
  if (fields.SOUND_MENU) fields.SOUND_MENU = [fields.SOUND_MENU[0], fields.SOUND_MENU[0]]
  if (fields.VARIABLE_NAME) {
    const variableId = idForVariableName(target, stage, fields.VARIABLE_NAME[0])
    fields.VARIABLE = [fields.VARIABLE_NAME[0], variableId ?? fields.VARIABLE_NAME[0]]
  }
  if (fields.LIST_NAME) {
    const listId = idForListName(target, stage, fields.LIST_NAME[0])
    fields.LIST = [fields.LIST_NAME[0], listId ?? fields.LIST_NAME[0]]
  }
  return fields
}

function idForVariableName(target: ModuleScratchTarget | undefined, stage: ModuleScratchTarget | undefined, name: string): string | undefined {
  const local = Object.entries(target?.variables ?? {}).find(([, variable]) => variable[0] === name)
  if (local) return local[0]
  const global = target?.isStage ? undefined : Object.entries(stage?.variables ?? {}).find(([, variable]) => variable[0] === name)
  return global?.[0]
}

function idForListName(target: ModuleScratchTarget | undefined, stage: ModuleScratchTarget | undefined, name: string): string | undefined {
  const local = Object.entries(target?.lists ?? {}).find(([, list]) => list[0] === name)
  if (local) return local[0]
  const global = target?.isStage ? undefined : Object.entries(stage?.lists ?? {}).find(([, list]) => list[0] === name)
  return global?.[0]
}

function addFieldInputs(block: BlocklyModule.BlockSvg, inputs: Record<string, [number, unknown, unknown?]>) {
  for (const name of valueInputNames(block.type)) {
    if (inputs[name]) continue
    const value = block.getFieldValue(name)
    if (value !== null && value !== undefined) inputs[name] = [1, [literalCodeForInput(block.type, name), String(value)]]
  }
  return
  const map: Record<string, string[]> = {
    motion_movesteps: ['STEPS'],
    motion_turnright: ['DEGREES'],
    motion_turnleft: ['DEGREES'],
    motion_pointindirection: ['DIRECTION'],
    motion_pointtowards: ['TOWARDS'],
    motion_goto: ['TO'],
    motion_gotoxy: ['X', 'Y'],
    motion_glideto: ['SECS', 'TO'],
    motion_glidesecstoxy: ['SECS', 'X', 'Y'],
    motion_changexby: ['DX'],
    motion_changeyby: ['DY'],
    motion_setx: ['X'],
    motion_sety: ['Y'],
    motion_setrotationstyle: ['STYLE'],
    looks_say: ['MESSAGE'],
    looks_sayforsecs: ['MESSAGE', 'SECS'],
    looks_think: ['MESSAGE'],
    looks_thinkforsecs: ['MESSAGE', 'SECS'],
    looks_switchcostumeto: ['COSTUME'],
    looks_switchbackdropto: ['BACKDROP'],
    looks_switchbackdroptoandwait: ['BACKDROP'],
    looks_changeeffectby: ['CHANGE'],
    looks_seteffectto: ['VALUE'],
    looks_changesizeby: ['CHANGE'],
    looks_setsizeto: ['SIZE'],
    looks_goforwardbackwardlayers: ['NUM'],
    sound_play: ['SOUND_MENU'],
    sound_playuntildone: ['SOUND_MENU'],
    sound_changeeffectby: ['VALUE'],
    sound_seteffectto: ['VALUE'],
    sound_changevolumeby: ['VOLUME'],
    sound_setvolumeto: ['VOLUME'],
    sound_sounds_menu: ['SOUND_MENU'],
    sound_beats_menu: ['BEATS'],
    event_broadcast: ['BROADCAST_INPUT'],
    event_broadcastandwait: ['BROADCAST_INPUT'],
    event_whenkeypressed: ['KEY_OPTION'],
    event_whentouchingobject: ['TOUCHINGOBJECTMENU'],
    event_whenbackdropswitchesto: ['BACKDROP'],
    event_whengreaterthan: ['VALUE'],
    control_create_clone_of: ['CLONE_OPTION'],
    control_wait: ['DURATION'],
    control_repeat: ['TIMES'],
    control_for_each: ['VARIABLE_NAME', 'VALUE'],
    sensing_askandwait: ['QUESTION'],
    sensing_touchingobject: ['TOUCHINGOBJECTMENU'],
    sensing_touchingcolor: ['COLOR'],
    sensing_coloristouchingcolor: ['COLOR', 'COLOR2'],
    sensing_distanceto: ['DISTANCETOMENU'],
    sensing_setdragmode: ['DRAG_MODE'],
    sensing_of: ['OBJECT'],
    operator_add: ['NUM1', 'NUM2'],
    operator_subtract: ['NUM1', 'NUM2'],
    operator_multiply: ['NUM1', 'NUM2'],
    operator_divide: ['NUM1', 'NUM2'],
    operator_random: ['FROM', 'TO'],
    operator_equals: ['OPERAND1', 'OPERAND2'],
    operator_gt: ['OPERAND1', 'OPERAND2'],
    operator_lt: ['OPERAND1', 'OPERAND2'],
    operator_join: ['STRING1', 'STRING2'],
    operator_letter_of: ['LETTER', 'STRING'],
    operator_length: ['STRING'],
    operator_contains: ['STRING1', 'STRING2'],
    operator_mod: ['NUM1', 'NUM2'],
    operator_round: ['NUM'],
    operator_mathop: ['NUM'],
    sensing_keypressed: ['KEY_OPTION'],
    data_setvariableto: ['VALUE'],
    data_changevariableby: ['VALUE'],
    data_addtolist: ['ITEM'],
    data_deleteoflist: ['INDEX'],
    data_insertatlist: ['ITEM', 'INDEX'],
    data_replaceitemoflist: ['INDEX', 'ITEM'],
    data_itemoflist: ['INDEX'],
    data_itemnumoflist: ['ITEM'],
    data_listcontainsitem: ['ITEM'],
    data_showlist: ['LIST_NAME'],
    data_hidelist: ['LIST_NAME'],
    pen_setPenColorToColor: ['COLOR'],
    pen_changePenColorParamBy: ['COLOR_PARAM', 'VALUE'],
    pen_setPenColorParamTo: ['COLOR_PARAM', 'VALUE'],
    pen_setPenHueToNumber: ['HUE'],
    pen_changePenHueBy: ['HUE'],
    pen_setPenShadeToNumber: ['SHADE'],
    pen_changePenShadeBy: ['SHADE'],
    pen_changePenSizeBy: ['SIZE'],
    pen_setPenSizeTo: ['SIZE'],
    music_playDrumForBeats: ['DRUM', 'BEATS'],
    music_restForBeats: ['BEATS'],
    music_playNoteForBeats: ['NOTE', 'BEATS'],
    music_setInstrument: ['INSTRUMENT'],
    music_setTempo: ['TEMPO'],
    music_changeTempo: ['TEMPO'],
    videoSensing_videoOn: ['SUBJECT'],
    videoSensing_setVideoTransparency: ['TRANSPARENCY'],
    translate_getTranslate: ['WORDS', 'LANGUAGE'],
    text2speech_speakAndWait: ['WORDS'],
    text2speech_setVoice: ['VOICE'],
    text2speech_setLanguage: ['LANGUAGE'],
    speech2text_whenIHearHat: ['PHRASE'],
    makeymakey_whenMakeyKeyPressed: ['KEY'],
    makeymakey_whenCodePressed: ['SEQUENCE'],
    microbit_displaySymbol: ['MATRIX'],
    microbit_displayText: ['TEXT'],
    ev3_motorTurnClockwise: ['PORT', 'TIME'],
    ev3_motorTurnCounterClockwise: ['PORT', 'TIME'],
    ev3_motorSetPower: ['PORT', 'POWER'],
    ev3_getMotorPosition: ['PORT'],
    ev3_whenButtonPressed: ['BUTTON'],
    ev3_whenDistanceLessThan: ['DISTANCE'],
    ev3_whenBrightnessLessThan: ['DISTANCE'],
    ev3_buttonPressed: ['BUTTON'],
    ev3_beep: ['NOTE', 'TIME'],
    wedo2_motorOnFor: ['MOTOR_ID', 'DURATION'],
    wedo2_motorOn: ['MOTOR_ID'],
    wedo2_motorOff: ['MOTOR_ID'],
    wedo2_startMotorPower: ['MOTOR_ID', 'POWER'],
    wedo2_setMotorDirection: ['MOTOR_ID', 'MOTOR_DIRECTION'],
    wedo2_setLightHue: ['HUE'],
    wedo2_playNoteFor: ['NOTE', 'DURATION'],
    wedo2_whenDistance: ['OP'],
    boost_motorOnFor: ['MOTOR_ID', 'DURATION'],
    boost_motorOnForRotation: ['MOTOR_ID', 'ROTATION'],
    boost_motorOn: ['MOTOR_ID'],
    boost_motorOff: ['MOTOR_ID'],
    boost_setMotorPower: ['MOTOR_ID', 'POWER'],
    boost_setMotorDirection: ['MOTOR_ID', 'MOTOR_DIRECTION'],
    boost_getMotorPosition: ['MOTOR_ID'],
    boost_whenColor: ['COLOR'],
    boost_seeingColor: ['COLOR'],
    boost_setLightHue: ['HUE'],
    gdxfor_whenForcePushedOrPulled: ['PUSH_PULL'],
    gdxfor_whenGesture: ['GESTURE'],
    gdxfor_whenTilted: ['TILT'],
    gdxfor_isTilted: ['TILT'],
    gdxfor_getTilt: ['TILT'],
    gdxfor_getSpinSpeed: ['AXIS'],
    gdxfor_getAcceleration: ['AXIS'],
    faceSensing_whenTilted: ['TILT_DIRECTION'],
    faceSensing_goToPart: ['FACE_PART'],
    faceSensing_whenSpriteTouchesPart: ['FACE_PART'],
  }
  for (const name of map[block.type] ?? []) {
    const value = block.getFieldValue(name)
    if (value !== null && value !== undefined) inputs[name] = [1, [4, String(value)]]
  }
}

export function applyScratchFields(block: BlocklyModule.BlockSvg, scratch: ModuleScratchBlock, options: { connectLiteralInputs?: boolean } = {}) {
  const connectLiteralInputs = options.connectLiteralInputs ?? true
  for (const [name, field] of Object.entries(scratch.fields ?? {})) {
    setBlocklyFieldValue(block, name, field[0])
  }
  applyLiteralInputToField(block, scratch, 'BROADCAST_INPUT', 'BROADCAST_OPTION')
  applyLiteralInputToField(block, scratch, 'COSTUME', 'COSTUME')
  applyLiteralInputToField(block, scratch, 'BACKDROP', 'BACKDROP')
  applyLiteralInputToField(block, scratch, 'SOUND_MENU', 'SOUND_MENU')
  applyLiteralInputToField(block, scratch, 'OBJECT', 'OBJECT')
  if (scratch.fields?.VARIABLE) setBlocklyFieldValue(block, 'VARIABLE_NAME', scratch.fields.VARIABLE[0])
  if (scratch.fields?.LIST) setBlocklyFieldValue(block, 'LIST_NAME', scratch.fields.LIST[0])
  const proccode = typeof scratch.mutation?.proccode === 'string' ? scratch.mutation.proccode : undefined
  if (proccode) setBlocklyFieldValue(block, 'PROC_LABEL', proccode)
  if ((scratch.opcode === 'procedures_call' || scratch.opcode === 'procedures_prototype') && scratch.mutation) {
    applyProcedureShape(block, procedureMutationFromUnknown(scratch.mutation, scratch.opcode === 'procedures_prototype'))
  }
  const specInputNames = valueInputNames(scratch.opcode)
  if (specInputNames.length > 0) {
    for (const name of specInputNames) {
      const value = literalInputValue(scratch.inputs?.[name])
      if (value === undefined) continue
      if (setBlocklyFieldValue(block, name, String(value))) continue
      if (connectLiteralInputs) connectLiteralShadow(block, name, value, literalInputCode(scratch.inputs?.[name]), literalInputId(scratch.inputs?.[name]))
    }
    return
  }
  const inputFields: Record<string, string[]> = {
    motion_movesteps: ['STEPS'],
    motion_turnright: ['DEGREES'],
    motion_turnleft: ['DEGREES'],
    motion_pointindirection: ['DIRECTION'],
    motion_pointtowards: ['TOWARDS'],
    motion_goto: ['TO'],
    motion_gotoxy: ['X', 'Y'],
    motion_glideto: ['SECS', 'TO'],
    motion_glidesecstoxy: ['SECS', 'X', 'Y'],
    motion_changexby: ['DX'],
    motion_changeyby: ['DY'],
    motion_setx: ['X'],
    motion_sety: ['Y'],
    motion_setrotationstyle: ['STYLE'],
    looks_say: ['MESSAGE'],
    looks_sayforsecs: ['MESSAGE', 'SECS'],
    looks_think: ['MESSAGE'],
    looks_thinkforsecs: ['MESSAGE', 'SECS'],
    looks_switchcostumeto: ['COSTUME'],
    looks_switchbackdropto: ['BACKDROP'],
    looks_switchbackdroptoandwait: ['BACKDROP'],
    looks_changeeffectby: ['CHANGE'],
    looks_seteffectto: ['VALUE'],
    looks_changesizeby: ['CHANGE'],
    looks_setsizeto: ['SIZE'],
    looks_goforwardbackwardlayers: ['NUM'],
    sound_play: ['SOUND_MENU'],
    sound_playuntildone: ['SOUND_MENU'],
    sound_changeeffectby: ['VALUE'],
    sound_seteffectto: ['VALUE'],
    sound_changevolumeby: ['VOLUME'],
    sound_setvolumeto: ['VOLUME'],
    sound_sounds_menu: ['SOUND_MENU'],
    sound_beats_menu: ['BEATS'],
    event_broadcast: ['BROADCAST_INPUT'],
    event_broadcastandwait: ['BROADCAST_INPUT'],
    event_whenkeypressed: ['KEY_OPTION'],
    event_whentouchingobject: ['TOUCHINGOBJECTMENU'],
    event_whenbackdropswitchesto: ['BACKDROP'],
    event_whengreaterthan: ['VALUE'],
    control_wait: ['DURATION'],
    control_repeat: ['TIMES'],
    control_for_each: ['VARIABLE_NAME', 'VALUE'],
    sensing_askandwait: ['QUESTION'],
    sensing_touchingobject: ['TOUCHINGOBJECTMENU'],
    sensing_touchingcolor: ['COLOR'],
    sensing_coloristouchingcolor: ['COLOR', 'COLOR2'],
    sensing_distanceto: ['DISTANCETOMENU'],
    sensing_keypressed: ['KEY_OPTION'],
    sensing_setdragmode: ['DRAG_MODE'],
    sensing_of: ['OBJECT'],
    operator_add: ['NUM1', 'NUM2'],
    operator_subtract: ['NUM1', 'NUM2'],
    operator_multiply: ['NUM1', 'NUM2'],
    operator_divide: ['NUM1', 'NUM2'],
    operator_random: ['FROM', 'TO'],
    operator_equals: ['OPERAND1', 'OPERAND2'],
    operator_gt: ['OPERAND1', 'OPERAND2'],
    operator_lt: ['OPERAND1', 'OPERAND2'],
    operator_join: ['STRING1', 'STRING2'],
    operator_letter_of: ['LETTER', 'STRING'],
    operator_length: ['STRING'],
    operator_contains: ['STRING1', 'STRING2'],
    operator_mod: ['NUM1', 'NUM2'],
    operator_round: ['NUM'],
    operator_mathop: ['NUM'],
    data_setvariableto: ['VALUE'],
    data_changevariableby: ['VALUE'],
    data_addtolist: ['ITEM'],
    data_deleteoflist: ['INDEX'],
    data_insertatlist: ['ITEM', 'INDEX'],
    data_replaceitemoflist: ['INDEX', 'ITEM'],
    data_itemoflist: ['INDEX'],
    data_itemnumoflist: ['ITEM'],
    data_listcontainsitem: ['ITEM'],
    data_showlist: ['LIST_NAME'],
    data_hidelist: ['LIST_NAME'],
    argument_reporter_string_number: ['VALUE'],
    argument_reporter_boolean: ['VALUE'],
    pen_setPenColorToColor: ['COLOR'],
    pen_changePenColorParamBy: ['COLOR_PARAM', 'VALUE'],
    pen_setPenColorParamTo: ['COLOR_PARAM', 'VALUE'],
    pen_setPenHueToNumber: ['HUE'],
    pen_changePenHueBy: ['HUE'],
    pen_setPenShadeToNumber: ['SHADE'],
    pen_changePenShadeBy: ['SHADE'],
    pen_changePenSizeBy: ['SIZE'],
    pen_setPenSizeTo: ['SIZE'],
    music_playDrumForBeats: ['DRUM', 'BEATS'],
    music_restForBeats: ['BEATS'],
    music_playNoteForBeats: ['NOTE', 'BEATS'],
    music_setInstrument: ['INSTRUMENT'],
    music_setTempo: ['TEMPO'],
    music_changeTempo: ['TEMPO'],
    videoSensing_videoOn: ['SUBJECT'],
    videoSensing_setVideoTransparency: ['TRANSPARENCY'],
    translate_getTranslate: ['WORDS', 'LANGUAGE'],
    text2speech_speakAndWait: ['WORDS'],
    text2speech_setVoice: ['VOICE'],
    text2speech_setLanguage: ['LANGUAGE'],
    speech2text_whenIHearHat: ['PHRASE'],
    makeymakey_whenMakeyKeyPressed: ['KEY'],
    makeymakey_whenCodePressed: ['SEQUENCE'],
    microbit_displaySymbol: ['MATRIX'],
    microbit_displayText: ['TEXT'],
    ev3_motorTurnClockwise: ['PORT', 'TIME'],
    ev3_motorTurnCounterClockwise: ['PORT', 'TIME'],
    ev3_motorSetPower: ['PORT', 'POWER'],
    ev3_getMotorPosition: ['PORT'],
    ev3_whenButtonPressed: ['BUTTON'],
    ev3_whenDistanceLessThan: ['DISTANCE'],
    ev3_whenBrightnessLessThan: ['DISTANCE'],
    ev3_buttonPressed: ['BUTTON'],
    ev3_beep: ['NOTE', 'TIME'],
    wedo2_motorOnFor: ['MOTOR_ID', 'DURATION'],
    wedo2_motorOn: ['MOTOR_ID'],
    wedo2_motorOff: ['MOTOR_ID'],
    wedo2_startMotorPower: ['MOTOR_ID', 'POWER'],
    wedo2_setMotorDirection: ['MOTOR_ID', 'MOTOR_DIRECTION'],
    wedo2_setLightHue: ['HUE'],
    wedo2_playNoteFor: ['NOTE', 'DURATION'],
    wedo2_whenDistance: ['OP'],
    boost_motorOnFor: ['MOTOR_ID', 'DURATION'],
    boost_motorOnForRotation: ['MOTOR_ID', 'ROTATION'],
    boost_motorOn: ['MOTOR_ID'],
    boost_motorOff: ['MOTOR_ID'],
    boost_setMotorPower: ['MOTOR_ID', 'POWER'],
    boost_setMotorDirection: ['MOTOR_ID', 'MOTOR_DIRECTION'],
    boost_getMotorPosition: ['MOTOR_ID'],
    boost_whenColor: ['COLOR'],
    boost_seeingColor: ['COLOR'],
    boost_setLightHue: ['HUE'],
    gdxfor_whenForcePushedOrPulled: ['PUSH_PULL'],
    gdxfor_whenGesture: ['GESTURE'],
    gdxfor_whenTilted: ['TILT'],
    gdxfor_isTilted: ['TILT'],
    gdxfor_getTilt: ['TILT'],
    gdxfor_getSpinSpeed: ['AXIS'],
    gdxfor_getAcceleration: ['AXIS'],
    faceSensing_whenTilted: ['TILT_DIRECTION'],
    faceSensing_goToPart: ['FACE_PART'],
    faceSensing_whenSpriteTouchesPart: ['FACE_PART'],
  }
  for (const name of inputFields[scratch.opcode] ?? []) {
    const value = literalInputValue(scratch.inputs?.[name])
    if (value === undefined) continue
    if (setBlocklyFieldValue(block, name, String(value))) continue
    if (connectLiteralInputs) connectLiteralShadow(block, name, value, literalInputCode(scratch.inputs?.[name]), literalInputId(scratch.inputs?.[name]))
  }
}

function applyLiteralInputToField(block: BlocklyModule.BlockSvg, scratch: ModuleScratchBlock, inputName: string, fieldName: string) {
  if (!block.getField(fieldName)) return
  const value = literalInputValue(scratch.inputs?.[inputName])
  if (value !== undefined) setBlocklyFieldValue(block, fieldName, String(value))
}

function setBlocklyFieldValue(block: BlocklyModule.BlockSvg, name: string, value: unknown): boolean {
  const field = block.getField(name)
  if (!field) return false
  block.setFieldValue(canonicalBlocklyFieldValue(field, value), name)
  return true
}

function canonicalBlocklyFieldValue(field: BlocklyModule.Field, value: unknown): string {
  const text = String(value)
  const options = dropdownOptions(field)
  if (options.length === 0) return text
  const normalizedText = normalizeDropdownValue(text)
  const match = options.find(([, optionValue]) => optionValue === text)
    ?? options.find(([, optionValue]) => normalizeDropdownValue(optionValue) === normalizedText)
    ?? options.find(([label]) => normalizeDropdownValue(label) === normalizedText)
  return match?.[1] ?? text
}

function dropdownOptions(field: BlocklyModule.Field): Array<[string, string]> {
  const maybeDropdown = field as BlocklyModule.Field & { getOptions?: (useCache?: boolean) => Array<[unknown, string]> }
  if (typeof maybeDropdown.getOptions !== 'function') return []
  try {
    return maybeDropdown.getOptions(false).map(([label, value]) => [String(label), String(value)])
  } catch {
    return []
  }
}

function normalizeDropdownValue(value: string): string {
  return value.toLowerCase().replace(/[\s_-]+/g, '')
}

function literalInputValue(input: [number, unknown, unknown?] | undefined) {
  const value = input?.[0] === 3 ? input?.[2] : input?.[1]
  return Array.isArray(value) ? value[1] : undefined
}

function literalInputCode(input: [number, unknown, unknown?] | undefined) {
  const value = input?.[0] === 3 ? input?.[2] : input?.[1]
  return Array.isArray(value) ? value[0] : undefined
}

function literalInputId(input: [number, unknown, unknown?] | undefined) {
  const value = input?.[0] === 3 ? input?.[2] : input?.[1]
  return Array.isArray(value) ? value[2] : undefined
}

function connectLiteralShadow(block: BlocklyModule.BlockSvg, inputName: string, value: unknown, code: unknown, literalId?: unknown) {
  const connection = block.getInput(inputName)?.connection
  if (!connection || connection.targetBlock()) return
  const type = literalShadowType(block.type, inputName, code)
  if (!BlocklyModule.Blocks[type]) return
  const shadow = block.workspace.newBlock(type) as BlocklyModule.BlockSvg
  shadow.setShadow(type !== 'data_variable' && type !== 'data_listcontents')
  const fieldName = literalShadowFieldName(type)
  shadow.setFieldValue(String(value), fieldName)
  const scratch = literalScratchBlock(type, value, literalId)
  if (scratch) attachScratchBlockState(shadow, scratch)
  shadow.initSvg()
  shadow.render()
  if (shadow.outputConnection) connection.connect(shadow.outputConnection)
}

function literalShadowType(opcode: string, inputName: string, code: unknown): string {
  return literalShadowTypeForInput(opcode, inputName, code)
}

function literalShadowFieldName(type: string): string {
  const menuFieldName = scratchMenuShadowFieldName(type)
  if (menuFieldName) return menuFieldName
  if (type === 'colour_picker') return 'COLOUR'
  if (type === 'data_variable') return 'VARIABLE_NAME'
  if (type === 'data_listcontents') return 'LIST_NAME'
  return type === 'text' ? 'TEXT' : 'NUM'
}

function literalScratchBlock(type: string, value: unknown, literalId?: unknown): ModuleScratchBlock | undefined {
  const name = String(value)
  const id = literalId === undefined ? name : String(literalId)
  if (type === 'event_broadcast_menu') return literalBlock(type, { BROADCAST_OPTION: [name, id] })
  if (type === 'data_variable') return literalBlock(type, { VARIABLE: [name, id] })
  if (type === 'data_listcontents') return literalBlock(type, { LIST: [name, id] })
  return undefined
}

function literalBlock(opcode: string, fields: Record<string, [string, string?]>): ModuleScratchBlock {
  return { opcode, fields, inputs: {}, shadow: true, topLevel: false }
}
