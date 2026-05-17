import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { Cast } from './util/cast'
import { Color, type HSVObject, type RGBObject } from './util/color'

export { Cast, LIST_ALL, LIST_INVALID, compare, isInt, isWhiteSpace, toBoolean, toListIndex, toNumber, toRgbColorList, toRgbColorObject, toString } from './util/cast'
export { Color, RGB_BLACK, RGB_WHITE, decimalToHex, decimalToRgb, hexToDecimal, hexToRgb, hsvToRgb, mixRgb, rgbToDecimal, rgbToHex, rgbToHsv, type HSVObject, type RGBObject } from './util/color'

export type ScratchValue = string | number | boolean

export type RotationStyle = 'all around' | "don't rotate" | 'left-right'

export type VariableRecord = [name: string, value: ScratchValue, isCloud?: boolean]
export type ListRecord = [name: string, value: ScratchValue[]]

export interface ScratchBlock {
  opcode: string
  next?: string | null
  parent?: string | null
  inputs?: Record<string, [number, unknown, unknown?]>
  fields?: Record<string, [string, string?]>
  mutation?: Record<string, unknown>
  shadow?: boolean
  topLevel?: boolean
  x?: number
  y?: number
  [key: string]: unknown
}

export interface ScratchCostume {
  assetId?: string
  name: string
  md5ext?: string
  dataFormat?: string
  bitmapResolution?: number
  rotationCenterX?: number
  rotationCenterY?: number
}

export interface ScratchSound {
  assetId?: string
  name: string
  md5ext?: string
  dataFormat?: string
  format?: string
  rate?: number
  sampleCount?: number
}

export interface ScratchTarget {
  id?: string
  isStage: boolean
  name: string
  variables: Record<string, VariableRecord>
  lists: Record<string, ListRecord>
  broadcasts: Record<string, string>
  blocks: Record<string, ScratchBlock>
  comments: Record<string, unknown>
  currentCostume: number
  costumes: ScratchCostume[]
  sounds: ScratchSound[]
  volume: number
  layerOrder?: number
  tempo?: number
  videoTransparency?: number
  videoState?: string
  textToSpeechLanguage?: string | null
  visible?: boolean
  drawableId?: number
  x?: number
  y?: number
  size?: number
  direction?: number
  draggable?: boolean
  rotationStyle?: RotationStyle
  isClone?: boolean
  cloneOf?: string
  speechBubble?: { type: 'say' | 'think'; text: string; until?: number }
  effects?: Record<string, number>
  soundEffects?: Record<string, number>
  pen?: { down: boolean; size: number; color: string; brightness: number; saturation: number; transparency: number }
  penLines?: Array<{ x1: number; y1: number; x2: number; y2: number; color: string; size: number; transparency: number }>
}

export interface ScratchProject {
  targets: ScratchTarget[]
  monitors: ScratchMonitor[]
  extensions: string[]
  meta: {
    semver: string
    vm: string
    agent: string
    origin?: string
  }
  [key: string]: unknown
}

export interface ScratchMonitor {
  id: string
  mode: string
  opcode: string
  params: Record<string, ScratchValue>
  spriteName?: string
  value?: ScratchValue | ScratchValue[]
  width?: number
  height?: number
  x?: number
  y?: number
  visible: boolean
  sliderMin?: number
  sliderMax?: number
  isDiscrete?: boolean
}

export interface ProjectValidationResult {
  valid: boolean
  format: 'sb3' | 'sprite3' | 'sb2' | 'sprite2' | 'unknown'
  errors: string[]
}

export interface ScratchParserValidationError {
  validationError: string
  sb2Errors: string[]
  sb3Errors: string[]
}

export interface UnpackedScratchInput {
  json: string
  archive: Record<string, Uint8Array> | null
}

export interface ParsedScratchInput {
  project: ScratchProject | ScratchTarget | Record<string, unknown>
  archive: Record<string, Uint8Array> | null
  projectVersion: 2 | 3
  format: ProjectValidationResult['format']
}

export interface VMAssetUpload {
  name: string | null
  dataFormat: DataFormat
  asset: Asset
  md5: string
  assetId: AssetId
}

export const DataFormat = {
  JPG: 'jpg',
  JSON: 'json',
  MP3: 'mp3',
  PNG: 'png',
  SB2: 'sb2',
  SB3: 'sb3',
  SVG: 'svg',
  WAV: 'wav',
} as const

export type DataFormat = (typeof DataFormat)[keyof typeof DataFormat]

export const ArgumentType = {
  ANGLE: 'angle',
  BOOLEAN: 'Boolean',
  COLOR: 'color',
  NUMBER: 'number',
  STRING: 'string',
  MATRIX: 'matrix',
  NOTE: 'note',
  IMAGE: 'image',
} as const

export const BlockType = {
  BOOLEAN: 'Boolean',
  BUTTON: 'button',
  COMMAND: 'command',
  CONDITIONAL: 'conditional',
  EVENT: 'event',
  HAT: 'hat',
  LOOP: 'loop',
  REPORTER: 'reporter',
} as const

export const TargetType = {
  SPRITE: 'sprite',
  STAGE: 'stage',
} as const

export const ReporterScope = {
  GLOBAL: 'global',
  TARGET: 'target',
} as const

export class MathUtil {
  static degToRad(deg: number): number {
    return (deg * Math.PI) / 180
  }

  static radToDeg(rad: number): number {
    return (rad * 180) / Math.PI
  }

  static clamp(n: number, min: number, max: number): number {
    return Math.min(Math.max(n, min), max)
  }

  static wrapClamp(n: number, min: number, max: number): number {
    const range = max - min + 1
    return n - Math.floor((n - min) / range) * range
  }

  static tan(angle: number): number {
    const normalized = angle % 360
    if (normalized === -270 || normalized === 90) return Infinity
    if (normalized === -90 || normalized === 270) return -Infinity
    return Number.parseFloat(Math.tan((Math.PI * normalized) / 180).toFixed(10))
  }

  static reducedSortOrdering(elements: number[]): number[] {
    const sorted = elements.slice().sort((a, b) => a - b)
    return elements.map((element) => sorted.indexOf(element))
  }

  static inclusiveRandIntWithout(lower: number, upper: number, excluded: number): number {
    const value = lower + Math.floor(Math.random() * (upper - lower))
    return value >= excluded ? value + 1 : value
  }

  static scale(input: number, inputMin: number, inputMax: number, outputMin: number, outputMax: number): number {
    return ((input - inputMin) / (inputMax - inputMin)) * (outputMax - outputMin) + outputMin
  }
}

const uidSoup = '!#%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function uid(): string {
  let id = ''
  for (let index = 0; index < 20; index += 1) id += uidSoup.charAt(Math.floor(Math.random() * uidSoup.length))
  return id
}

export function getMonitorIdForBlockWithArgs(id: string, fields: Record<string, { value?: unknown } | unknown>): string {
  let suffix = ''
  for (const [fieldKey, rawField] of Object.entries(fields)) {
    const rawValue = isObject(rawField) && 'value' in rawField ? rawField.value : rawField
    const value = fieldKey === 'CURRENTMENU' ? String(rawValue).toLowerCase() : String(rawValue)
    suffix += `_${value}`
  }
  return `${id}${suffix}`
}

export const Clone = {
  simple<T = unknown>(original: unknown): T {
    return JSON.parse(JSON.stringify(original)) as T
  },
}

export class StringUtil {
  static withoutTrailingDigits(value: string): string {
    let index = value.length - 1
    while (index >= 0 && '0123456789'.includes(value.charAt(index))) index -= 1
    return value.slice(0, index + 1)
  }

  static unusedName(name: string, existingNames: string[]): string {
    if (!existingNames.includes(name)) return name
    const base = StringUtil.withoutTrailingDigits(name)
    let index = 2
    while (existingNames.includes(`${base}${index}`)) index += 1
    return `${base}${index}`
  }

  static splitFirst(text: string, separator: string): [string, string | null] {
    const index = text.indexOf(separator)
    return index >= 0 ? [text.substring(0, index), text.substring(index + 1)] : [text, null]
  }

  static stringify(value: unknown): string {
    return JSON.stringify(value, (_key, item) => (typeof item === 'number' && (!Number.isFinite(item) || Number.isNaN(item)) ? 0 : item))
  }

  static replaceUnsafeChars(unsafe: string | string[]): string | string[] {
    if (Array.isArray(unsafe)) unsafe = String(unsafe)
    if (typeof unsafe !== 'string') return unsafe
    return unsafe.replace(/[<>&'"]/g, (char) => ({ '<': 'lt', '>': 'gt', '&': 'amp', "'": 'apos', '"': 'quot' })[char] ?? char)
  }
}

export interface MessageDescriptor {
  id: string
  default: string
  description?: string
}

export function defineMessages<T extends Record<string, MessageDescriptor>>(messages: T): T {
  return messages
}

export interface ExtensionArgumentMetadata {
  type: (typeof ArgumentType)[keyof typeof ArgumentType]
  defaultValue?: unknown
  menu?: string
}

export type ExtensionMenuItemSimple = string
export interface ExtensionMenuItemComplex {
  value: unknown
  text: string
}
export type ExtensionMenuItems = Array<ExtensionMenuItemSimple | ExtensionMenuItemComplex>
export type ExtensionMenuMetadata = string | ExtensionMenuItems

export interface ExtensionBlockMetadata {
  opcode: string
  func?: string
  blockType: (typeof BlockType)[keyof typeof BlockType]
  text: string
  hideFromPalette?: boolean
  isTerminal?: boolean
  disableMonitor?: boolean
  reporterScope?: (typeof ReporterScope)[keyof typeof ReporterScope]
  isEdgeActivated?: boolean
  shouldRestartExistingThreads?: boolean
  branchCount?: number
  arguments?: Record<string, ExtensionArgumentMetadata>
}

export interface ExtensionMetadata {
  id: string
  name?: string
  blockIconURI?: string
  menuIconURI?: string
  docsURI?: string
  blocks: Array<ExtensionBlockMetadata | string>
  menus?: Record<string, ExtensionMenuMetadata>
}

export const RequestMetadata = {
  ProjectId: 'X-Project-ID',
  RunId: 'X-Run-ID',
} as const

const fetchMetadata = new Headers()

export const scratchFetch = Object.assign(
  (resource: RequestInfo | URL, requestOptions?: RequestInit): Promise<Response> => fetch(resource, applyScratchFetchMetadata(requestOptions)),
  {
    Headers,
    RequestMetadata,
    scratchFetch(resource: RequestInfo | URL, requestOptions?: RequestInit): Promise<Response> {
      return fetch(resource, applyScratchFetchMetadata(requestOptions))
    },
    setMetadata(name: string, value: string): void {
      fetchMetadata.set(name, value)
    },
    unsetMetadata(name: string): void {
      fetchMetadata.delete(name)
    },
    deleteMetadata(name: string): void {
      fetchMetadata.delete(name)
    },
    getMetadata(name: string): string | null {
      return fetchMetadata.get(name)
    },
    clearMetadata(): void {
      for (const name of [...fetchMetadata.keys()]) fetchMetadata.delete(name)
    },
    hasMetadata(): boolean {
      return [...fetchMetadata.keys()].length > 0
    },
    applyMetadata: applyScratchFetchMetadata,
    createQueue(_queueName: string, _overrides: unknown): void {
      // The clean-room fetch facade uses the host fetch scheduler directly.
    },
  },
)

export interface ScratchAssetType {
  contentType: string
  name: string
  runtimeFormat: DataFormat
  immutable: boolean
}

export const AssetType = {
  ImageBitmap: { contentType: 'image/png', name: 'ImageBitmap', runtimeFormat: DataFormat.PNG, immutable: true },
  ImageVector: { contentType: 'image/svg+xml', name: 'ImageVector', runtimeFormat: DataFormat.SVG, immutable: true },
  Project: { contentType: 'application/json', name: 'Project', runtimeFormat: DataFormat.JSON, immutable: false },
  Sound: { contentType: 'audio/x-wav', name: 'Sound', runtimeFormat: DataFormat.WAV, immutable: true },
  Sprite: { contentType: 'application/json', name: 'Sprite', runtimeFormat: DataFormat.JSON, immutable: true },
} as const satisfies Record<string, ScratchAssetType>

export type AssetData = string | Uint8Array
export type AssetId = string | number

export class Asset {
  assetType: ScratchAssetType
  assetId?: AssetId
  data?: AssetData
  dataFormat?: DataFormat
  dependencies: Asset[] = []
  clean = true

  constructor(assetType: ScratchAssetType, assetId?: AssetId, dataFormat?: DataFormat, data?: AssetData, generateId = false) {
    this.assetType = assetType
    this.assetId = assetId
    this.setData(data, dataFormat || assetType.runtimeFormat, generateId)
  }

  setData(data: AssetData | undefined, dataFormat: DataFormat | undefined, generateId = false): void {
    if (data && !dataFormat) throw new Error('Data provided without specifying its format')
    this.data = data
    this.dataFormat = dataFormat
    if (generateId && data !== undefined) this.assetId = bytesHash(assetDataBytes(data))
    this.clean = !generateId
  }

  decodeText(): string {
    if (typeof this.data === 'string') return this.data
    return new TextDecoder().decode(this.data ?? new Uint8Array())
  }

  encodeTextData(data: string, dataFormat: DataFormat, generateId = false): void {
    this.setData(strToU8(data), dataFormat, generateId)
  }

  encodeDataURI(contentType = this.assetType.contentType): string {
    return `data:${contentType};base64,${bytesToBase64(assetDataBytes(this.data ?? new Uint8Array()))}`
  }
}

interface StorageHelper {
  load?: (assetType: ScratchAssetType, assetId: AssetId, dataFormat: DataFormat) => Promise<Asset | null> | Asset | null
  store?: (assetType: ScratchAssetType, dataFormat: DataFormat, data: AssetData, assetId?: AssetId) => Promise<unknown> | unknown
}

export class Helper implements StorageHelper {
  constructor(readonly parent?: ScratchStorage) {}

  load(assetType: ScratchAssetType, assetId: AssetId, dataFormat: DataFormat): Promise<Asset | null> {
    return Promise.reject(new Error(`No asset of type ${assetType.name} for ID ${assetId} with format ${dataFormat}`))
  }
}

export class ScratchStorage {
  readonly Asset = Asset
  readonly AssetType = AssetType
  readonly DataFormat = DataFormat
  readonly scratchFetch = scratchFetch
  defaultAssetId: Record<string, AssetId> = {}
  private assets = new Map<string, Asset>()
  private helpers: Array<{ helper: StorageHelper; priority: number }> = []

  static readonly Asset = Asset
  static readonly AssetType = AssetType
  static readonly DataFormat = DataFormat

  constructor() {
    this.registerDefaultAssets()
    this.helpers.push({ helper: this.builtinHelper(), priority: 100 })
  }

  addHelper(helper: StorageHelper, priority = 0): void {
    this.helpers.push({ helper, priority })
    this.helpers.sort((a, b) => b.priority - a.priority)
  }

  get(assetId: AssetId): Asset | null {
    return this.assets.get(String(assetId)) ?? null
  }

  cache(assetType: ScratchAssetType, dataFormat: DataFormat, data: AssetData, id: AssetId): AssetId {
    const asset = new Asset(assetType, id, dataFormat, data, assetType.immutable && !id)
    this.assets.set(String(asset.assetId ?? id), asset)
    return asset.assetId ?? id
  }

  createAsset(assetType: ScratchAssetType, dataFormat: DataFormat, data: AssetData, id?: AssetId, generateId = false): Asset {
    if (!dataFormat) throw new Error('Tried to create asset without a dataFormat')
    return new Asset(assetType, id, dataFormat, data, generateId)
  }

  setDefaultAssetId(type: ScratchAssetType, id: AssetId): void {
    this.defaultAssetId[type.name] = id
  }

  getDefaultAssetId(type: ScratchAssetType): AssetId | undefined {
    return this.defaultAssetId[type.name]
  }

  async load(assetType: ScratchAssetType, assetId: AssetId, dataFormat = assetType.runtimeFormat): Promise<Asset | null> {
    const errors: unknown[] = []
    for (const { helper } of this.helpers) {
      if (!helper.load) continue
      try {
        const result = await helper.load(assetType, assetId, dataFormat)
        if (result) return result
      } catch (error) {
        errors.push(error)
      }
    }
    const fallback = this.defaultAssetId[assetType.name]
    if (fallback !== undefined && fallback !== assetId) return this.load(assetType, fallback, dataFormat)
    if (errors.length) throw errors
    return null
  }

  async store(assetType: ScratchAssetType, dataFormat: DataFormat | null | undefined, data: AssetData, assetId?: AssetId): Promise<{ id: AssetId; asset: Asset }> {
    const format = dataFormat || assetType.runtimeFormat
    for (const { helper } of this.helpers) {
      if (!helper.store) continue
      await helper.store(assetType, format, data, assetId)
    }
    const asset = new Asset(assetType, assetId, format, data, assetId === undefined && assetType.immutable)
    const id = asset.assetId ?? assetId ?? bytesHash(assetDataBytes(data))
    asset.assetId = id
    this.assets.set(String(id), asset)
    return { id, asset }
  }

  listAssets(): string[] {
    return [...this.assets.keys()]
  }

  addWebStore(): void {
    // Network-backed stores are intentionally left to host applications through addHelper.
  }

  addWebSource(): void {
    this.addWebStore()
  }

  private builtinHelper(): StorageHelper {
    return {
      load: (_assetType, assetId) => this.get(assetId),
      store: (assetType, dataFormat, data, assetId) => {
        const asset = new Asset(assetType, assetId, dataFormat, data, assetId === undefined && assetType.immutable)
        const id = asset.assetId ?? assetId ?? bytesHash(assetDataBytes(data))
        asset.assetId = id
        this.assets.set(String(id), asset)
        return { id }
      },
    }
  }

  private registerDefaultAssets(): void {
    this.cache(AssetType.ImageVector, DataFormat.SVG, strToU8(defaultSpriteSvg), 'default-sprite')
    this.cache(AssetType.ImageBitmap, DataFormat.PNG, new Uint8Array(), 'default-bitmap')
    this.cache(AssetType.Sound, DataFormat.WAV, new Uint8Array(placeholderWav), 'default-sound')
    this.setDefaultAssetId(AssetType.ImageVector, 'default-sprite')
    this.setDefaultAssetId(AssetType.ImageBitmap, 'default-bitmap')
    this.setDefaultAssetId(AssetType.Sound, 'default-sound')
  }
}

export interface RuntimeSnapshot {
  project: ScratchProject
  selectedTargetId: string
  origin: string | null
  running: boolean
  turboMode: boolean
  compatibilityMode: boolean
  threads: ThreadSnapshot[]
}

export interface PenLine {
  x1: number
  y1: number
  x2: number
  y2: number
  color: string
  size: number
  transparency: number
}

export interface WorkspaceChange {
  blocks?: Record<string, ScratchBlock>
}

type ScratchCanvasHost = HTMLCanvasElement | OffscreenCanvas
type ScratchCanvas2DContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
type ScratchCostumeImage = HTMLImageElement | ImageBitmap
type ResolvedCostumeImage = { image: ScratchCostumeImage; costume: ScratchCostume | undefined }
type CostumeImageResolver = (costume: ScratchCostume | undefined, target?: ScratchTarget) => ResolvedCostumeImage | undefined

const SCRATCH_STAGE_WIDTH = 480
const SCRATCH_STAGE_HEIGHT = 360

export interface RendererFacade {
  attachCanvas?: (canvas: ScratchCanvasHost) => void
  resize?: (width: number, height: number) => void
  requestDraw?: (snapshot: RuntimeSnapshot) => void
  setAssetResolver?: (resolver: (assetId: string, dataFormat?: string) => Promise<Uint8Array | undefined>) => void
  pick?: (x: number, y: number, touchWidth?: number, touchHeight?: number, candidateIds?: string[]) => string | null
  getBounds?: (drawableIdOrName: string | number) => ScratchBounds | null
  isTouchingDrawables?: (drawableIdOrName: string | number, candidateIds?: string[]) => boolean
  drawableTouchingScratchPoint?: (drawableIdOrName: string | number, x: number, y: number) => boolean
  drawableTouchingScratchRect?: (drawableIdOrName: string | number, left: number, top: number, right: number, bottom: number) => boolean
  isTouchingColor?: (drawableIdOrName: string | number, color: { r: number; g: number; b: number; a: number }) => boolean
  isColorTouchingColor?: (drawableIdOrName: string | number, color: { r: number; g: number; b: number; a: number }, touchingColor: { r: number; g: number; b: number; a: number }) => boolean
  getFencedPositionOfDrawable?: (drawableIdOrName: string | number, position: [number, number]) => [number, number]
  sampleColor?: (x: number, y: number) => { r: number; g: number; b: number; a: number }
  penClear?: () => void
  penLine?: (line: PenLine) => void
  penStamp?: (target: ScratchTarget) => void
  createThumbnail?: (targetId?: string) => Promise<Blob | Uint8Array>
  clearCachedCostumes?: () => void
  dispose?: () => void
}

export interface ScratchBounds {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export interface StorageFacade {
  loadAsset?: (assetId: string, dataFormat: string) => Promise<Uint8Array | undefined>
  storeAsset?: (data: Uint8Array, dataFormat: string) => Promise<{ assetId: string; md5ext: string }>
  deleteAsset?: (assetId: string) => Promise<void>
  listAssets?: () => Promise<string[]>
}

export interface ExtensionManagerFacade {
  isExtensionLoaded: (idOrUrl: string) => boolean
  loadExtensionIdSync: (id: string) => void
  loadExtensionURL: (idOrUrl: string) => Promise<void>
  refreshBlocks: () => void
  getLoadedExtensions: () => string[]
  allocateWorker?: () => unknown
  registerExtensionServiceSync?: (serviceName: string) => string
  registerExtensionService?: (serviceName: string) => Promise<string>
  onWorkerInit?: (id: string, event?: unknown) => void
  _registerInternalExtension?: (extensionObject: unknown) => string
  _registerExtensionInfo?: (serviceName: string, extensionInfo: ExtensionMetadata) => ExtensionMetadata
  _sanitizeID?: (text: string) => string
  _prepareExtensionInfo?: (serviceName: string, extensionInfo: ExtensionMetadata) => ExtensionMetadata
  _prepareMenuInfo?: (serviceName: string, menus?: Record<string, ExtensionMenuMetadata>) => Record<string, ExtensionMenuMetadata>
  _getExtensionMenuItems?: (extensionObject: unknown, menuItemFunctionName: string) => ExtensionMenuItems
  _prepareBlockInfo?: (serviceName: string, blockInfo: ExtensionBlockMetadata) => ExtensionBlockMetadata
}

export interface ThreadSnapshot {
  targetName: string
  topBlockId: string
  currentBlockId: string | null
  status: 'running' | 'waiting' | 'done'
}

type Listener<T = unknown> = (payload: T, ...args: unknown[]) => void
type CompiledReporter = (target: ScratchTarget) => ScratchValue
type HatEntry = { target: ScratchTarget; id: string; block: ScratchBlock }
type StatementInfo = {
  variableId?: string
  listId?: string
  value?: CompiledReporter
  index?: CompiledReporter
  item?: CompiledReporter
  condition?: CompiledReporter
}

interface RuntimeThread {
  target: ScratchTarget
  topBlockId: string
  currentBlockId: string | null
  waitUntil: number
  waitingBlockId?: string
  waitingBroadcastBlockId?: string
  waitingSoundBlockId?: string
  waitingSoundDone?: boolean
  waitingSoundUntil?: number
  waitingAnswer?: boolean
  waitingFor?: RuntimeThread[]
  glide?: { blockId: string; startTime: number; duration: number; startX: number; startY: number; endX: number; endY: number }
  stack: RuntimeStackFrame[]
  callStack: Array<{ returnTo: string | null; args: Record<string, ScratchValue>; warp?: boolean }>
  warpDepth: number
  procArgs: Record<string, ScratchValue>
  done: boolean
}

type RuntimeStackFrame =
  | { kind: 'loop'; blockId: string; remaining: number; callDepth: number; until?: boolean; forEach?: { variable: string; index: number; total: number } }
  | { kind: 'continuation'; returnTo: string | null; callDepth: number }

const defaultSpriteSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="40" fill="#ffab19"/></svg>'
const emptyStageBackdropSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360" viewBox="0 0 480 360"></svg>'
const THREAD_STEP_BUDGET = 256
const WARP_THREAD_STEP_BUDGET = 100000

const stageCostume: ScratchCostume = {
  name: 'backdrop1',
  dataFormat: 'svg',
  assetId: 'default-backdrop',
  md5ext: 'default-backdrop.svg',
  rotationCenterX: 240,
  rotationCenterY: 180,
}

const spriteCostume: ScratchCostume = {
  name: 'costume1',
  dataFormat: 'svg',
  assetId: 'default-sprite',
  md5ext: 'default-sprite.svg',
  rotationCenterX: 48,
  rotationCenterY: 50,
}

export const blockPalette = [
  { category: 'motion', color: '#4c97ff', opcodes: ['motion_movesteps', 'motion_turnright', 'motion_turnleft', 'motion_pointindirection', 'motion_pointtowards', 'motion_goto', 'motion_gotoxy', 'motion_glideto', 'motion_glidesecstoxy', 'motion_changexby', 'motion_changeyby', 'motion_setx', 'motion_sety', 'motion_ifonedgebounce', 'motion_setrotationstyle', 'motion_xposition', 'motion_yposition', 'motion_direction'] },
  { category: 'looks', color: '#9966ff', opcodes: ['looks_say', 'looks_sayforsecs', 'looks_think', 'looks_thinkforsecs', 'looks_switchcostumeto', 'looks_nextcostume', 'looks_switchbackdropto', 'looks_switchbackdroptoandwait', 'looks_nextbackdrop', 'looks_changeeffectby', 'looks_seteffectto', 'looks_cleargraphiceffects', 'looks_changesizeby', 'looks_setsizeto', 'looks_size', 'looks_costumenumbername', 'looks_backdropnumbername', 'looks_gotofrontback', 'looks_goforwardbackwardlayers', 'looks_show', 'looks_hide'] },
  { category: 'sound', color: '#cf63cf', opcodes: ['sound_play', 'sound_playuntildone', 'sound_stopallsounds', 'sound_changeeffectby', 'sound_seteffectto', 'sound_cleareffects', 'sound_changevolumeby', 'sound_setvolumeto', 'sound_volume', 'sound_sounds_menu', 'sound_beats_menu', 'sound_effects_menu'] },
  { category: 'events', color: '#ffbf00', opcodes: ['event_whenflagclicked', 'event_whenkeypressed', 'event_whenthisspriteclicked', 'event_whentouchingobject', 'event_whenbackdropswitchesto', 'event_whengreaterthan', 'event_whenbroadcastreceived', 'event_broadcast', 'event_broadcastandwait'] },
  { category: 'control', color: '#ffab19', opcodes: ['control_wait', 'control_wait_until', 'control_repeat', 'control_repeat_until', 'control_while', 'control_for_each', 'control_forever', 'control_if', 'control_if_else', 'control_stop', 'control_start_as_clone', 'control_create_clone_of', 'control_delete_this_clone', 'control_get_counter', 'control_incr_counter', 'control_clear_counter', 'control_all_at_once'] },
  { category: 'sensing', color: '#5cb1d6', opcodes: ['sensing_askandwait', 'sensing_touchingobject', 'sensing_touchingcolor', 'sensing_coloristouchingcolor', 'sensing_distanceto', 'sensing_keypressed', 'sensing_mousedown', 'sensing_mousex', 'sensing_mousey', 'sensing_setdragmode', 'sensing_loudness', 'sensing_loud', 'sensing_timer', 'sensing_of', 'sensing_answer', 'sensing_resettimer', 'sensing_current', 'sensing_dayssince2000', 'sensing_online', 'sensing_username'] },
  { category: 'operators', color: '#59c059', opcodes: ['operator_add', 'operator_subtract', 'operator_multiply', 'operator_divide', 'operator_random', 'operator_equals', 'operator_gt', 'operator_lt', 'operator_and', 'operator_or', 'operator_not', 'operator_join', 'operator_letter_of', 'operator_length', 'operator_contains', 'operator_mod', 'operator_round', 'operator_mathop'] },
  { category: 'variables', color: '#ff8c1a', opcodes: ['data_variable', 'data_setvariableto', 'data_changevariableby', 'data_showvariable', 'data_hidevariable', 'data_listcontents', 'data_addtolist', 'data_deleteoflist', 'data_deletealloflist', 'data_insertatlist', 'data_replaceitemoflist', 'data_itemoflist', 'data_itemnumoflist', 'data_lengthoflist', 'data_listcontainsitem', 'data_showlist', 'data_hidelist'] },
  { category: 'my blocks', color: '#ff6680', opcodes: ['procedures_definition', 'procedures_call', 'argument_reporter_string_number', 'argument_reporter_boolean'] },
  { category: 'extensions', color: '#0fbd8c', opcodes: ['pen_clear', 'pen_stamp', 'pen_penDown', 'pen_penUp', 'pen_setPenColorToColor', 'pen_changePenColorParamBy', 'pen_setPenColorParamTo', 'pen_changePenSizeBy', 'pen_setPenSizeTo', 'pen_setPenHueToNumber', 'pen_changePenHueBy', 'pen_setPenShadeToNumber', 'pen_changePenShadeBy', 'music_playDrumForBeats', 'music_midiPlayDrumForBeats', 'music_restForBeats', 'music_playNoteForBeats', 'music_setInstrument', 'music_midiSetInstrument', 'music_setTempo', 'music_changeTempo', 'music_getTempo', 'videoSensing_whenMotionGreaterThan', 'videoSensing_videoOn', 'videoSensing_videoToggle', 'videoSensing_setVideoTransparency', 'translate_getTranslate', 'translate_getViewerLanguage', 'text2speech_speakAndWait', 'text2speech_setVoice', 'text2speech_setLanguage', 'speech2text_listenAndWait', 'speech2text_whenIHearHat', 'speech2text_getSpeech', 'makeymakey_whenMakeyKeyPressed', 'makeymakey_whenCodePressed', 'microbit_whenButtonPressed', 'microbit_isButtonPressed', 'microbit_whenGesture', 'microbit_displaySymbol', 'microbit_displayText', 'microbit_displayClear', 'microbit_whenTilted', 'microbit_isTilted', 'microbit_getTiltAngle', 'microbit_whenPinConnected', 'ev3_motorTurnClockwise', 'ev3_motorTurnCounterClockwise', 'ev3_motorSetPower', 'ev3_getMotorPosition', 'ev3_whenButtonPressed', 'ev3_whenDistanceLessThan', 'ev3_whenBrightnessLessThan', 'ev3_buttonPressed', 'ev3_getDistance', 'ev3_getBrightness', 'ev3_beep', 'wedo2_motorOnFor', 'wedo2_motorOn', 'wedo2_motorOff', 'wedo2_startMotorPower', 'wedo2_setMotorDirection', 'wedo2_setLightHue', 'wedo2_playNoteFor', 'wedo2_whenDistance', 'wedo2_whenTilted', 'wedo2_getDistance', 'wedo2_isTilted', 'wedo2_getTiltAngle', 'boost_motorOnFor', 'boost_motorOnForRotation', 'boost_motorOn', 'boost_motorOff', 'boost_setMotorPower', 'boost_setMotorDirection', 'boost_getMotorPosition', 'boost_whenTilted', 'boost_isTilted', 'boost_getTiltAngle', 'boost_whenColor', 'boost_seeingColor', 'boost_setLightHue', 'gdxfor_whenForcePushedOrPulled', 'gdxfor_getForce', 'gdxfor_whenGesture', 'gdxfor_whenTilted', 'gdxfor_isTilted', 'gdxfor_getTilt', 'gdxfor_getSpinSpeed', 'gdxfor_getAcceleration', 'gdxfor_isFreeFalling', 'faceSensing_whenFaceDetected', 'faceSensing_faceIsDetected', 'faceSensing_faceSize', 'faceSensing_setSizeToFaceSize', 'faceSensing_faceTilt', 'faceSensing_whenTilted', 'faceSensing_pointInFaceTiltDirection', 'faceSensing_goToPart', 'faceSensing_whenSpriteTouchesPart'] },
] as const

export class ScratchVM {
  static readonly STAGE_WIDTH = 480
  static readonly STAGE_HEIGHT = 360
  readonly extensionManager: ExtensionManagerFacade
  readonly runtime: {
    ioDevices: {
      cloud: { postData: (data: unknown) => void; setProvider: (provider: unknown) => void; setStage: (stage: ScratchTarget | undefined) => void }
      video: { postData: (data: unknown) => void; setProvider: (provider: unknown) => void }
      mouse: { postData: (data: unknown) => void }
      keyboard: { postData: (data: unknown) => void }
      mouseWheel: { postData: (data: unknown) => void }
    }
    targets: ScratchTarget[]
    executableTargets: ScratchTarget[]
    threads: ThreadSnapshot[]
    origin: string | null
    STAGE_WIDTH: number
    STAGE_HEIGHT: number
    turboMode: boolean
    compatibilityMode: boolean
    hasCloudData: () => boolean
    canAddCloudVariable: () => boolean
    addCloudVariable: () => void
    removeCloudVariable: () => void
    getMonitorState: () => Map<string, ScratchMonitor>
    makeMessageContextForTarget: (target?: ScratchTarget) => Record<string, unknown>
    getBlocksXML: (target?: ScratchTarget) => string
    getBlocksJSON: () => readonly unknown[]
    getScratchLinkSocket: (type: string) => unknown
    configureScratchLinkSocketFactory: (factory: unknown) => void
    registerPeripheralExtension: (extensionId: string, extension: unknown) => void
    scanForPeripheral: (extensionId: string) => void
    connectPeripheral: (extensionId: string, peripheralId: string) => void
    disconnectPeripheral: (extensionId: string) => void
    getPeripheralIsConnected: (extensionId: string) => boolean
    emitMicListening: (listening: boolean) => void
    emitExtensionLoading: (loading: boolean) => void
    getOpcodeFunction: (opcode: string) => ((args?: unknown, util?: unknown) => unknown) | undefined
    getIsHat: (opcode: string) => boolean
    getIsEdgeActivatedHat: (opcode: string) => boolean
    addTarget: (target: ScratchTarget | unknown) => ScratchTarget | undefined
    dispose: () => void
    disposeTarget: (target: ScratchTarget | string) => void
    emitProjectChanged: () => void
    fireTargetWasCreated: (target: ScratchTarget | unknown) => void
    fireTargetWasRemoved: (target: ScratchTarget | unknown) => void
    handleProjectLoaded: () => RuntimeSnapshot
    getTargetById: (id: string) => ScratchTarget | undefined
    getSpriteTargetByName: (name: string) => ScratchTarget | undefined
    getTargetByDrawableId: (drawableId: number | string) => ScratchTarget | undefined
    getTargetForStage: () => ScratchTarget | undefined
    getEditingTarget: () => ScratchTarget | undefined
    createNewGlobalVariable: (name: string, type?: string, isCloud?: boolean) => string
    getAllVarNamesOfType: (type?: string) => string[]
    startHats: (opcode: string, matchFields?: Record<string, unknown>, target?: ScratchTarget | string) => ThreadSnapshot[]
    toggleScript: (topBlockId: string, target?: ScratchTarget | string) => ThreadSnapshot | undefined
    stopForTarget: (target: ScratchTarget | string) => void
    isActiveThread: (thread: unknown) => boolean
    isWaitingThread: (thread: unknown) => boolean
    allScriptsDo: (callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string) => void
    allScriptsByOpcodeDo: (opcode: string, callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string) => void
    addMonitorScript: (topBlockId: string, target?: ScratchTarget | string) => ThreadSnapshot | undefined
    setExecutablePosition: (target: ScratchTarget | string, index: number) => void
    moveExecutable: (target: ScratchTarget | string, index: number) => void
    removeExecutable: (target: ScratchTarget | string) => void
    clonesAvailable: () => boolean
    changeCloneCounter: (delta: number) => number
    requestTargetsUpdate: (shouldEmitProjectChanged?: boolean) => void
    requestRedraw: () => void
    requestRemoveMonitorByTargetId: (targetId: string) => void
    resetRunId: () => string
    getLabelForOpcode: (opcode: string) => string
    attachAudioEngine: (audioEngine: unknown) => void
    attachRenderer: (renderer: RendererFacade) => void
    attachV2BitmapAdapter: (bitmapAdapter: unknown) => void
    attachStorage: (storage: StorageFacade) => void
    on: <T = unknown>(event: string, listener: Listener<T>) => () => void
    addListener: <T = unknown>(event: string, listener: Listener<T>) => ScratchVM
    off: <T = unknown>(event: string, listener: Listener<T>) => void
    removeListener: <T = unknown>(event: string, listener: Listener<T>) => ScratchVM
    removeAllListeners: (event?: string) => ScratchVM
    once: <T = unknown>(event: string, listener: Listener<T>) => ScratchVM
    emit: <T = unknown>(event: string, payload: T, ...args: unknown[]) => void
    start: () => void
    quit: () => void
    greenFlag: () => void
    stopAll: () => void
    setCompatibilityMode: (enabled: boolean) => void
    setEditingTarget: (target: ScratchTarget | string | null | undefined) => void
  }
  private project: ScratchProject = createDefaultProject()
  private listeners = new Map<string, Set<Listener>>()
  private threads: RuntimeThread[] = []
  private selectedTargetId = 'sprite1'
  private running = false
  private turboMode = false
  private compatibilityMode = false
  private renderer?: RendererFacade
  private audioEngine?: unknown
  private storage?: StorageFacade
  private svgAdapter?: unknown
  private bitmapAdapter?: unknown
  private assetBytes = new Map<string, Uint8Array>()
  private ioData = new Map<string, unknown>()
  private pressedKeys = new Set<string>()
  private variableLookupCache = new WeakMap<ScratchTarget, Map<string, string>>()
  private listLookupCache = new WeakMap<ScratchTarget, Map<string, string>>()
  private reporterCache = new WeakMap<ScratchBlock, CompiledReporter | null>()
  private statementCache = new WeakMap<ScratchBlock, StatementInfo>()
  private procedureCache = new WeakMap<ScratchTarget, Map<string, ProcedureInfo | null>>()
  private hatCache = new Map<string, HatEntry[]>()
  private runtimeStepActive = false
  private runtimeTargetsChanged = false
  private runtimeLayerOrderDirty = false
  private greaterThanHatState = new Map<string, boolean>()
  private touchingHatState = new Map<string, boolean>()
  private extensionHatState = new Map<string, boolean>()
  private promptAnswer = ''
  private timerStart = Date.now()
  private runtimeCounter = 0
  private lastStep = Date.now()
  private stopAllGeneration = 0
  private currentThread?: RuntimeThread
  private stationaryPenDown = new WeakMap<ScratchTarget, { x: number; y: number; moved: boolean }>()
  private locale = 'en'
  private localeMessages: Record<string, unknown> = {}
  private cloudProvider?: unknown
  private videoProvider?: unknown
  private scratchLinkSocketFactory?: unknown
  private registeredPeripheralExtensions = new Map<string, unknown>()
  private extensionServices = new Map<string, unknown>()
  private peripheralState = new Map<string, { scanning: boolean; connected: boolean; peripheralId?: string }>()
  private draggingTargetId?: string
  private compilerOptions: Record<string, unknown> = {}
  private origin: string | null = null
  private blockGlowIds = new Set<string>()
  private scriptGlowIds = new Set<string>()

  constructor() {
    const thisVM = this
    this.extensionManager = {
      isExtensionLoaded: (idOrUrl: string) => this.project.extensions.includes(normalizeExtensionId(idOrUrl)),
      loadExtensionIdSync: (id: string) => {
        this.loadExtension(normalizeExtensionId(id))
      },
      loadExtensionURL: async (idOrUrl: string) => {
        this.loadExtension(normalizeExtensionId(idOrUrl))
      },
      refreshBlocks: () => this.requestToolboxExtensionsUpdate(),
      getLoadedExtensions: () => [...this.project.extensions],
      allocateWorker: () => ({ postMessage: () => undefined, terminate: () => undefined }),
      registerExtensionServiceSync: (serviceName: string) => {
        this.extensionServices.set(serviceName, {})
        return serviceName
      },
      registerExtensionService: async (serviceName: string) => {
        this.extensionServices.set(serviceName, {})
        return serviceName
      },
      onWorkerInit: (id: string, event?: unknown) => {
        this.emit('EXTENSION_WORKER_INIT', { id, event })
      },
      _registerInternalExtension: (extensionObject: unknown) => {
        const info = isObject(extensionObject) && typeof extensionObject.getInfo === 'function' ? extensionObject.getInfo() : extensionObject
        const id = isObject(info) && typeof info.id === 'string' ? normalizeExtensionId(info.id) : `extension${this.extensionServices.size + 1}`
        this.extensionServices.set(id, extensionObject)
        this.loadExtension(id)
        return id
      },
      _registerExtensionInfo: (serviceName: string, extensionInfo: ExtensionMetadata) => {
        this.extensionServices.set(serviceName, extensionInfo)
        this.loadExtension(extensionInfo.id)
        return extensionInfo
      },
      _sanitizeID: (text: string) => String(text).replace(/[^a-z0-9]/gi, ''),
      _prepareExtensionInfo: (_serviceName: string, extensionInfo: ExtensionMetadata) => ({ ...extensionInfo, id: String(extensionInfo.id).replace(/[^a-z0-9]/gi, '') }),
      _prepareMenuInfo: (_serviceName: string, menus: Record<string, ExtensionMenuMetadata> = {}) => menus,
      _getExtensionMenuItems: (extensionObject: unknown, menuItemFunctionName: string) => {
        const value = isObject(extensionObject) && typeof extensionObject[menuItemFunctionName] === 'function' ? extensionObject[menuItemFunctionName]() : []
        return Array.isArray(value) ? value : []
      },
      _prepareBlockInfo: (_serviceName: string, blockInfo: ExtensionBlockMetadata) => blockInfo,
    }
    this.runtime = {
      ioDevices: {
        cloud: {
          postData: (data: unknown) => this.handleCloudData(data),
          setProvider: (provider: unknown) => this.setCloudProvider(provider),
          setStage: (_stage: ScratchTarget | undefined) => undefined,
        },
        video: {
          postData: (data: unknown) => this.postIOData('video', data),
          setProvider: (provider: unknown) => this.setVideoProvider(provider),
        },
        mouse: {
          postData: (data: unknown) => this.postMouse(data),
        },
        keyboard: {
          postData: (data: unknown) => this.postKeyboard(data),
        },
        mouseWheel: {
          postData: (data: unknown) => this.postWheel(data),
        },
      },
      get targets() {
        return thisVM.project.targets
      },
      get executableTargets() {
        return thisVM.project.targets.filter((target) => !target.isStage)
      },
      get threads() {
        return thisVM.snapshot().threads
      },
      get origin() {
        return thisVM.origin
      },
      get STAGE_WIDTH() {
        return ScratchVM.STAGE_WIDTH
      },
      get STAGE_HEIGHT() {
        return ScratchVM.STAGE_HEIGHT
      },
      get turboMode() {
        return thisVM.turboMode
      },
      set turboMode(value: boolean) {
        thisVM.setTurboMode(value)
      },
      get compatibilityMode() {
        return thisVM.compatibilityMode
      },
      set compatibilityMode(value: boolean) {
        thisVM.setCompatibilityMode(value)
      },
      hasCloudData: () => this.hasCloudData(),
      canAddCloudVariable: () => this.canAddCloudVariable(),
      addCloudVariable: () => this.emit('HAS_CLOUD_DATA_UPDATE', true),
      removeCloudVariable: () => this.emit('HAS_CLOUD_DATA_UPDATE', this.hasCloudData()),
      getMonitorState: () => new Map(this.project.monitors.map((monitor) => [monitor.id, structuredClone(monitor)])),
      makeMessageContextForTarget: (target?: ScratchTarget) => ({ locale: this.locale, messages: this.localeMessages, target }),
      getBlocksXML: (target?: ScratchTarget) => this.blocksXml(target ?? this.getSelectedTarget()),
      getBlocksJSON: () => this.getToolbox(),
      getScratchLinkSocket: (type: string) => this.getScratchLinkSocket(type),
      configureScratchLinkSocketFactory: (factory: unknown) => this.configureScratchLinkSocketFactory(factory),
      registerPeripheralExtension: (extensionId: string, extension: unknown) => this.registerPeripheralExtension(extensionId, extension),
      scanForPeripheral: (extensionId: string) => this.scanForPeripheral(extensionId),
      connectPeripheral: (extensionId: string, peripheralId: string) => this.connectPeripheral(extensionId, peripheralId),
      disconnectPeripheral: (extensionId: string) => this.disconnectPeripheral(extensionId),
      getPeripheralIsConnected: (extensionId: string) => this.getPeripheralIsConnected(extensionId),
      emitMicListening: (listening: boolean) => this.emit('MIC_LISTENING', listening),
      emitExtensionLoading: (loading: boolean) => this.emit('EXTENSION_DATA_LOADING', loading),
      getOpcodeFunction: (opcode: string) => this.getOpcodeFunction(opcode),
      getIsHat: (opcode: string) => this.getIsHat(opcode),
      getIsEdgeActivatedHat: (opcode: string) => this.getIsEdgeActivatedHat(opcode),
      addTarget: (target: ScratchTarget | unknown) => this.addTarget(target),
      dispose: () => this.disposeRuntime(),
      disposeTarget: (target: ScratchTarget | string) => this.disposeTarget(target),
      emitProjectChanged: () => this.emitProjectChanged(),
      fireTargetWasCreated: (target: ScratchTarget | unknown) => this.fireTargetWasCreated(target),
      fireTargetWasRemoved: (target: ScratchTarget | unknown) => this.fireTargetWasRemoved(target),
      handleProjectLoaded: () => this.handleProjectLoaded(),
      getTargetById: (id: string) => this.getTarget(id),
      getSpriteTargetByName: (name: string) => this.getSprites().find((target) => target.name === name),
      getTargetByDrawableId: (drawableId: number | string) => this.getTargetByDrawableId(drawableId),
      getTargetForStage: () => this.getStage(),
      getEditingTarget: () => this.getSelectedTarget(),
      createNewGlobalVariable: (name: string, type = '', isCloud = false) => this.createNewGlobalVariable(name, type, isCloud),
      getAllVarNamesOfType: (type = '') => this.getAllVarNamesOfType(type),
      startHats: (opcode: string, matchFields: Record<string, unknown> = {}, target?: ScratchTarget | string) => this.startRuntimeHats(opcode, matchFields, target),
      toggleScript: (topBlockId: string, target?: ScratchTarget | string) => this.toggleScript(topBlockId, target),
      stopForTarget: (target: ScratchTarget | string) => this.stopForTarget(target),
      isActiveThread: (thread: unknown) => this.isActiveThread(thread),
      isWaitingThread: (thread: unknown) => this.isWaitingThread(thread),
      allScriptsDo: (callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string) => this.allScriptsDo(callback, target),
      allScriptsByOpcodeDo: (opcode: string, callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string) => this.allScriptsByOpcodeDo(opcode, callback, target),
      addMonitorScript: (topBlockId: string, target?: ScratchTarget | string) => this.addMonitorScript(topBlockId, target),
      setExecutablePosition: (target: ScratchTarget | string, index: number) => this.setExecutablePosition(target, index),
      moveExecutable: (target: ScratchTarget | string, index: number) => this.moveExecutable(target, index),
      removeExecutable: (target: ScratchTarget | string) => this.removeExecutable(target),
      clonesAvailable: () => this.clonesAvailable(),
      changeCloneCounter: (delta: number) => this.changeCloneCounter(delta),
      requestTargetsUpdate: (shouldEmitProjectChanged = false) => this.requestTargetsUpdate(shouldEmitProjectChanged),
      requestRedraw: () => this.requestRedraw(),
      requestRemoveMonitorByTargetId: (targetId: string) => this.requestRemoveMonitorByTargetId(targetId),
      resetRunId: () => this.resetRunId(),
      getLabelForOpcode: (opcode: string) => this.getLabelForOpcode(opcode),
      attachAudioEngine: (audioEngine: unknown) => this.attachAudioEngine(audioEngine),
      attachRenderer: (renderer: RendererFacade) => this.attachRenderer(renderer),
      attachV2BitmapAdapter: (bitmapAdapter: unknown) => this.attachV2BitmapAdapter(bitmapAdapter),
      attachStorage: (storage: StorageFacade) => this.attachStorage(storage),
      on: <T = unknown>(event: string, listener: Listener<T>) => this.on(event, listener),
      addListener: <T = unknown>(event: string, listener: Listener<T>) => this.addListener(event, listener),
      off: <T = unknown>(event: string, listener: Listener<T>) => this.off(event, listener),
      removeListener: <T = unknown>(event: string, listener: Listener<T>) => this.removeListener(event, listener),
      removeAllListeners: (event?: string) => this.removeAllListeners(event),
      once: <T = unknown>(event: string, listener: Listener<T>) => this.once(event, listener),
      emit: <T = unknown>(event: string, payload: T, ...args: unknown[]) => this.emit(event, payload, ...args),
      start: () => this.start(),
      quit: () => this.quit(),
      greenFlag: () => this.greenFlag(),
      stopAll: () => this.stopAll(),
      setCompatibilityMode: (enabled: boolean) => this.setCompatibilityMode(enabled),
      setEditingTarget: (target: ScratchTarget | string | null | undefined) => this.setEditingTarget(target),
    }
    this.seedDefaultAssetBytes()
  }

  on<T = unknown>(event: string, listener: Listener<T>): () => void {
    const bucket = this.listeners.get(event) ?? new Set()
    bucket.add(listener as Listener)
    this.listeners.set(event, bucket)
    return () => bucket.delete(listener as Listener)
  }

  addListener<T = unknown>(event: string, listener: Listener<T>): this {
    this.on(event, listener)
    return this
  }

  once<T = unknown>(event: string, listener: Listener<T>): this {
    const unsubscribe = this.on<T>(event, (payload, ...args) => {
      unsubscribe()
      listener(payload, ...args)
    })
    return this
  }

  off<T = unknown>(event: string, listener: Listener<T>): void {
    this.listeners.get(event)?.delete(listener as Listener)
  }

  removeListener<T = unknown>(event: string, listener: Listener<T>): this {
    this.off(event, listener)
    return this
  }

  removeAllListeners(event?: string): this {
    if (event) this.listeners.delete(event)
    else this.listeners.clear()
    return this
  }

  emit<T = unknown>(event: string, payload: T, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload, ...args)
    if (this.hasEventAliasListeners(event)) {
      for (const alias of this.eventAliasPayloads(event, payload, args)) {
        for (const listener of this.listeners.get(alias.event) ?? []) listener(alias.payload, ...alias.args)
      }
    }
    if (this.shouldRenderAfterEvent(event, payload)) this.renderer?.requestDraw?.(isRuntimeSnapshot(payload) ? payload : this.snapshot())
  }

  private hasEventListeners(event: string): boolean {
    return (this.listeners.get(event)?.size ?? 0) > 0
  }

  private hasEventAliasListeners(event: string): boolean {
    const aliases: Record<string, string[]> = {
      TARGETS_UPDATE: ['targetsUpdate'],
      WORKSPACE_UPDATE: ['workspaceUpdate'],
      PROJECT_LOADED: ['projectLoaded'],
      PROJECT_CHANGED: ['projectChanged'],
      MONITORS_UPDATE: ['monitorsUpdate'],
      BLOCKS_NEED_UPDATE: ['blocksNeedUpdate'],
      TARGET_WAS_CREATED: ['targetWasCreated'],
      TARGET_WAS_REMOVED: ['targetWasRemoved'],
    }
    return aliases[event]?.some((alias) => this.hasEventListeners(alias)) ?? false
  }

  private shouldRenderAfterEvent(event: string, payload?: unknown): boolean {
    if (event === 'RUNTIME_DISPOSED' || event === 'RUNTIME_STEP') return false
    if (this.runtimeStepActive) return false
    if (event === 'TARGETS_UPDATE' && isRuntimeSnapshot(payload) && payload.running) return false
    return !['PEN_CLEAR', 'PEN_STAMP', 'SOUND_PLAYED', 'SOUNDS_STOPPED', 'TEXT_TO_SPEECH', 'EXTENSION_ACTUATOR', 'EXTENSION_DISPLAY'].includes(event)
  }

  private eventAliasPayloads(event: string, payload: unknown, args: unknown[] = []): Array<{ event: string; payload: unknown; args: unknown[] }> {
    if (event === 'TARGETS_UPDATE') {
      return [
        {
          event: 'targetsUpdate',
          payload: {
            targetList: this.project.targets.map((target) => structuredClone(target)),
            editingTarget: structuredClone(this.getSelectedTarget()),
            snapshot: payload,
          },
          args: [],
        },
      ]
    }
    if (event === 'WORKSPACE_UPDATE') {
      return [{ event: 'workspaceUpdate', payload: { xml: this.blocksXml(this.getSelectedTarget()), snapshot: payload }, args: [] }]
    }
    if (event === 'PROJECT_LOADED') return [{ event: 'projectLoaded', payload, args }]
    if (event === 'PROJECT_CHANGED') return [{ event: 'projectChanged', payload, args }]
    if (event === 'MONITORS_UPDATE') return [{ event: 'monitorsUpdate', payload, args }]
    if (event === 'BLOCKS_NEED_UPDATE') return [{ event: 'blocksNeedUpdate', payload, args }]
    if (event === 'TARGET_WAS_CREATED') return [{ event: 'targetWasCreated', payload, args }]
    if (event === 'TARGET_WAS_REMOVED') return [{ event: 'targetWasRemoved', payload, args }]
    return []
  }

  private seedDefaultAssetBytes(): void {
    const backdropSvg = strToU8(emptyStageBackdropSvg)
    const spriteSvg = strToU8(defaultSpriteSvg)
    const wav = placeholderAssetBytes('wav')
    this.assetBytes.set('default-backdrop', new Uint8Array(backdropSvg))
    this.assetBytes.set('default-backdrop.svg', new Uint8Array(backdropSvg))
    this.assetBytes.set('default-sprite', new Uint8Array(spriteSvg))
    this.assetBytes.set('default-sprite.svg', new Uint8Array(spriteSvg))
    if (wav) {
      this.assetBytes.set('default-sound', new Uint8Array(wav))
      this.assetBytes.set('default-sound.wav', new Uint8Array(wav))
    }
  }

  private ensureReferencedAssetBytes(): void {
    for (const asset of referencedAssets(this.project)) {
      if (this.assetBytes.has(asset.md5ext) || this.assetBytes.has(asset.assetId)) continue
      const placeholder = placeholderAssetBytes(asset.dataFormat)
      this.emit('ERROR', { message: `Missing asset bytes for ${asset.md5ext}` })
      if (!placeholder) continue
      this.assetBytes.set(asset.assetId, new Uint8Array(placeholder))
      this.assetBytes.set(asset.md5ext, new Uint8Array(placeholder))
    }
  }

  start(): void {
    this.emit('RUNTIME_STARTED', this.snapshot())
  }

  quit(): void {
    this.stopAll()
    this.emit('RUNTIME_DISPOSED', this.snapshot())
  }

  clear(): void {
    this.renderer?.clearCachedCostumes?.()
    this.project = createDefaultProject()
    this.selectedTargetId = 'sprite1'
    this.origin = this.project.meta.origin ?? null
    this.resetExecutionState({ clearKeyboard: true, clearAnswer: true })
    this.emit('PROJECT_LOADED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  setTurboMode(enabled: boolean): void {
    if (this.turboMode === enabled) return
    this.turboMode = enabled
    this.emit(enabled ? 'TURBO_MODE_ON' : 'TURBO_MODE_OFF', this.snapshot())
  }

  setCompatibilityMode(enabled: boolean): void {
    if (this.compatibilityMode === enabled) return
    this.compatibilityMode = enabled
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  loadExtension(idOrUrl: string): void {
    const id = normalizeExtensionId(idOrUrl)
    if (!id || this.project.extensions.includes(id)) return
    this.project.extensions.push(id)
    this.emit('EXTENSION_ADDED', { id, extensionId: id })
    this.emit('BLOCKSINFO_UPDATE', { id, extensionId: id })
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.requestToolboxExtensionsUpdate()
  }

  loadProject(project: unknown): Promise<ScratchProject> {
    try {
      const hadCloudData = this.hasCloudData()
      const input = this.decodeProjectInput(project)
      this.renderer?.clearCachedCostumes?.()
      this.project = normalizeProject(input)
      this.clearDataLookupCache()
      this.clearReporterCache()
      this.origin = this.project.meta.origin ?? null
      const selected = this.project.targets.find((target) => !target.isStage) ?? this.project.targets[0]
      this.selectedTargetId = selected?.id ?? selected?.name ?? 'Stage'
      this.resetExecutionState({ clearKeyboard: true, clearAnswer: true })
      this.emit('PROJECT_LOADED', this.snapshot())
      this.emit('TARGETS_UPDATE', this.snapshot())
      this.emit('WORKSPACE_UPDATE', this.snapshot())
      if (hadCloudData !== this.hasCloudData()) this.emit('HAS_CLOUD_DATA_UPDATE', this.hasCloudData())
      this.ensureReferencedAssetBytes()
      return Promise.resolve(this.project)
    } catch (error) {
      this.emit('ERROR', { error, message: error instanceof Error ? error.message : String(error) })
      return Promise.reject(error)
    }
  }

  importJSON(source: string): Promise<ScratchProject> {
    try {
      return this.loadProject(JSON.parse(cleanJsonText(source)))
    } catch (error) {
      return Promise.reject(error)
    }
  }

  fromJSON(source: string): Promise<ScratchProject> {
    return this.importJSON(source)
  }

  deserializeProject(projectJSON: unknown, zip?: unknown): Promise<ScratchProject> {
    if (zip && isObject(zip) && typeof zip === 'object') {
      const files = zip as { files?: Record<string, { async?: (type: string) => Promise<Uint8Array> }> }
      void files
    }
    return this.loadProject(projectJSON)
  }

  installTargets(targets: ScratchTarget[], extensions: string[] = [], wholeProject = true): Promise<void> {
    const normalizedTargets = targets.flatMap((target, index) => {
      const normalized = normalizeTarget(target, index)
      return normalized ? [normalized] : []
    })
    if (normalizedTargets.length === 0) return Promise.resolve()
    this.project.targets = wholeProject ? normalizedTargets : [...this.project.targets, ...normalizedTargets.filter((target) => !target.isStage)]
    this.clearDataLookupCache()
    this.project.extensions = [...new Set([...(wholeProject ? [] : this.project.extensions), ...extensions])]
    if (!this.project.targets.some((target) => target.isStage)) this.project.targets.unshift(createStageTarget())
    normalizeLayerOrder(this.project)
    const selected = this.project.targets.find((target) => !target.isStage) ?? this.project.targets[0]
    this.selectedTargetId = selected?.id ?? selected?.name ?? 'Stage'
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    return Promise.resolve()
  }

  exportProject(): ScratchProject {
    return structuredClone(this.project)
  }

  get editingTarget(): ScratchTarget | null {
    return this.getSelectedTarget() ?? null
  }

  set editingTarget(target: ScratchTarget | string | null | undefined) {
    if (target === null) {
      this.selectedTargetId = this.getStage().id ?? this.getStage().name
      this.emit('EDITING_TARGET_CHANGED', null)
      this.emit('TARGETS_UPDATE', this.snapshot())
      this.emit('WORKSPACE_UPDATE', this.snapshot())
      return
    }
    this.setEditingTarget(target)
  }

  setCompilerOptions(options: Record<string, unknown> = {}): void {
    this.compilerOptions = { ...this.compilerOptions, ...structuredClone(options) }
    this.emit('COMPILER_OPTIONS_CHANGED', structuredClone(this.compilerOptions))
  }

  getCompilerOptions(): Record<string, unknown> {
    return structuredClone(this.compilerOptions)
  }

  toJSON(targetId?: string): string {
    if (targetId) return JSON.stringify(this.getTarget(targetId) ?? null, null, 2)
    return JSON.stringify(this.project, null, 2)
  }

  async saveProjectSb3(): Promise<Uint8Array> {
    const files: Record<string, Uint8Array> = {
      'project.json': strToU8(this.toJSON()),
    }
    for (const asset of referencedAssets(this.project)) {
      const bytes = this.assetBytes.get(asset.md5ext) ?? this.assetBytes.get(asset.assetId) ?? placeholderAssetBytes(asset.dataFormat)
      if (!bytes) {
        this.emit('ERROR', { message: `Missing asset bytes for ${asset.md5ext}` })
        continue
      }
      files[asset.md5ext] = bytes
    }
    return zipSync(files)
  }

  async downloadProjectId(id: string | number): Promise<ScratchProject> {
    const bytes = await this.storage?.loadAsset?.(String(id), 'json')
    if (!bytes) throw new Error(`Project ${id} could not be loaded`)
    return this.loadProject(strFromU8(bytes))
  }

  async saveSpriteSb3(targetIdOrName = this.selectedTargetId): Promise<Uint8Array> {
    const target = this.getTarget(targetIdOrName)
    if (!target || target.isStage) throw new Error(`Cannot export sprite ${targetIdOrName}`)
    const sprite = structuredClone(target)
    const files: Record<string, Uint8Array> = {
      'sprite.json': strToU8(JSON.stringify(sprite, null, 2)),
    }
    for (const asset of referencedAssets({ targets: [sprite], monitors: [], extensions: [], meta: this.project.meta })) {
      const bytes = this.assetBytes.get(asset.md5ext) ?? this.assetBytes.get(asset.assetId) ?? placeholderAssetBytes(asset.dataFormat)
      if (!bytes) {
        this.emit('ERROR', { message: `Missing asset bytes for ${asset.md5ext}` })
        continue
      }
      files[asset.md5ext] = bytes
    }
    return zipSync(files)
  }

  exportSprite(targetIdOrName = this.selectedTargetId): Promise<Uint8Array> {
    return this.saveSpriteSb3(targetIdOrName)
  }

  get assets(): Array<ScratchCostume | ScratchSound> {
    return this.project.targets.flatMap((target) => [
      ...target.costumes.map((costume) => structuredClone(costume)),
      ...target.sounds.map((sound) => structuredClone(sound)),
    ])
  }

  getPlaygroundData(): { threads: ThreadSnapshot[]; blocks: Record<string, ScratchBlock>; target?: ScratchTarget } {
    const target = this.getSelectedTarget()
    const playgroundData = {
      threads: this.snapshot().threads.filter((thread) => thread.targetName === target.name),
      blocks: structuredClone(target.blocks),
      target: structuredClone(target),
    }
    this.emit('playgroundData', playgroundData)
    return playgroundData
  }

  snapshot(): RuntimeSnapshot {
    this.refreshMonitorValues()
    return {
      project: this.exportProject(),
      selectedTargetId: this.selectedTargetId,
      origin: this.origin,
      running: this.running,
      turboMode: this.turboMode,
      compatibilityMode: this.compatibilityMode,
      threads: this.threads.map((thread) => this.threadSnapshot(thread)),
    }
  }

  private runtimeSnapshot(): RuntimeSnapshot {
    this.refreshMonitorValues()
    return {
      project: this.project,
      selectedTargetId: this.selectedTargetId,
      origin: this.origin,
      running: this.running,
      turboMode: this.turboMode,
      compatibilityMode: this.compatibilityMode,
      threads: this.threads.map((thread) => this.threadSnapshot(thread)),
    }
  }

  isRunning(): boolean {
    return this.running
  }

  applyRuntimeSnapshot(snapshot: RuntimeSnapshot): void {
    this.project = structuredClone(snapshot.project)
    this.selectedTargetId = snapshot.selectedTargetId
    this.origin = snapshot.origin
    this.running = snapshot.running
    this.turboMode = snapshot.turboMode
    this.compatibilityMode = snapshot.compatibilityMode
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  getTarget(idOrName: string): ScratchTarget | undefined {
    return this.project.targets.find((target) => target.id === idOrName || target.name === idOrName)
  }

  getTargetByDrawableId(drawableId: number | string): ScratchTarget | undefined {
    const targetId = this.getTargetIdForDrawableId(drawableId)
    return targetId ? this.getTarget(targetId) : undefined
  }

  getTargetById(id: string): ScratchTarget | undefined {
    return this.getTarget(id)
  }

  getSpriteTargetByName(name: string): ScratchTarget | undefined {
    return this.getSprites().find((target) => target.name === name)
  }

  getTargetForStage(): ScratchTarget | undefined {
    return this.getStage()
  }

  getEditingTarget(): ScratchTarget | undefined {
    return this.getSelectedTarget()
  }

  getMonitorState(): Map<string, ScratchMonitor> {
    return new Map(this.project.monitors.map((monitor) => [monitor.id, structuredClone(monitor)]))
  }

  makeMessageContextForTarget(target = this.getSelectedTarget()): Record<string, unknown> {
    return { locale: this.locale, messages: this.localeMessages, target }
  }

  private resolveRuntimeTarget(target?: ScratchTarget | string): ScratchTarget | undefined {
    if (!target) return undefined
    if (typeof target === 'string') return this.getTarget(target)
    return this.project.targets.find((candidate) => candidate === target || candidate.id === target.id || candidate.name === target.name)
  }

  private threadSnapshot(thread: RuntimeThread): ThreadSnapshot {
    return {
      targetName: thread.target.name,
      topBlockId: thread.topBlockId,
      currentBlockId: thread.currentBlockId,
      status: this.threadStatus(thread),
    }
  }

  private threadStatus(thread: RuntimeThread): ThreadSnapshot['status'] {
    if (thread.done) return 'done'
    const hasChildren = Boolean(thread.waitingFor?.some((child) => !child.done))
    const isWaiting =
      thread.waitUntil > Date.now() ||
      hasChildren ||
      Boolean(thread.glide) ||
      Boolean(thread.waitingBlockId) ||
      Boolean(thread.waitingBroadcastBlockId) ||
      Boolean(thread.waitingSoundBlockId)
    return isWaiting ? 'waiting' : 'running'
  }

  private clearSoundWaits(target?: ScratchTarget): void {
    for (const thread of this.threads) {
      if (target && thread.target !== target) continue
      if (!thread.waitingSoundBlockId) continue
      thread.waitingSoundDone = true
      thread.waitingSoundUntil = 0
    }
  }

  private blockFieldsMatch(block: ScratchBlock, matchFields: Record<string, unknown>): boolean {
    for (const [name, expected] of Object.entries(matchFields)) {
      const field = block.fields?.[name]
      const actual = Array.isArray(field) ? field[0] : undefined
      if (String(actual ?? '') !== String(expected ?? '')) return false
    }
    return true
  }

  addTarget(input: ScratchTarget | unknown): ScratchTarget | undefined {
    const target = normalizeTarget(input, this.project.targets.length)
    if (!target) return undefined
    if (target.isStage) {
      const index = this.project.targets.findIndex((item) => item.isStage)
      if (index >= 0) this.project.targets[index] = target
      else this.project.targets.unshift(target)
    } else {
      target.id = uniqueTargetId(this.project, target.id ?? 'sprite')
      target.name = uniqueSpriteName(this.project, target.name || 'Sprite')
      target.layerOrder = this.project.targets.length
      this.project.targets.push(target)
      this.selectedTargetId = target.id ?? target.name
    }
    normalizeLayerOrder(this.project)
    this.fireTargetWasCreated(target)
    this.emitProjectChanged()
    this.requestTargetsUpdate()
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    return structuredClone(target)
  }

  disposeRuntime(): void {
    this.stopAll()
    this.threads = []
    this.emit('RUNTIME_DISPOSED', this.snapshot())
  }

  disposeTarget(targetOrName: ScratchTarget | string): void {
    const target = this.resolveRuntimeTarget(targetOrName)
    if (!target) return
    const payload = structuredClone(target)
    if (target.isStage) {
      this.emit('TARGET_WAS_REMOVED', payload)
      return
    }
    this.deleteTarget(target.id ?? target.name)
    this.fireTargetWasRemoved(payload)
  }

  emitProjectChanged(): void {
    this.emit('PROJECT_CHANGED', this.snapshot())
  }

  fireTargetWasCreated(target: ScratchTarget | unknown): void {
    this.emit('TARGET_WAS_CREATED', structuredClone(target))
  }

  fireTargetWasRemoved(target: ScratchTarget | unknown): void {
    this.emit('TARGET_WAS_REMOVED', structuredClone(target))
  }

  handleProjectLoaded(): RuntimeSnapshot {
    const snapshot = this.snapshot()
    this.emit('PROJECT_LOADED', snapshot)
    this.emit('TARGETS_UPDATE', snapshot)
    this.emit('WORKSPACE_UPDATE', snapshot)
    return snapshot
  }

  createNewGlobalVariable(name: string, type = '', isCloud = false): string {
    const normalizedType = String(type).toLowerCase()
    if (normalizedType === 'list') return this.createList(this.getStage().id ?? this.getStage().name, name, [])
    if (normalizedType === 'broadcast_msg' || normalizedType === 'broadcast') {
      const id = makeId('broadcast')
      this.getStage().broadcasts[id] = name
      this.emitProjectChanged()
      return id
    }
    return this.createVariable(this.getStage().id ?? this.getStage().name, name, 0, isCloud)
  }

  getAllVarNamesOfType(type = ''): string[] {
    const normalizedType = String(type).toLowerCase()
    const names = new Set<string>()
    for (const target of this.project.targets) {
      if (!normalizedType || normalizedType === '' || normalizedType === 'scalar' || normalizedType === 'variable') {
        Object.values(target.variables).forEach((variable) => names.add(variable[0]))
      }
      if (!normalizedType || normalizedType === 'list') {
        Object.values(target.lists).forEach((list) => names.add(list[0]))
      }
      if (normalizedType === 'broadcast_msg' || normalizedType === 'broadcast') {
        Object.values(target.broadcasts).forEach((name) => names.add(name))
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b))
  }

  startRuntimeHats(opcode: string, matchFields: Record<string, unknown> = {}, target?: ScratchTarget | string): ThreadSnapshot[] {
    const started: RuntimeThread[] = []
    const targetFilter = this.resolveRuntimeTarget(target)
    for (const candidate of this.project.targets) {
      if (targetFilter && candidate !== targetFilter) continue
      for (const [id, block] of Object.entries(candidate.blocks)) {
        if (block.opcode !== opcode) continue
        if (!this.blockFieldsMatch(block, matchFields)) continue
        started.push(this.startThread(candidate, id))
      }
    }
    this.running = this.threads.some((thread) => !thread.done)
    if (started.length > 0) this.emit('RUNTIME_STEP', this.snapshot())
    return started.map((thread) => this.threadSnapshot(thread))
  }

  startHats(opcode: string, matchFields: Record<string, unknown> = {}, target?: ScratchTarget | string): ThreadSnapshot[] {
    return this.startRuntimeHats(opcode, matchFields, target)
  }

  toggleScript(topBlockId: string, target?: ScratchTarget | string): ThreadSnapshot | undefined {
    const active = this.threads.find((thread) => thread.topBlockId === topBlockId && !thread.done && (!target || thread.target === this.resolveRuntimeTarget(target)))
    if (active) {
      active.done = true
      this.threads = this.threads.filter((thread) => thread !== active)
      this.running = this.threads.some((thread) => !thread.done)
      this.emitScriptGlow(topBlockId, false)
      this.emit('RUNTIME_STEP', this.snapshot())
      return undefined
    }
    const owner = this.resolveRuntimeTarget(target) ?? this.project.targets.find((candidate) => candidate.blocks[topBlockId])
    if (!owner || !owner.blocks[topBlockId]) return undefined
    const wasRunning = this.running
    const thread = this.startThread(owner, topBlockId)
    this.running = true
    if (!wasRunning) {
      this.emit('PROJECT_START', this.snapshot())
      this.emit('PROJECT_RUN_START', this.snapshot())
    }
    this.emitScriptGlow(topBlockId, true)
    this.emit('RUNTIME_STEP', this.snapshot())
    return this.threadSnapshot(thread)
  }

  stopForTarget(target: ScratchTarget | string): void {
    const resolved = this.resolveRuntimeTarget(target)
    if (!resolved) return
    this.threads = this.threads.filter((thread) => thread.target !== resolved)
    this.project.targets = this.project.targets.filter((candidate) => candidate.cloneOf !== (resolved.id ?? resolved.name))
    callAudio(this.audioEngine, 'stopSoundsForTarget', resolved.name)
    this.running = this.threads.some((thread) => !thread.done)
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('RUNTIME_STEP', this.snapshot())
  }

  isActiveThread(thread: unknown): boolean {
    if (!isObject(thread)) return false
    const topBlockId = String(thread.topBlockId ?? '')
    return this.threads.some((candidate) => candidate.topBlockId === topBlockId && !candidate.done)
  }

  isWaitingThread(thread: unknown): boolean {
    if (!isObject(thread)) return false
    const current = this.threads.find((candidate) => candidate.topBlockId === String(thread.topBlockId ?? ''))
    return current ? this.threadStatus(current) === 'waiting' : String(thread.status ?? '') === 'waiting'
  }

  allScriptsDo(callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string): void {
    const targetFilter = this.resolveRuntimeTarget(target)
    for (const candidate of this.project.targets) {
      if (targetFilter && candidate !== targetFilter) continue
      for (const [id, block] of Object.entries(candidate.blocks)) {
        if (block.topLevel || block.parent === null || block.parent === undefined) callback(id, candidate)
      }
    }
  }

  allScriptsByOpcodeDo(opcode: string, callback: (blockId: string, target: ScratchTarget) => void, target?: ScratchTarget | string): void {
    this.allScriptsDo((blockId, candidate) => {
      if (candidate.blocks[blockId]?.opcode === opcode) callback(blockId, candidate)
    }, target)
  }

  addMonitorScript(topBlockId: string, target?: ScratchTarget | string): ThreadSnapshot | undefined {
    const owner = this.resolveRuntimeTarget(target) ?? this.project.targets.find((candidate) => candidate.blocks[topBlockId])
    if (!owner || !owner.blocks[topBlockId]) return undefined
    const thread = this.startThread(owner, topBlockId)
    return this.threadSnapshot(thread)
  }

  reportBlockValue(blockId: string, target?: ScratchTarget | string): ScratchValue | undefined {
    const owner = this.resolveRuntimeTarget(target) ?? this.project.targets.find((candidate) => candidate.blocks[blockId])
    const block = owner?.blocks[blockId]
    if (!owner || !block) return undefined
    const value = this.reporterValue(owner, block)
    this.visualReport(blockId, value)
    return value
  }

  setExecutablePosition(target: ScratchTarget | string, index: number): void {
    const resolved = this.resolveRuntimeTarget(target)
    if (!resolved || resolved.isStage) return
    this.reorderTarget(resolved.id ?? resolved.name, index)
  }

  moveExecutable(target: ScratchTarget | string, index: number): void {
    this.setExecutablePosition(target, index)
  }

  removeExecutable(target: ScratchTarget | string): void {
    const resolved = this.resolveRuntimeTarget(target)
    if (!resolved || resolved.isStage) return
    this.disposeTarget(resolved)
  }

  clonesAvailable(): boolean {
    return this.project.targets.filter((target) => target.isClone).length < 300
  }

  changeCloneCounter(delta: number): number {
    this.runtimeCounter = Math.max(0, this.runtimeCounter + Math.trunc(Cast.toNumber(delta)))
    return this.runtimeCounter
  }

  requestTargetsUpdate(shouldEmitProjectChanged = false): void {
    if (shouldEmitProjectChanged) this.emitProjectChanged()
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  requestRedraw(): void {
    if (this.runtimeStepActive) return
    this.renderer?.requestDraw?.(this.snapshot())
  }

  requestRemoveMonitorByTargetId(targetId: string): void {
    const target = this.getTarget(targetId)
    const before = this.project.monitors.length
    this.project.monitors = this.project.monitors.filter((monitor) => monitor.spriteName !== targetId && monitor.spriteName !== target?.name)
    if (this.project.monitors.length !== before) {
      this.emitProjectChanged()
      this.emit('MONITORS_UPDATE', this.snapshot())
    }
  }

  resetRunId(): string {
    const runId = makeId('run')
    scratchFetch.setMetadata(RequestMetadata.RunId, runId)
    this.emit('RUN_ID_RESET', runId)
    return runId
  }

  getLabelForOpcode(opcode: string): string {
    return String(opcode).replace(/^[a-z0-9]+_/i, '').replace(/_/g, ' ')
  }

  attachRenderer(renderer: RendererFacade): void {
    this.renderer = renderer
    this.renderer.setAssetResolver?.((assetId, dataFormat = '') => this.loadAsset(assetId, dataFormat))
    this.renderer.requestDraw?.(this.snapshot())
  }

  attachAudioEngine(audio: unknown): void {
    this.audioEngine = audio
  }

  attachStorage(storage: StorageFacade): void {
    this.storage = storage
  }

  async loadAsset(assetId: string, dataFormat = ''): Promise<Uint8Array | undefined> {
    const local = this.assetBytes.get(assetId) ?? this.assetBytes.get(`${assetId}.${dataFormat}`)
    if (local) return new Uint8Array(local)
    const external = await this.storage?.loadAsset?.(assetId, dataFormat)
    return external ? new Uint8Array(external) : undefined
  }

  async storeAsset(data: Uint8Array, dataFormat: string): Promise<{ assetId: string; md5ext: string }> {
    const normalizedData = normalizeAssetBytes(data, dataFormat)
    const external = await this.storage?.storeAsset?.(normalizedData, dataFormat)
    const assetId = external?.assetId ?? bytesHash(normalizedData)
    const md5ext = external?.md5ext ?? `${assetId}.${dataFormat}`
    this.assetBytes.set(assetId, new Uint8Array(normalizedData))
    this.assetBytes.set(md5ext, new Uint8Array(normalizedData))
    return { assetId, md5ext }
  }

  async deleteAsset(assetId: string): Promise<void> {
    this.assetBytes.delete(assetId)
    await this.storage?.deleteAsset?.(assetId)
  }

  async listAssets(): Promise<string[]> {
    const external = await this.storage?.listAssets?.()
    return [...new Set([...this.assetBytes.keys(), ...(external ?? [])])].sort()
  }

  exportAssetBytes(): Record<string, Uint8Array> {
    return Object.fromEntries([...this.assetBytes.entries()].map(([key, bytes]) => [key, new Uint8Array(bytes)]))
  }

  importAssetBytes(assets: Record<string, Uint8Array>): void {
    for (const [key, bytes] of Object.entries(assets)) {
      this.assetBytes.set(key, new Uint8Array(bytes))
    }
  }

  attachV2SVGAdapter(adapter: unknown): void {
    this.svgAdapter = adapter
  }

  attachV2BitmapAdapter(adapter: unknown): void {
    this.bitmapAdapter = adapter
  }

  setVideoProvider(provider: unknown): void {
    this.videoProvider = provider
    this.postIOData('videoProvider', provider)
  }

  setCloudProvider(provider: unknown): void {
    this.cloudProvider = provider
    this.postIOData('cloudProvider', provider)
    callProvider(provider, 'setStage', structuredClone(this.getStage()))
    this.emit('HAS_CLOUD_DATA_UPDATE', this.hasCloudData())
  }

  setLocale(locale: string, messages: Record<string, unknown> = {}): void {
    this.locale = locale
    this.localeMessages = structuredClone(messages)
    this.emit('LOCALE_CHANGED', { locale: this.locale, messages: this.localeMessages })
  }

  getLocale(): string {
    return this.locale
  }

  scanForPeripheral(extensionId: string): void {
    const state = this.peripheralState.get(extensionId) ?? { scanning: false, connected: false }
    state.scanning = true
    this.peripheralState.set(extensionId, state)
    const extension = this.registeredPeripheralExtensions.get(extensionId)
    callProvider(extension, 'scan')
    const info = { extensionId, peripherals: state.peripheralId ? [{ peripheralId: state.peripheralId }] : [] }
    this.emit('PERIPHERAL_SCAN', info)
    this.emit('PERIPHERAL_LIST_UPDATE', info)
  }

  connectPeripheral(extensionId: string, peripheralId: string): void {
    const extension = this.registeredPeripheralExtensions.get(extensionId)
    callProvider(extension, 'connect', peripheralId)
    this.peripheralState.set(extensionId, { scanning: false, connected: true, peripheralId })
    this.emit('PERIPHERAL_CONNECTED', { extensionId, peripheralId })
  }

  disconnectPeripheral(extensionId: string): void {
    const extension = this.registeredPeripheralExtensions.get(extensionId)
    callProvider(extension, 'disconnect')
    this.peripheralState.set(extensionId, { scanning: false, connected: false })
    this.emit('PERIPHERAL_DISCONNECTED', { extensionId })
  }

  getPeripheralIsConnected(extensionId: string): boolean {
    return this.peripheralState.get(extensionId)?.connected === true
  }

  configureScratchLinkSocketFactory(factory: unknown): void {
    this.postIOData('scratchLinkSocketFactory', factory)
    this.scratchLinkSocketFactory = factory
  }

  getScratchLinkSocket(type: string): unknown {
    if (typeof this.scratchLinkSocketFactory === 'function') return this.scratchLinkSocketFactory(type)
    if (isObject(this.scratchLinkSocketFactory) && typeof this.scratchLinkSocketFactory.create === 'function') return this.scratchLinkSocketFactory.create(type)
    return { type, open: false, send: () => undefined, close: () => undefined }
  }

  registerPeripheralExtension(extensionId: string, extension: unknown): void {
    this.registeredPeripheralExtensions.set(extensionId, extension)
    this.peripheralState.set(extensionId, this.peripheralState.get(extensionId) ?? { scanning: false, connected: false })
  }

  postIOData(device: string, data: unknown): void {
    if (device === 'mouse') {
      this.handleMouseData(data)
      return
    }
    this.ioData.set(device, data)
    if (device === 'userData') this.ioData.set('user', data)
    if (device === 'user') this.ioData.set('userData', data)
    if (device === 'cloud') this.handleCloudData(data)
  }

  postMouse(data: unknown): void {
    this.postIOData('mouse', data)
  }

  postKeyboard(data: unknown): void {
    const key = isObject(data) ? String(data.key ?? data.KEY_OPTION ?? '') : ''
    if (!key || !isObject(data)) {
      this.postIOData('keyboard', data)
      return
    }
    const normalized = normalizeKeyName(key)
    const isDown = data.isDown === true || data.down === true || data.pressed === true
    if (isDown) {
      this.pressedKeys.add(normalized)
    } else {
      this.pressedKeys.delete(normalized)
    }
    this.postIOData('keyboard', {
      key: normalized,
      isDown,
      pressed: isDown,
      keys: [...this.pressedKeys],
    })
    if (isDown) this.startKeyHats(normalized)
  }

  postWheel(data: unknown): void {
    this.postIOData('wheel', data)
  }

  emitMicListening(listening: boolean): void {
    this.emit('MIC_LISTENING', listening)
  }

  emitExtensionLoading(loading: boolean): void {
    this.emit('EXTENSION_DATA_LOADING', loading)
  }

  getOpcodeFunction(opcode: string): ((args?: unknown, util?: unknown) => unknown) | undefined {
    if (!blockPalette.some((group) => (group.opcodes as readonly string[]).includes(opcode))) return undefined
    return () => undefined
  }

  getIsHat(opcode: string): boolean {
    return opcode.startsWith('event_when') || opcode.includes('_when') || opcode === 'control_start_as_clone' || opcode === 'speech2text_whenIHearHat'
  }

  getIsEdgeActivatedHat(opcode: string): boolean {
    return this.getIsHat(opcode) && !['event_whenflagclicked', 'event_whenbroadcastreceived', 'control_start_as_clone'].includes(opcode)
  }

  enableProfiling(onFrame?: (snapshot: RuntimeSnapshot) => void): void {
    this.ioData.set('profiling', { enabled: true, onFrame })
  }

  disableProfiling(): void {
    this.ioData.delete('profiling')
  }

  updateCurrentMSecs(): number {
    this.lastStep = Date.now()
    return this.lastStep
  }

  answerPrompt(value: string): void {
    this.promptAnswer = value
    for (const thread of this.threads) {
      if (thread.waitingAnswer) thread.waitingAnswer = false
    }
    this.emit('QUESTION', { answer: value })
  }

  resetTimer(): void {
    this.timerStart = Date.now()
  }

  private resetExecutionState(options: { clearKeyboard?: boolean; clearAnswer?: boolean } = {}): void {
    this.threads = []
    this.running = false
    this.currentThread = undefined
    this.greaterThanHatState.clear()
    this.touchingHatState.clear()
    this.extensionHatState.clear()
    if (options.clearKeyboard) {
      this.pressedKeys.clear()
      this.postIOData('keyboard', { keys: [], isDown: false, pressed: false })
    }
    if (options.clearAnswer) this.promptAnswer = ''
    this.clearGlows()
  }

  private decodeProjectInput(input: unknown): unknown {
    if (typeof input === 'string') return JSON.parse(cleanJsonText(input))
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
      if (isZip(bytes)) {
        const files = unzipSync(bytes)
        const projectBytes = findArchiveJson(files, 'project.json')
        const spriteBytes = findArchiveJson(files, 'sprite.json')
        if (!projectBytes && !spriteBytes) throw new Error('Scratch archive is missing project.json or sprite.json')
        this.assetBytes.clear()
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith('project.json') || name.endsWith('sprite.json')) continue
          const normalized = normalizeArchiveAssetBytes(name, data)
          this.assetBytes.set(name, normalized)
          this.assetBytes.set(fileBasename(name), normalized)
          const id = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
          this.assetBytes.set(fileBasename(id), normalized)
        }
        if (projectBytes) return JSON.parse(cleanJsonText(strFromU8(projectBytes)))
        return projectFromSpriteJson(JSON.parse(cleanJsonText(strFromU8(spriteBytes!))))
      }
      return JSON.parse(cleanJsonText(strFromU8(bytes)))
    }
    return input
  }

  getStage(): ScratchTarget {
    const first = this.project.targets[0]
    return first?.isStage ? first : (this.project.targets.find((target) => target.isStage) ?? first!)
  }

  getSprites(): ScratchTarget[] {
    return this.project.targets.filter((target) => !target.isStage && !target.isClone)
  }

  getSelectedTarget(): ScratchTarget {
    return this.getTarget(this.selectedTargetId) ?? this.getSprites()[0] ?? this.getStage()
  }

  selectTarget(name: string): void {
    const target = this.getTarget(name)
    if (!target) return
    this.selectedTargetId = target.id ?? target.name
    this.emit('EDITING_TARGET_CHANGED', structuredClone(target))
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  setEditingTarget(targetOrName?: ScratchTarget | string | null): void {
    if (targetOrName === null || targetOrName === undefined) {
      this.selectTarget(this.getStage().id ?? this.getStage().name)
      return
    }
    this.selectTarget(typeof targetOrName === 'string' ? targetOrName : targetOrName.id ?? targetOrName.name)
  }

  addSprite(): ScratchTarget & PromiseLike<ScratchTarget>
  addSprite(name: string): ScratchTarget & PromiseLike<ScratchTarget>
  addSprite(input: unknown): (ScratchTarget & PromiseLike<ScratchTarget>) | Promise<undefined>
  addSprite(input: unknown = uniqueSpriteName(this.project)): (ScratchTarget & PromiseLike<ScratchTarget>) | Promise<undefined> {
    if (typeof input !== 'string' || looksLikeSerializedSprite(input)) {
      const imported = this.importSprite(input)
      return imported ? thenableTarget(imported) : Promise.resolve(undefined)
    }
    const sprite = createSpriteTarget(input, this.project.targets.length)
    this.project.targets.push(sprite)
    this.selectedTargetId = sprite.id ?? sprite.name
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    return thenableTarget(structuredClone(sprite))
  }

  importSprite(input: unknown): ScratchTarget | undefined {
    const decoded = this.decodeSpriteInput(input)
    const target = normalizeTarget(decoded, this.project.targets.length)
    if (!target) return undefined
    target.isStage = false
    target.id = uniqueTargetId(this.project, 'sprite')
    target.name = uniqueSpriteName(this.project, target.name || 'Sprite')
    target.layerOrder = this.project.targets.length
    this.project.targets.push(target)
    this.selectedTargetId = target.id ?? target.name
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    return structuredClone(target)
  }

  private decodeSpriteInput(input: unknown): unknown {
    if (typeof input === 'string') return JSON.parse(cleanJsonText(input))
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
      if (isZip(bytes)) {
        const files = unzipSync(bytes)
        const spriteBytes = findArchiveJson(files, 'sprite.json')
        const projectBytes = findArchiveJson(files, 'project.json')
        if (!spriteBytes && !projectBytes) throw new Error('Sprite archive is missing sprite.json or project.json')
        for (const [name, data] of Object.entries(files)) {
          if (name.endsWith('sprite.json') || name.endsWith('project.json')) continue
          const normalized = normalizeArchiveAssetBytes(name, data)
          this.assetBytes.set(name, normalized)
          this.assetBytes.set(fileBasename(name), normalized)
          const id = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name
          this.assetBytes.set(fileBasename(id), normalized)
        }
        if (spriteBytes) return JSON.parse(cleanJsonText(strFromU8(spriteBytes)))
        const project = normalizeProject(JSON.parse(cleanJsonText(strFromU8(projectBytes!))))
        const sprite = project.targets.find((target) => !target.isStage)
        if (!sprite) throw new Error('Project archive has no sprite target')
        return sprite
      }
      return JSON.parse(cleanJsonText(strFromU8(bytes)))
    }
    return input
  }

  duplicateSprite(name: string): (ScratchTarget & PromiseLike<ScratchTarget>) | undefined {
    const target = this.getTarget(name)
    if (!target || target.isStage) return undefined
    const copy = structuredClone(target)
    copy.id = uniqueTargetId(this.project, 'sprite')
    copy.name = uniqueSpriteName(this.project, `${target.name} copy`)
    copy.layerOrder = this.project.targets.length
    copy.x = bounded((copy.x ?? 0) + 20, -240, 240)
    copy.y = bounded((copy.y ?? 0) - 20, -180, 180)
    this.project.targets.push(copy)
    this.selectedTargetId = copy.id ?? copy.name
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return thenableTarget(structuredClone(copy))
  }

  deleteTarget(name: string): void {
    const target = this.getTarget(name)
    if (!target || target.isStage) return
    const deletingSelected = this.getSelectedTarget() === target
    const hadPendingPrompt = this.threads.some((thread) => thread.target === target && thread.waitingBlockId)
    this.project.targets = this.project.targets.filter((item) => item !== target && item.cloneOf !== (target.id ?? target.name))
    this.threads = this.threads.filter((thread) => thread.target !== target && thread.target.cloneOf !== (target.id ?? target.name))
    this.project.monitors = this.project.monitors.filter((monitor) => monitor.spriteName !== target.name)
    if (deletingSelected || !this.getTarget(this.selectedTargetId)) {
      const selected = this.getSprites()[0] ?? this.getStage()
      this.selectedTargetId = selected.id ?? selected.name
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    if (hadPendingPrompt) this.emit('QUESTION', { question: null })
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  deleteSprite(targetIdOrName: string): Promise<void> {
    this.deleteTarget(targetIdOrName)
    return Promise.resolve()
  }

  renameSprite(name: string, nextName: string): boolean {
    const target = this.getTarget(name)
    const cleanName = nextName.trim()
    if (!target || target.isStage || !cleanName || this.getTarget(cleanName)) return false
    const previousName = target.name
    target.name = cleanName
    for (const monitor of this.project.monitors) {
      if (monitor.spriteName === previousName) monitor.spriteName = cleanName
    }
    this.updateSpriteNameReferences(previousName, cleanName)
    if (this.selectedTargetId === name || this.selectedTargetId === target.id) this.selectedTargetId = target.id ?? cleanName
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    return true
  }

  private updateSpriteNameReferences(previousName: string, nextName: string): void {
    const referenceFields = new Set(['TO', 'TOWARDS', 'DISTANCETOMENU', 'TOUCHINGOBJECTMENU', 'CLONE_OPTION', 'OBJECT'])
    for (const target of this.project.targets) {
      for (const block of Object.values(target.blocks)) {
        for (const [name, field] of Object.entries(block.fields ?? {})) {
          if (!referenceFields.has(name)) continue
          if (field[0] === previousName) field[0] = nextName
          if (field[1] === previousName) field[1] = nextName
        }
        for (const [name, input] of Object.entries(block.inputs ?? {})) {
          if (!referenceFields.has(name)) continue
          replaceSpriteInputReference(input, previousName, nextName)
        }
      }
    }
  }

  reorderTarget(targetIndexOrName: number | string, index: number): boolean {
    const current =
      typeof targetIndexOrName === 'number'
        ? bounded(Math.floor(targetIndexOrName), 0, this.project.targets.length - 1)
        : this.project.targets.findIndex((target) => target.id === targetIndexOrName || target.name === targetIndexOrName)
    if (current < 0 || this.project.targets[current]?.isStage) return false
    const [target] = this.project.targets.splice(current, 1)
    if (!target) return false
    const nextIndex = bounded(Math.floor(index), 1, this.project.targets.length)
    this.project.targets.splice(nextIndex, 0, target)
    this.project.targets.forEach((item, layerOrder) => {
      item.layerOrder = layerOrder
    })
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return true
  }

  updateTarget(name: string, patch: Partial<Pick<ScratchTarget, 'x' | 'y' | 'direction' | 'size' | 'visible' | 'volume' | 'draggable' | 'rotationStyle' | 'drawableId'>>): void {
    const target = this.getTarget(name)
    if (!target || target.isStage) return
    Object.assign(target, patch)
    clampSprite(target)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  startDrag(targetIdOrName: string): void {
    const target = this.getTarget(targetIdOrName)
    if (!target || target.isStage) return
    this.draggingTargetId = target.id ?? target.name
    this.emit('TARGET_DRAG_START', { targetId: this.draggingTargetId })
  }

  stopDrag(targetIdOrName = this.draggingTargetId ?? ''): void {
    const target = this.getTarget(targetIdOrName)
    const targetId = target?.id ?? target?.name ?? this.draggingTargetId
    this.draggingTargetId = undefined
    this.emit('TARGET_DRAG_STOP', { targetId })
  }

  postSpriteInfo(data: unknown): void {
    if (!isObject(data)) return
    const target = this.getTarget(String(data.targetId ?? data.id ?? data.name ?? this.draggingTargetId ?? this.selectedTargetId))
    if (!target || target.isStage) return
    const patch: Partial<Pick<ScratchTarget, 'x' | 'y' | 'direction' | 'size' | 'visible' | 'volume'>> = {}
    if (data.x !== undefined) patch.x = Cast.toNumber(data.x)
    if (data.y !== undefined) patch.y = Cast.toNumber(data.y)
    if (data.direction !== undefined) patch.direction = Cast.toNumber(data.direction)
    if (data.size !== undefined) patch.size = Cast.toNumber(data.size)
    if (data.visible !== undefined) patch.visible = data.visible !== false
    if (data.volume !== undefined) patch.volume = Cast.toNumber(data.volume)
    this.updateTarget(target.id ?? target.name, patch)
  }

  setVariable(targetName: string, variableId: string, value: ScratchValue): void {
    const target = this.getTarget(targetName)
    if (!target) return
    const variable = this.variableRecord(target, variableId)
    if (!variable) return
    variable[1][1] = value
    if (variable[0].isStage && variable[1][2] === true) callProvider(this.cloudProvider, 'updateVariable', variable[1][0], value)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  setVariableValue(targetName: string, variableId: string, value: ScratchValue): void {
    this.setVariable(targetName, variableId, value)
  }

  getVariableValue(targetName: string, variableId: string): ScratchValue | undefined {
    const target = this.getTarget(targetName)
    return target ? this.variableRecord(target, variableId)?.[1][1] : undefined
  }

  hasCloudData(): boolean {
    return Object.values(this.getStage().variables).some((variable) => variable[2] === true)
  }

  canAddCloudVariable(): boolean {
    return Object.values(this.getStage().variables).filter((variable) => variable[2] === true).length < 10
  }

  private handleCloudData(data: unknown): void {
    if (!isObject(data) || !isObject(data.varUpdate)) return
    const name = String(data.varUpdate.name ?? '')
    if (!name) return
    const variable = Object.values(this.getStage().variables).find((item) => item[0] === name && item[2] === true)
    if (!variable) return
    variable[1] = toScratchValue(data.varUpdate.value)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  createVariable(targetName: string, name: string, value: ScratchValue = 0, isCloud = false): string {
    const target = this.getTarget(targetName)
    const id = makeId('variable')
    if (!target) return id
    const shouldBeCloud = isCloud === true && target.isStage && this.canAddCloudVariable()
    const hadCloudData = this.hasCloudData()
    target.variables[id] = [name, value, shouldBeCloud]
    this.clearDataLookupCache(target)
    if (shouldBeCloud) callProvider(this.cloudProvider, 'createVariable', name, value)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    if (hadCloudData !== this.hasCloudData()) this.emit('HAS_CLOUD_DATA_UPDATE', this.hasCloudData())
    return id
  }

  renameVariable(targetName: string, id: string, name: string): void {
    const target = this.getTarget(targetName)
    const variable = target ? this.variableRecord(target, id) : undefined
    if (!target || !variable || !name.trim()) return
    const oldName = variable[1][0]
    variable[1][0] = name.trim()
    this.clearDataLookupCache(variable[0])
    this.updateVariableNameReferences(variable[0], variable[2], oldName, variable[1][0])
    if (variable[0].isStage && variable[1][2] === true) callProvider(this.cloudProvider, 'renameVariable', oldName, variable[1][0])
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  deleteVariable(targetName: string, id: string): void {
    const target = this.getTarget(targetName)
    const variable = target ? this.variableRecord(target, id) : undefined
    if (!target || !variable) return
    const hadCloudData = this.hasCloudData()
    if (variable[0].isStage && variable[1][2] === true) callProvider(this.cloudProvider, 'deleteVariable', variable[1][0])
    this.removeVariableReferences(variable[0], variable[2], variable[1][0])
    delete variable[0].variables[variable[2]]
    this.clearDataLookupCache(variable[0])
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    if (hadCloudData !== this.hasCloudData()) this.emit('HAS_CLOUD_DATA_UPDATE', this.hasCloudData())
  }

  createList(targetName: string, name: string, value: ScratchValue[] = []): string {
    const target = this.getTarget(targetName)
    const id = makeId('list')
    if (!target) return id
    target.lists[id] = [name, [...value]]
    this.clearDataLookupCache(target)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    return id
  }

  setListValue(targetName: string, listId: string, value: ScratchValue[]): void {
    const target = this.getTarget(targetName)
    const list = target ? this.listRecord(target, listId) : undefined
    if (!list) return
    list[1][1] = [...value]
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  getListValue(targetName: string, listId: string): ScratchValue[] | undefined {
    const target = this.getTarget(targetName)
    const value = target ? this.listRecord(target, listId)?.[1][1] : undefined
    return value ? [...value] : undefined
  }

  renameList(targetName: string, listId: string, name: string): void {
    const target = this.getTarget(targetName)
    const list = target ? this.listRecord(target, listId) : undefined
    if (!target || !list || !name.trim()) return
    const oldName = list[1][0]
    list[1][0] = name.trim()
    this.clearDataLookupCache(list[0])
    this.updateListNameReferences(list[0], list[2], oldName, list[1][0])
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  deleteList(targetName: string, listId: string): void {
    const target = this.getTarget(targetName)
    const list = target ? this.listRecord(target, listId) : undefined
    if (!target || !list) return
    this.removeListReferences(list[0], list[2], list[1][0])
    delete list[0].lists[list[2]]
    this.clearDataLookupCache(list[0])
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  private updateVariableNameReferences(owner: ScratchTarget | undefined, id: string, oldName: string, nextName: string): void {
    if (!owner) return
    const targets = owner.isStage ? this.project.targets : [owner]
    for (const target of targets) {
      for (const block of Object.values(target.blocks)) {
        const field = block.fields?.VARIABLE ?? block.fields?.VARIABLE_NAME
        if (field && (field[1] === id || field[0] === oldName)) field[0] = nextName
        updateDataLiteralInputReferences(block, 12, id, oldName, nextName)
      }
    }
    for (const monitor of this.project.monitors) {
      if (monitor.opcode === 'data_variable' && (monitor.id.endsWith(`:${id}`) || monitor.params.VARIABLE === oldName)) monitor.params.VARIABLE = nextName
    }
  }

  private updateListNameReferences(owner: ScratchTarget, id: string, oldName: string, nextName: string): void {
    const targets = owner.isStage ? this.project.targets : [owner]
    for (const target of targets) {
      for (const block of Object.values(target.blocks)) {
        const field = block.fields?.LIST ?? block.fields?.LIST_NAME
        if (field && (field[1] === id || field[0] === oldName)) field[0] = nextName
        updateDataLiteralInputReferences(block, 13, id, oldName, nextName)
      }
    }
    for (const monitor of this.project.monitors) {
      if (monitor.opcode === 'data_listcontents' && (monitor.id.endsWith(`:${id}`) || monitor.params.LIST === oldName)) monitor.params.LIST = nextName
    }
  }

  private removeVariableReferences(owner: ScratchTarget, id: string, name: string): void {
    const targets = owner.isStage ? this.project.targets : [owner]
    for (const target of targets) {
      removeBlocksWithFieldReference(target, ['VARIABLE', 'VARIABLE_NAME'], id, name)
      removeDataLiteralInputReferences(target, 12, id, name)
    }
    this.project.monitors = this.project.monitors.filter((monitor) => monitor.opcode !== 'data_variable' || (!monitor.id.endsWith(`:${id}`) && monitor.params.VARIABLE !== name))
  }

  private removeListReferences(owner: ScratchTarget, id: string, name: string): void {
    const targets = owner.isStage ? this.project.targets : [owner]
    for (const target of targets) {
      removeBlocksWithFieldReference(target, ['LIST', 'LIST_NAME'], id, name)
      removeDataLiteralInputReferences(target, 13, id, name)
    }
    this.project.monitors = this.project.monitors.filter((monitor) => monitor.opcode !== 'data_listcontents' || (!monitor.id.endsWith(`:${id}`) && monitor.params.LIST !== name))
  }

  getMonitors(): ScratchMonitor[] {
    return structuredClone(this.project.monitors)
  }

  setMonitorVisible(id: string, visible: boolean): void {
    const monitor = this.project.monitors.find((item) => item.id === id)
    if (!monitor) return
    monitor.visible = visible
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  requestShowMonitor(id: string): void {
    this.setMonitorVisible(id, true)
  }

  requestHideMonitor(id: string): void {
    this.setMonitorVisible(id, false)
  }

  requestRemoveMonitor(id: string): void {
    this.project.monitors = this.project.monitors.filter((monitor) => monitor.id !== id)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  requestUpdateMonitor(monitor: Partial<ScratchMonitor> | ScratchMonitor | Map<string, unknown>): void {
    const patch = monitorPatch(monitor)
    if (!patch.id) return
    const index = this.project.monitors.findIndex((item) => item.id === patch.id)
    if (index >= 0) this.project.monitors[index] = normalizeMonitorPatch(this.project.monitors[index]!, patch)
    else this.project.monitors.push(normalizeMonitorPatch(undefined, patch))
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  requestAddMonitor(monitor: Partial<ScratchMonitor> | ScratchMonitor | Map<string, unknown>): void {
    this.requestUpdateMonitor(monitor)
  }

  setMonitorMode(id: string, mode: ScratchMonitor['mode']): void {
    this.requestUpdateMonitor({ id, mode })
  }

  setMonitorSliderRange(id: string, sliderMin: number, sliderMax: number, isDiscrete = false): void {
    this.requestUpdateMonitor({ id, mode: 'slider', sliderMin, sliderMax, isDiscrete })
  }

  setMonitorPosition(id: string, x: number, y: number): void {
    this.requestUpdateMonitor({ id, x, y })
  }

  upsertVariableMonitor(targetName: string, variableId: string, visible = true): void {
    const target = this.getTarget(targetName)
    const variable = target?.variables[variableId]
    if (!target || !variable) return
    const id = `${target.id ?? target.name}:${variableId}`
    const monitor: ScratchMonitor = {
      id,
      mode: 'default',
      opcode: 'data_variable',
      params: { VARIABLE: variable[0] },
      spriteName: target.isStage ? undefined : target.name,
      value: variable[1],
      visible,
    }
    const index = this.project.monitors.findIndex((item) => item.id === id)
    if (index >= 0) this.project.monitors[index] = monitor
    else this.project.monitors.push(monitor)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  upsertListMonitor(targetName: string, listId: string, visible = true): void {
    const target = this.getTarget(targetName)
    const list = target?.lists[listId]
    if (!target || !list) return
    const id = `${target.id ?? target.name}:${listId}`
    const monitor: ScratchMonitor = {
      id,
      mode: 'list',
      opcode: 'data_listcontents',
      params: { LIST: list[0] },
      spriteName: target.isStage ? undefined : target.name,
      value: [...list[1]],
      visible,
    }
    const index = this.project.monitors.findIndex((item) => item.id === id)
    if (index >= 0) this.project.monitors[index] = monitor
    else this.project.monitors.push(monitor)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  upsertBlockMonitor(targetName: string, opcode: string, params: Record<string, ScratchValue> = {}, visible = true): void {
    const target = this.getTarget(targetName) ?? this.getSelectedTarget() ?? this.getStage()
    const normalizedParams = Object.fromEntries(Object.entries(params).map(([key, value]) => [key, toScratchValue(value)]))
    const id = monitorIdForOpcode(target, opcode, normalizedParams)
    const block: ScratchBlock = {
      opcode,
      fields: monitorParamsToFields(normalizedParams),
      inputs: {},
      next: null,
      parent: null,
      shadow: false,
    }
    const monitor: ScratchMonitor = {
      id,
      mode: 'default',
      opcode,
      params: normalizedParams,
      spriteName: isSpriteSpecificMonitor(opcode) && !target.isStage ? target.name : undefined,
      value: this.reporterValue(target, block),
      visible,
    }
    const index = this.project.monitors.findIndex((item) => item.id === id)
    if (index >= 0) this.project.monitors[index] = normalizeMonitorPatch(this.project.monitors[index]!, monitor)
    else this.project.monitors.push(monitor)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
  }

  addCostume(targetNameOrMd5ext: string, costume: Partial<ScratchCostume>, optTargetId?: string): Promise<number> {
    const target = this.getTarget(optTargetId ?? targetNameOrMd5ext) ?? this.getSelectedTarget()
    if (!target) return Promise.resolve(-1)
    const nextCostume = { ...costume }
    if (!this.getTarget(targetNameOrMd5ext) && !nextCostume.md5ext) {
      nextCostume.md5ext = targetNameOrMd5ext
      nextCostume.assetId = stripExtension(targetNameOrMd5ext)
      nextCostume.dataFormat = extensionFromMd5ext(targetNameOrMd5ext) ?? nextCostume.dataFormat
    }
    target.costumes.push(normalizeCostume(nextCostume, target.costumes.length, target.isStage))
    target.currentCostume = target.costumes.length - 1
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(target.currentCostume)
  }

  addCostumeFromLibrary(md5ext: string, costume: Partial<ScratchCostume>): Promise<number> {
    return this.addCostume(md5ext, costume, this.selectedTargetId)
  }

  duplicateCostume(targetNameOrIndex: string | number, index?: number): Promise<number> {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const costumeIndex = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : index ?? 0
    const costume = target?.costumes[costumeIndex]
    if (!target || !costume) return Promise.resolve(-1)
    target.costumes.splice(costumeIndex + 1, 0, { ...structuredClone(costume), name: uniqueAssetName(target.costumes.map((item) => item.name), `${costume.name} copy`) })
    target.currentCostume = costumeIndex + 1
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(target.currentCostume)
  }

  renameCostume(targetNameOrIndex: string | number, indexOrName: number | string, maybeName?: string): boolean {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : Number(indexOrName)
    const name = typeof targetNameOrIndex === 'number' ? String(indexOrName) : String(maybeName ?? '')
    const costume = target?.costumes[index]
    if (!costume || !name.trim()) return false
    costume.name = name.trim()
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return true
  }

  async updateCostume(targetName: string, index: number, patch: Partial<ScratchCostume>, data?: Uint8Array | ArrayBuffer): Promise<void>
  async updateCostume(index: number, patch: Partial<ScratchCostume>, data?: Uint8Array | ArrayBuffer): Promise<void>
  async updateCostume(targetNameOrIndex: string | number, indexOrPatch: number | Partial<ScratchCostume>, patchOrData?: Partial<ScratchCostume> | Uint8Array | ArrayBuffer, maybeData?: Uint8Array | ArrayBuffer): Promise<void> {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : Number(indexOrPatch)
    const patch = (typeof targetNameOrIndex === 'number' ? indexOrPatch : patchOrData) as Partial<ScratchCostume> | undefined
    const data = byteSourceToUint8Array(typeof targetNameOrIndex === 'number' ? patchOrData : maybeData)
    const costume = target?.costumes[index]
    if (!costume) return
    Object.assign(costume, patch ?? {})
    if (data) {
      const dataFormat = costume.dataFormat ?? patch?.dataFormat ?? 'svg'
      const asset = await this.storeAsset(data, dataFormat)
      costume.assetId = asset.assetId
      costume.md5ext = asset.md5ext
      costume.dataFormat = dataFormat
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  deleteCostume(targetNameOrIndex: string | number, maybeIndex?: number): (() => void) | null {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : maybeIndex ?? 0
    if (!target || target.costumes.length <= 1 || !target.costumes[index]) return null
    const selected = target.costumes[target.currentCostume]
    const [removed] = target.costumes.splice(index, 1)
    const selectedIndex = selected && selected !== removed ? target.costumes.indexOf(selected) : -1
    target.currentCostume = selectedIndex >= 0 ? selectedIndex : bounded(index, 0, target.costumes.length - 1)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    if (!removed) return null
    return () => {
      target.costumes.splice(bounded(index, 0, target.costumes.length), 0, structuredClone(removed))
      target.currentCostume = bounded(index, 0, target.costumes.length - 1)
      this.emit('PROJECT_CHANGED', this.snapshot())
      this.emit('TARGETS_UPDATE', this.snapshot())
    }
  }

  reorderCostume(targetName: string, from: number, to: number): boolean {
    const target = this.getTarget(targetName)
    if (!target?.costumes[from]) return false
    const selected = target.costumes[target.currentCostume]
    const [costume] = target.costumes.splice(from, 1)
    if (!costume) return false
    target.costumes.splice(bounded(Math.floor(to), 0, target.costumes.length), 0, costume)
    target.currentCostume = selected ? Math.max(0, target.costumes.indexOf(selected)) : bounded(target.currentCostume, 0, target.costumes.length - 1)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return true
  }

  setCurrentCostume(targetName: string, index: number): void {
    const target = this.getTarget(targetName)
    if (!target?.costumes.length) return
    target.currentCostume = bounded(Math.floor(index), 0, target.costumes.length - 1)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  getCostume(index: number, targetName = this.selectedTargetId): ScratchCostume | string | undefined {
    const costume = this.getTarget(targetName)?.costumes[index]
    if (arguments.length === 1 && costume) {
      const key = costume.md5ext ?? costume.assetId
      const bytes = key ? this.assetBytes.get(key) ?? this.assetBytes.get(costume.assetId ?? '') : undefined
      if (bytes && costume.dataFormat === 'svg') return strFromU8(bytes)
      if (bytes && (costume.dataFormat === 'png' || costume.dataFormat === 'jpg' || costume.dataFormat === 'jpeg')) {
        const format = costume.dataFormat === 'jpg' ? 'jpeg' : costume.dataFormat
        return `data:image/${format};base64,${bytesToBase64(bytes)}`
      }
    }
    return costume ? structuredClone(costume) : undefined
  }

  async updateSvg(index: number, svg: string | Uint8Array, rotationCenterX = 48, rotationCenterY = 48, targetName = this.selectedTargetId): Promise<void> {
    const data = typeof svg === 'string' ? strToU8(svg) : svg
    await this.updateCostume(targetName, index, { dataFormat: 'svg', rotationCenterX, rotationCenterY }, data)
  }

  async updateBitmap(index: number, bitmap: Uint8Array | ImageData | HTMLCanvasElement, rotationCenterX = 48, rotationCenterY = 48, bitmapResolution = 1, targetName = this.selectedTargetId): Promise<void> {
    const bytes = await bitmapToPngBytes(bitmap)
    await this.updateCostume(targetName, index, { dataFormat: 'png', rotationCenterX, rotationCenterY, bitmapResolution }, bytes)
  }

  addBackdrop(md5ext: string, backdrop: Partial<ScratchCostume>): Promise<number> {
    return this.addCostume(md5ext, backdrop, this.getStage().id ?? this.getStage().name)
  }

  shareCostumeToTarget(costumeIndex: number, targetId: string, sourceId = this.selectedTargetId): Promise<boolean> {
    const source = this.getTarget(sourceId) ?? this.getSelectedTarget()
    const target = this.getTarget(targetId)
    const costume = source.costumes[costumeIndex]
    if (!target || !costume) return Promise.resolve(false)
    target.costumes.push({ ...structuredClone(costume), name: uniqueAssetName(target.costumes.map((item) => item.name), costume.name) })
    target.currentCostume = target.costumes.length - 1
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(true)
  }

  addSound(targetNameOrSound: string | Partial<ScratchSound>, maybeSound?: Partial<ScratchSound> | string): Promise<number> {
    const target =
      typeof targetNameOrSound === 'string'
        ? this.getTarget(targetNameOrSound)
        : typeof maybeSound === 'string'
          ? this.getTarget(maybeSound)
          : this.getSelectedTarget()
    const sound = typeof targetNameOrSound === 'string' ? (isObject(maybeSound) ? maybeSound : undefined) : targetNameOrSound
    if (!target) return Promise.resolve(-1)
    target.sounds.push(normalizeSound(sound ?? {}, target.sounds.length))
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(target.sounds.length - 1)
  }

  duplicateSound(targetNameOrIndex: string | number, index?: number): Promise<number> {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const soundIndex = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : index ?? 0
    const sound = target?.sounds[soundIndex]
    if (!target || !sound) return Promise.resolve(-1)
    target.sounds.splice(soundIndex + 1, 0, { ...structuredClone(sound), name: uniqueAssetName(target.sounds.map((item) => item.name), `${sound.name} copy`) })
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(soundIndex + 1)
  }

  renameSound(targetNameOrIndex: string | number, indexOrName: number | string, maybeName?: string): boolean {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : Number(indexOrName)
    const name = typeof targetNameOrIndex === 'number' ? String(indexOrName) : String(maybeName ?? '')
    const sound = target?.sounds[index]
    if (!sound || !name.trim()) return false
    sound.name = name.trim()
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return true
  }

  async getSoundBuffer(targetNameOrIndex: string | number, maybeIndex?: number): Promise<Uint8Array | undefined> {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : maybeIndex ?? 0
    const sound = target?.sounds[index]
    if (!sound) return undefined
    const key = sound.md5ext ?? sound.assetId
    return key ? this.loadAsset(key, sound.dataFormat ?? 'wav') : undefined
  }

  async updateSoundBuffer(targetNameOrIndex: string | number, indexOrData: number | Uint8Array | ArrayBuffer | AudioBuffer, dataOrPatch?: Uint8Array | ArrayBuffer | Partial<ScratchSound>, patch: Partial<ScratchSound> = {}): Promise<void> {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : Number(indexOrData)
    const dataSource = typeof targetNameOrIndex === 'number' && isByteSource(dataOrPatch) ? dataOrPatch : typeof targetNameOrIndex === 'number' ? indexOrData : dataOrPatch
    const data = byteSourceToUint8Array(dataSource)
    const audioBuffer = typeof AudioBuffer !== 'undefined' && indexOrData instanceof AudioBuffer ? indexOrData : undefined
    const nextPatch = (typeof targetNameOrIndex === 'number' ? (isObject(dataOrPatch) && !isByteSource(dataOrPatch) ? dataOrPatch : undefined) : patch) as Partial<ScratchSound> | undefined
    const sound = target?.sounds[index]
    if (!sound) return
    Object.assign(sound, nextPatch ?? {})
    if (audioBuffer) {
      sound.rate = audioBuffer.sampleRate
      sound.sampleCount = audioBuffer.length
      sound.format = ''
    }
    if (data) {
      const dataFormat = sound.dataFormat ?? nextPatch?.dataFormat ?? 'wav'
      const asset = await this.storeAsset(data, dataFormat)
      sound.assetId = asset.assetId
      sound.md5ext = asset.md5ext
      sound.dataFormat = dataFormat
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  deleteSound(targetNameOrIndex: string | number, maybeIndex?: number): (() => void) | undefined {
    const target = typeof targetNameOrIndex === 'number' ? this.getSelectedTarget() : this.getTarget(targetNameOrIndex)
    const index = typeof targetNameOrIndex === 'number' ? targetNameOrIndex : maybeIndex ?? 0
    if (!target?.sounds[index]) return
    const [removed] = target.sounds.splice(index, 1)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    if (!removed) return undefined
    return () => {
      target.sounds.splice(bounded(index, 0, target.sounds.length), 0, structuredClone(removed))
      this.emit('PROJECT_CHANGED', this.snapshot())
      this.emit('TARGETS_UPDATE', this.snapshot())
    }
  }

  reorderSound(targetName: string, from: number, to: number): boolean {
    const target = this.getTarget(targetName)
    if (!target?.sounds[from]) return false
    const [sound] = target.sounds.splice(from, 1)
    if (!sound) return false
    target.sounds.splice(bounded(Math.floor(to), 0, target.sounds.length), 0, sound)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return true
  }

  shareSoundToTarget(soundIndex: number, targetId: string, sourceId = this.selectedTargetId): Promise<boolean> {
    const source = this.getTarget(sourceId) ?? this.getSelectedTarget()
    const target = this.getTarget(targetId)
    const sound = source.sounds[soundIndex]
    if (!target || !sound) return Promise.resolve(false)
    target.sounds.push({ ...structuredClone(sound), name: uniqueAssetName(target.sounds.map((item) => item.name), sound.name) })
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
    return Promise.resolve(true)
  }

  addBlock(targetName: string, block: ScratchBlock, id = makeId('block')): string {
    const target = this.getTarget(targetName)
    if (!target) return id
    target.blocks[id] = { ...block }
    setBlockRuntimeId(target.blocks[id]!, id)
    this.clearReporterCache()
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('BLOCKS_NEED_UPDATE', this.snapshot())
    return id
  }

  deleteBlock(targetName: string, id: string): void {
    const target = this.getTarget(targetName)
    if (!target?.blocks[id]) return
    const removeIds = childBlockClosure(target.blocks, new Set([id]))
    for (const blockId of removeIds) delete target.blocks[blockId]
    this.clearReporterCache()
    for (const block of Object.values(target.blocks)) {
      if (block.next && removeIds.has(block.next)) block.next = null
      if (block.parent && removeIds.has(block.parent)) block.parent = null
      for (const input of Object.values(block.inputs ?? {})) {
        if (typeof input[1] === 'string' && removeIds.has(input[1])) input[1] = null
        if (typeof input[2] === 'string' && removeIds.has(input[2])) input[2] = null
      }
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  blockListener(event: unknown): void {
    this.applyBlockEvent(this.selectedTargetId, event)
  }

  flyoutBlockListener(event: unknown): void {
    this.emit('FLYOUT_BLOCK_EVENT', event)
  }

  monitorBlockListener(event: unknown): void {
    this.emit('MONITOR_BLOCK_EVENT', event)
    if (!isObject(event)) return
    const type = String(event.type ?? event.eventType ?? '').toLowerCase()
    const monitor = isObject(event.monitor) ? event.monitor : event
    const id = String(monitor.id ?? event.monitorId ?? event.blockId ?? '')
    if (!id && !['create', 'add', 'monitor_create', 'monitor_add'].includes(type)) return
    if (type === 'delete' || type === 'remove' || type === 'monitor_delete' || type === 'monitor_remove') {
      this.requestRemoveMonitor(id)
      return
    }
    if (type === 'hide' || type === 'monitor_hide') {
      this.requestHideMonitor(id)
      return
    }
    if (type === 'show' || type === 'monitor_show') {
      this.requestShowMonitor(id)
      return
    }
    if (type === 'create' || type === 'add' || type === 'change' || type === 'update' || type === 'monitor_create' || type === 'monitor_add' || type === 'monitor_change' || type === 'monitor_update') {
      this.requestUpdateMonitor({
        id: id || makeId('monitor'),
        mode: typeof monitor.mode === 'string' ? monitor.mode : undefined,
        opcode: typeof monitor.opcode === 'string' ? monitor.opcode : undefined,
        params: isObject(monitor.params) ? monitor.params as Record<string, ScratchValue> : undefined,
        spriteName: typeof monitor.spriteName === 'string' ? monitor.spriteName : undefined,
        value: Array.isArray(monitor.value) ? monitor.value.map(toScratchValue) : monitor.value === undefined ? undefined : toScratchValue(monitor.value),
        width: optionalNumber(monitor.width),
        height: optionalNumber(monitor.height),
        x: optionalNumber(monitor.x),
        y: optionalNumber(monitor.y),
        visible: monitor.visible === undefined ? undefined : monitor.visible !== false,
        sliderMin: optionalNumber(monitor.sliderMin),
        sliderMax: optionalNumber(monitor.sliderMax),
        isDiscrete: monitor.isDiscrete === true,
      })
    }
  }

  variableListener(event: unknown): void {
    if (!isObject(event)) return
    const target = this.getSelectedTarget()
    const id = String(event.varId ?? event.variableId ?? makeId('variable'))
    if (event.type === 'var_create' || event.type === 'create') {
      target.variables[id] = [String(event.varName ?? event.name ?? 'variable'), toScratchValue(event.value ?? 0), event.isCloud === true]
    } else if (event.type === 'var_rename' || event.type === 'rename') {
      const variable = this.variableRecord(target, id)
      const nextName = String(event.newName ?? event.varName ?? event.name ?? variable?.[1][0] ?? '')
      if (variable && nextName) this.renameVariable(target.id ?? target.name, id, nextName)
      return
    } else if (event.type === 'var_delete' || event.type === 'delete') {
      this.deleteVariable(target.id ?? target.name, id)
      return
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  listListener(event: unknown): void {
    if (!isObject(event)) return
    const target = this.getSelectedTarget()
    const id = String(event.listId ?? event.varId ?? event.variableId ?? makeId('list'))
    if (event.type === 'list_create' || event.type === 'var_create' || event.type === 'create') {
      const value = Array.isArray(event.value) ? event.value.map(toScratchValue) : []
      target.lists[id] = [String(event.listName ?? event.varName ?? event.name ?? 'list'), value]
    } else if (event.type === 'list_rename' || event.type === 'var_rename' || event.type === 'rename') {
      const list = this.listRecord(target, id)
      const nextName = String(event.newName ?? event.listName ?? event.varName ?? event.name ?? list?.[1][0] ?? '')
      if (list && nextName) this.renameList(target.id ?? target.name, id, nextName)
      return
    } else if (event.type === 'list_delete' || event.type === 'var_delete' || event.type === 'delete') {
      this.deleteList(target.id ?? target.name, id)
      return
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('MONITORS_UPDATE', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  clearFlyoutBlocks(): void {
    this.emit('FLYOUT_BLOCKS_CLEARED', this.snapshot())
  }

  refreshWorkspace(): void {
    this.emitWorkspaceUpdate()
  }

  emitTargetsUpdate(triggerProjectChange = false): void {
    if (triggerProjectChange) this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  emitWorkspaceUpdate(): void {
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  requestBlocksUpdate(): void {
    this.emit('BLOCKS_NEED_UPDATE', this.snapshot())
  }

  requestToolboxExtensionsUpdate(): void {
    this.emit('TOOLBOX_EXTENSIONS_NEED_UPDATE', this.snapshot())
  }

  quietGlow(scriptBlockId: string): void {
    this.emitScriptGlow(scriptBlockId, false)
  }

  glowBlock(blockId: string, isGlowing: boolean): void {
    this.emitBlockGlow(blockId, isGlowing)
  }

  glowScript(topBlockId: string, isGlowing: boolean): void {
    this.emitScriptGlow(topBlockId, isGlowing)
  }

  emitBlockDragUpdate(areBlocksOverGui: boolean): void {
    this.emit('BLOCK_DRAG_UPDATE', areBlocksOverGui)
  }

  emitBlockEndDrag(blocks: ScratchBlock[], topBlockId: string): void {
    this.emit('BLOCK_DRAG_END', structuredClone(blocks), topBlockId)
  }

  visualReport(blockId: string, value: ScratchValue): void {
    this.emit('VISUAL_REPORT', { id: blockId, value: String(value) })
  }

  private emitBlockGlow(blockId: string, isGlowing: boolean): void {
    if (isGlowing) this.blockGlowIds.add(blockId)
    else this.blockGlowIds.delete(blockId)
    this.emit(isGlowing ? 'BLOCK_GLOW_ON' : 'BLOCK_GLOW_OFF', { id: blockId, blockId })
  }

  private emitScriptGlow(topBlockId: string, isGlowing: boolean): void {
    if (isGlowing) this.scriptGlowIds.add(topBlockId)
    else this.scriptGlowIds.delete(topBlockId)
    this.emit(isGlowing ? 'SCRIPT_GLOW_ON' : 'SCRIPT_GLOW_OFF', { id: topBlockId, blockId: topBlockId })
  }

  private clearGlows(): void {
    const blockIds = [...this.blockGlowIds]
    const scriptIds = [...this.scriptGlowIds]
    this.blockGlowIds.clear()
    this.scriptGlowIds.clear()
    for (const blockId of blockIds) this.emit('BLOCK_GLOW_OFF', { id: blockId, blockId })
    for (const blockId of scriptIds) this.emit('SCRIPT_GLOW_OFF', { id: blockId, blockId })
  }

  addComment(targetName: string, id: string, comment: unknown): void {
    const target = this.getTarget(targetName)
    if (!target) return
    target.comments[id] = structuredClone(comment)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  updateComment(targetName: string, id: string, patch: unknown): void {
    const target = this.getTarget(targetName)
    if (!target) return
    const current = isObject(target.comments[id]) && isObject(patch) ? { ...target.comments[id], ...patch } : patch
    target.comments[id] = structuredClone(current)
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  deleteComment(targetName: string, id: string): void {
    const target = this.getTarget(targetName)
    if (!target) return
    delete target.comments[id]
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
  }

  getToolbox(_targetName = this.selectedTargetId): typeof blockPalette {
    return blockPalette
  }

  blocksXml(targetNameOrTarget: string | ScratchTarget = this.selectedTargetId): string {
    const target = typeof targetNameOrTarget === 'string' ? this.getTarget(targetNameOrTarget) : targetNameOrTarget
    const categories = this.getToolbox(target?.name ?? this.selectedTargetId)
      .map((category) => `<category name="${escapeXmlText(category.category)}" colour="${category.color}">${category.opcodes.map((opcode) => `<block type="${escapeXmlText(opcode)}"></block>`).join('')}</category>`)
      .join('')
    return `<xml>${categories}</xml>`
  }

  getBlocksXML(target?: ScratchTarget): string {
    return this.blocksXml(target ?? this.getSelectedTarget())
  }

  getBlocksJSON(): typeof blockPalette {
    return this.getToolbox()
  }

  getWorkspace(targetName = this.selectedTargetId): ScratchBlock[] {
    return Object.values(this.getTarget(targetName)?.blocks ?? {}).map((block) => structuredClone(block))
  }

  getTargetIdForDrawableId(drawableId: number | string): string | null {
    const target =
      typeof drawableId === 'number'
        ? this.project.targets.find((item) => !item.isStage && (item.drawableId === drawableId || item.layerOrder === drawableId))
        : this.getTarget(drawableId) ?? this.project.targets.find((item) => !item.isStage && String(item.drawableId) === drawableId)
    if (!target || target.isStage) return null
    return target.id ?? target.name
  }

  applyWorkspaceChange(targetName: string, change: WorkspaceChange): void {
    if (change.blocks) this.replaceWorkspace(targetName, change.blocks)
  }

  shareBlocksToTarget(blocks: Record<string, ScratchBlock>, targetId: string, fromTargetId?: string): Promise<boolean> {
    const target = this.getTarget(targetId)
    if (!target) return Promise.resolve(false)
    const source = fromTargetId ? this.getTarget(fromTargetId) : this.getSelectedTarget()
    target.blocks = { ...target.blocks, ...cloneSharedBlocks(blocks, target.blocks) }
    this.clearReporterCache()
    if (source && source !== target) {
      for (const [id, variable] of Object.entries(source.variables)) {
        if (!target.variables[id]) target.variables[id] = structuredClone(variable)
      }
      for (const [id, list] of Object.entries(source.lists)) {
        if (!target.lists[id]) target.lists[id] = structuredClone(list)
      }
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    this.emit('BLOCKS_NEED_UPDATE', this.snapshot())
    return Promise.resolve(true)
  }

  replaceWorkspace(targetName: string, blocks: Record<string, ScratchBlock>): void {
    const target = this.getTarget(targetName)
    if (!target) return
    target.blocks = normalizeBlocks(blocks)
    this.clearReporterCache()
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    this.emit('BLOCKS_NEED_UPDATE', this.snapshot())
  }

  private applyBlockEvent(targetName: string, event: unknown): void {
    if (!isObject(event)) return
    const target = this.getTarget(targetName)
    if (!target) return
    const blockId = typeof event.blockId === 'string' ? event.blockId : typeof event.id === 'string' ? event.id : undefined
    if (event.type === 'create' && isObject(event.block)) {
      const id = blockId ?? String(event.block.id ?? makeId('block'))
      target.blocks[id] = normalizeBlocks({ [id]: event.block })[id] ?? { opcode: String(event.block.opcode ?? 'unknown'), next: null, parent: null }
      setBlockRuntimeId(target.blocks[id]!, id)
      this.clearReporterCache()
    } else if (event.type === 'delete' && blockId) {
      delete target.blocks[blockId]
      this.clearReporterCache()
    } else if ((event.type === 'change' || event.type === 'block_field_intermediate_change') && blockId) {
      const block = target.blocks[blockId]
      if (block) {
        applyBlockChange(block, event)
        this.clearReporterCache()
      }
    } else if (event.type === 'comment_create' && typeof event.commentId === 'string') {
      target.comments[event.commentId] = structuredClone(event)
    } else if (event.type === 'comment_delete' && typeof event.commentId === 'string') {
      delete target.comments[event.commentId]
    } else if (event.type === 'comment_change' && typeof event.commentId === 'string') {
      const existing = target.comments[event.commentId]
      const previous: Record<string, unknown> = isObject(existing) ? existing : {}
      target.comments[event.commentId] = { ...previous, ...event }
    }
    this.emit('PROJECT_CHANGED', this.snapshot())
    this.emit('WORKSPACE_UPDATE', this.snapshot())
    this.emit('BLOCKS_NEED_UPDATE', this.snapshot())
  }

  greenFlag(): void {
    const hadClones = this.project.targets.some((target) => target.isClone)
    this.project.targets = this.project.targets.filter((target) => !target.isClone)
    this.resetExecutionState()
    for (const target of this.project.targets) target.speechBubble = undefined
    callAudio(this.audioEngine, 'stopAllSounds')
    for (const target of [...this.project.targets].sort((a, b) => (a.layerOrder ?? 0) - (b.layerOrder ?? 0))) {
      for (const [id, block] of Object.entries(target.blocks)) {
        if (block.opcode === 'event_whenflagclicked') this.startThread(target, id)
      }
    }
    this.running = this.threads.length > 0
    this.lastStep = Date.now()
    this.emit('PROJECT_START', this.snapshot())
    this.emit('PROJECT_RUN_START', this.snapshot())
    if (hadClones) this.emit('TARGETS_UPDATE', this.snapshot())
    this.emit('RUNTIME_STEP', this.snapshot())
  }

  broadcast(message: string): void {
    this.startBroadcast(message)
    this.running = this.threads.some((thread) => !thread.done)
    this.emit('RUNTIME_STEP', this.snapshot())
  }

  clickTarget(targetIdOrName: string): void {
    const target = this.getTarget(targetIdOrName)
    if (!target) return
    this.startClickHats(target)
  }

  startKeyHats(key: string): void {
    const normalized = normalizeKeyName(key)
    const wasRunning = this.running
    const started: RuntimeThread[] = []
    for (const { target, id, block } of this.hatsForOpcode('event_whenkeypressed')) {
      const option = normalizeKeyName(block.fields?.KEY_OPTION?.[0] ?? '')
      if (option === 'any' || option === normalized) started.push(this.startThread(target, id))
    }
    this.running = this.threads.some((thread) => !thread.done)
    if (started.length > 0) {
      const snapshot = this.snapshot()
      if (!wasRunning) {
        this.emit('PROJECT_START', snapshot)
        this.emit('PROJECT_RUN_START', snapshot)
      }
      this.emit('RUNTIME_STEP', snapshot)
    }
  }

  private startMatchingHats(opcode: string, targetFilter?: ScratchTarget): RuntimeThread[] {
    const started: RuntimeThread[] = []
    for (const { target, id } of this.hatsForOpcode(opcode)) {
      if (targetFilter && target !== targetFilter) continue
      started.push(this.startThread(target, id))
    }
    return started
  }

  private startClickHats(target: ScratchTarget): RuntimeThread[] {
    const wasRunning = this.running
    const started = [
      ...this.startMatchingHats('event_whenthisspriteclicked', target),
      ...this.startMatchingHats('event_whenstageclicked', target),
    ]
    if (started.length === 0) return started
    this.running = this.threads.some((thread) => !thread.done)
    const snapshot = this.snapshot()
    if (!wasRunning) {
      this.emit('PROJECT_START', snapshot)
      this.emit('PROJECT_RUN_START', snapshot)
    }
    this.emit('RUNTIME_STEP', snapshot)
    return started
  }

  private handleMouseData(data: unknown): void {
    const previous = this.ioData.get('mouse')
    const normalized = normalizeMouseData(data)
    this.ioData.set('mouse', normalized)
    const previousDown = mouseButtonDown(previous)
    const nextDown = mouseButtonDown(normalized)
    if (previousDown === nextDown) return
    if (normalized.wasDragged === true) return
    if (!pointInsideStage(normalized.x, normalized.y)) return
    const target = this.pickMouseTarget(normalized.x, normalized.y)
    if (!target) return
    const isPress = !previousDown && nextDown
    const isRelease = previousDown && !nextDown
    if ((target.draggable && isRelease) || (!target.draggable && isPress)) this.startClickHats(target)
  }

  private pickMouseTarget(x: number, y: number): ScratchTarget | undefined {
    const picked = this.renderer?.pick?.(x, y)
    if (picked) {
      const pickedTarget = this.getTarget(picked) ?? this.getTargetIdForDrawableId(picked)
      if (typeof pickedTarget === 'string') return this.getTarget(pickedTarget)
      if (pickedTarget) return pickedTarget
    }
    const geometric = this.project.targets
      .filter((target) => !target.isStage && target.visible !== false)
      .sort((a, b) => (b.layerOrder ?? 0) - (a.layerOrder ?? 0))
      .find((target) => pointInBounds(x, y, targetBounds(target)))
    return geometric ?? this.getStage()
  }

  private startBackdropHats(backdropName: string): void {
    for (const { target, id, block } of this.hatsForOpcode('event_whenbackdropswitchesto')) {
      if (block.fields?.BACKDROP?.[0] === backdropName) this.startThread(target, id)
    }
  }

  private startGreaterThanHats(now = Date.now()): void {
    for (const { target, id, block } of this.hatsForOpcode('event_whengreaterthan')) {
      if (this.threads.some((thread) => thread.target === target && thread.topBlockId === id && !thread.done)) continue
      const menu = String(block.fields?.WHENGREATERTHANMENU?.[0] ?? 'TIMER').toLowerCase()
      const threshold = Cast.toNumber(this.inputValue(target, block, 'VALUE', 10))
      const value = menu === 'loudness' ? loudnessValue(this.ioData.get('audio')) : (now - this.timerStart) / 1000
      const key = `${target.id ?? target.name}:${id}`
      const active = value > threshold
      const wasActive = this.greaterThanHatState.get(key) === true
      this.greaterThanHatState.set(key, active)
      if (active && !wasActive) this.startThread(target, id)
    }
  }

  private startTouchingObjectHats(): void {
    for (const { target, id, block } of this.hatsForOpcode('event_whentouchingobject')) {
      if (this.threads.some((thread) => thread.target === target && thread.topBlockId === id && !thread.done)) continue
      const option = String(this.inputValue(target, block, 'TOUCHINGOBJECTMENU', block.fields?.TOUCHINGOBJECTMENU?.[0] ?? '_mouse_'))
      const key = `${target.id ?? target.name}:${id}`
      const active = this.touchingObject(target, option)
      const wasActive = this.touchingHatState.get(key) === true
      this.touchingHatState.set(key, active)
      if (active && !wasActive) this.startThread(target, id)
    }
  }

  private startExtensionHats(): void {
    for (const { target, id, block } of this.extensionHats()) {
      if (this.threads.some((thread) => thread.target === target && thread.topBlockId === id && !thread.done)) continue
      const key = `${target.id ?? target.name}:${id}`
      const active = this.extensionHatActive(target, block)
      const wasActive = this.extensionHatState.get(key) === true
      this.extensionHatState.set(key, active)
      if (active && !wasActive) this.startThread(target, id)
    }
  }

  private startBroadcast(message: string): RuntimeThread[] {
    const started: RuntimeThread[] = []
    for (const { target, id, block } of this.hatsForOpcode('event_whenbroadcastreceived')) {
      const field = block.fields?.BROADCAST_OPTION?.[0]
      if (field === message) started.push(this.startThread(target, id))
    }
    return started
  }

  private hatsForOpcode(opcode: string): HatEntry[] {
    const cached = this.hatCache.get(opcode)
    if (cached) return cached
    const entries: HatEntry[] = []
    for (const target of this.project.targets) {
      for (const [id, block] of Object.entries(target.blocks)) {
        if (block.opcode === opcode) entries.push({ target, id, block })
      }
    }
    this.hatCache.set(opcode, entries)
    return entries
  }

  private extensionHats(): HatEntry[] {
    const cached = this.hatCache.get('*extension*')
    if (cached) return cached
    const entries: HatEntry[] = []
    for (const target of this.project.targets) {
      for (const [id, block] of Object.entries(target.blocks)) {
        if (isExtensionHatOpcode(block.opcode)) entries.push({ target, id, block })
      }
    }
    this.hatCache.set('*extension*', entries)
    return entries
  }

  stopAll(): void {
    this.stopAllGeneration += 1
    this.threads = []
    this.project.targets = this.project.targets.filter((target) => !target.isClone)
    for (const target of this.project.targets) target.speechBubble = undefined
    callAudio(this.audioEngine, 'stopAllSounds')
    this.running = false
    this.clearGlows()
    this.emit('QUESTION', { question: null })
    this.emit('SOUNDS_STOPPED', this.snapshot())
    this.emit('PROJECT_RUN_STOP', this.snapshot())
    this.emit('PROJECT_STOP_ALL', this.snapshot())
    this.emit('TARGETS_UPDATE', this.snapshot())
  }

  step(now = Date.now()): RuntimeSnapshot {
    const delta = Math.max(0, now - this.lastStep)
    this.lastStep = now
    const stopAllGenerationBeforeStep = this.stopAllGeneration
    this.startGreaterThanHats(now)
    this.startTouchingObjectHats()
    this.startExtensionHats()
    const hadRunnableThreads = this.threads.some((thread) => !thread.done)
    let completedDrawableFrame = true
    this.runtimeStepActive = true
    try {
      for (const thread of this.threads) {
        if (!thread.done) completedDrawableFrame = this.stepThread(thread, now, delta) && completedDrawableFrame
      }
    } finally {
      this.runtimeStepActive = false
    }
    if (this.runtimeLayerOrderDirty) {
      normalizeLayerOrder(this.project)
      this.runtimeLayerOrderDirty = false
    }
    this.threads = this.threads.filter((thread) => !thread.done)
    this.running = this.threads.length > 0
    const snapshot = this.runtimeSnapshot()
    this.renderer?.requestDraw?.(snapshot)
    this.emit('RUNTIME_STEP', snapshot)
    if (this.runtimeTargetsChanged) {
      this.runtimeTargetsChanged = false
      this.emit('TARGETS_UPDATE', snapshot)
    }
    if (hadRunnableThreads && !this.running && this.stopAllGeneration === stopAllGenerationBeforeStep) this.emit('PROJECT_RUN_STOP', snapshot)
    return snapshot
  }

  private startThread(target: ScratchTarget, topBlockId: string): RuntimeThread {
    const topBlock = target.blocks[topBlockId]
    const thread = {
      target,
      topBlockId,
      currentBlockId: topBlock && this.getIsHat(topBlock.opcode) ? (topBlock.next ?? null) : topBlockId,
      waitUntil: 0,
      stack: [],
      callStack: [],
      warpDepth: 0,
      procArgs: {},
      done: false,
    }
    this.threads.push(thread)
    return thread
  }

  private createClone(source: ScratchTarget): ScratchTarget | undefined {
    const cloneCount = this.project.targets.filter((target) => target.isClone).length
    if (cloneCount >= 300) {
      this.emit('ERROR', { message: 'Clone limit reached' })
      return undefined
    }
    const clone = cloneRuntimeTarget(source)
    clone.id = uniqueTargetId(this.project, `${source.id ?? source.name}_clone`)
    clone.name = `${source.name} clone`
    clone.isClone = true
    clone.cloneOf = source.id ?? source.name
    clone.layerOrder = (source.layerOrder ?? 0) + 0.5
    this.project.targets.push(clone)
    if (this.runtimeStepActive) this.runtimeLayerOrderDirty = true
    else normalizeLayerOrder(this.project)
    this.hatCache.clear()
    for (const [id, block] of Object.entries(clone.blocks)) {
      if (block.opcode === 'control_start_as_clone') this.startThread(clone, id)
    }
    if (this.runtimeStepActive) this.runtimeTargetsChanged = true
    else this.emit('TARGETS_UPDATE', this.snapshot())
    return clone
  }

  private deleteClone(clone: ScratchTarget, currentThread?: RuntimeThread): void {
    if (!clone.isClone) return
    this.project.targets = this.project.targets.filter((target) => target !== clone)
    this.threads = this.threads.filter((candidate) => candidate === currentThread || candidate.target !== clone)
    this.hatCache.clear()
    if (this.runtimeStepActive) this.runtimeTargetsChanged = true
    else this.emit('TARGETS_UPDATE', this.snapshot())
  }

  private stepThread(thread: RuntimeThread, now: number, _delta: number): boolean {
    if (thread.waitUntil > now) return true
    if (thread.waitingFor?.some((child) => !child.done)) return true
    thread.waitingFor = undefined
    let budget = THREAD_STEP_BUDGET
    let warpBudgetApplied = false
    while (budget-- > 0 && thread.currentBlockId && !thread.done) {
      if (!warpBudgetApplied && this.threadInWarpProcedure(thread) && budget < WARP_THREAD_STEP_BUDGET) {
        budget = WARP_THREAD_STEP_BUDGET
        warpBudgetApplied = true
      }
      const block = thread.target.blocks[thread.currentBlockId]
      if (!block) {
        thread.done = true
        return true
      }
      this.currentThread = thread
      const tracksPenMovement = thread.target.pen?.down === true && isMotionOpcode(block.opcode)
      const beforeX = tracksPenMovement ? (thread.target.x ?? 0) : 0
      const beforeY = tracksPenMovement ? (thread.target.y ?? 0) : 0
      const result = this.executeBlock(thread, block, now)
      if (tracksPenMovement) this.recordPenMovement(thread.target, beforeX, beforeY)
      if (result === 'yield') return true
      if (result === 'stop') {
        thread.done = true
        return true
      }
      if (result === 'return') {
        if (!thread.currentBlockId && this.advanceThreadAfterStackEnd(thread) === 'yield') return true
        continue
      }
      thread.currentBlockId = result ?? block.next ?? null
      if (!thread.currentBlockId && this.advanceThreadAfterStackEnd(thread) === 'yield') return true
    }
    return !(thread.currentBlockId && !thread.done && thread.warpDepth > 0)
  }

  private advanceThreadAfterStackEnd(thread: RuntimeThread): 'yield' | undefined {
    while (!thread.currentBlockId && !thread.done) {
      const depth = thread.callStack.length
      const frame = thread.stack.at(-1)
      if (frame && frame.callDepth === depth) {
        if (frame.kind === 'continuation') {
          thread.stack.pop()
          thread.currentBlockId = frame.returnTo
          continue
        }
        const loopBlock = thread.target.blocks[frame.blockId]
        if (frame.until && loopBlock && truthy(this.inputValue(thread.target, loopBlock, 'CONDITION', false))) {
          thread.stack.pop()
          thread.currentBlockId = loopBlock.next ?? null
          continue
        }
        if (!frame.until && loopBlock?.opcode === 'control_while' && !truthy(this.inputValue(thread.target, loopBlock, 'CONDITION', false))) {
          thread.stack.pop()
          thread.currentBlockId = loopBlock.next ?? null
          continue
        }
        if (frame.remaining === 0) {
          thread.stack.pop()
          thread.currentBlockId = loopBlock?.next ?? null
          continue
        }
        if (frame.remaining > 0) {
          if (frame.forEach) {
            frame.forEach.index += 1
            this.setLoopVariable(thread.target, frame.forEach.variable, frame.forEach.index)
          }
          frame.remaining -= 1
        }
        thread.currentBlockId = loopBlock ? firstSubstack(loopBlock) : null
        if (!thread.currentBlockId) {
          thread.stack.pop()
          thread.currentBlockId = thread.target.blocks[frame.blockId]?.next ?? null
        }
        if (isLoopOpcode(loopBlock?.opcode) && thread.currentBlockId && !this.threadInWarpProcedure(thread)) return 'yield'
        continue
      }

      const callFrame = thread.callStack.pop()
      if (callFrame) {
        if (callFrame.warp) thread.warpDepth = Math.max(0, thread.warpDepth - 1)
        thread.currentBlockId = callFrame.returnTo
        thread.procArgs = thread.callStack.at(-1)?.args ?? {}
        continue
      }

      if (frame) {
        thread.stack.pop()
        continue
      }
      thread.done = true
    }
    return undefined
  }

  private threadInWarpProcedure(thread: RuntimeThread): boolean {
    return thread.warpDepth > 0
  }

  private returnFromProcedure(thread: RuntimeThread): 'return' {
    const callDepth = thread.callStack.length
    const callFrame = thread.callStack.pop()
    if (!callFrame) {
      thread.currentBlockId = null
      return 'return'
    }
    if (callFrame.warp) thread.warpDepth = Math.max(0, thread.warpDepth - 1)
    thread.stack = thread.stack.filter((frame) => frame.callDepth < callDepth)
    thread.procArgs = thread.callStack.at(-1)?.args ?? {}
    thread.currentBlockId = callFrame.returnTo
    return 'return'
  }

  private enterContinuation(thread: RuntimeThread, block: ScratchBlock, firstBlockId: string | null): string | null {
    if (!firstBlockId) return block.next ?? null
    thread.stack.push({ kind: 'continuation', returnTo: block.next ?? null, callDepth: thread.callStack.length })
    return firstBlockId
  }

  private executeBlock(thread: RuntimeThread, block: ScratchBlock, now: number): string | null | 'yield' | 'stop' | 'return' {
    switch (block.opcode) {
      case 'motion_movesteps':
        moveSteps(thread.target, Cast.toNumber(this.inputValue(thread.target, block, 'STEPS', 10)))
        return null
      case 'motion_turnright':
        thread.target.direction = normalizeDirection((thread.target.direction ?? 90) + Cast.toNumber(this.inputValue(thread.target, block, 'DEGREES', 15)))
        return null
      case 'motion_turnleft':
        thread.target.direction = normalizeDirection((thread.target.direction ?? 90) - Cast.toNumber(this.inputValue(thread.target, block, 'DEGREES', 15)))
        return null
      case 'motion_pointindirection':
        thread.target.direction = normalizeDirection(Cast.toNumber(this.inputValue(thread.target, block, 'DIRECTION', 90)))
        return null
      case 'motion_pointtowards': {
        const point = this.resolveMotionPoint(thread.target, String(this.inputValue(thread.target, block, 'TOWARDS', block.fields?.TOWARDS?.[0] ?? '_mouse_')))
        if (point) thread.target.direction = directionToPoint(thread.target, point.x, point.y)
        return null
      }
      case 'motion_goto': {
        const point = this.resolveMotionPoint(thread.target, String(this.inputValue(thread.target, block, 'TO', block.fields?.TO?.[0] ?? '_random_')))
        if (point) {
          thread.target.x = point.x
          thread.target.y = point.y
          clampSprite(thread.target)
        }
        return null
      }
      case 'motion_gotoxy':
        thread.target.x = Cast.toNumber(this.inputValue(thread.target, block, 'X', 0))
        thread.target.y = Cast.toNumber(this.inputValue(thread.target, block, 'Y', 0))
        clampSprite(thread.target)
        return null
      case 'motion_glidesecstoxy': {
        const endX = Cast.toNumber(this.inputValue(thread.target, block, 'X', 0))
        const endY = Cast.toNumber(this.inputValue(thread.target, block, 'Y', 0))
        return this.executeGlide(thread, block, now, endX, endY)
      }
      case 'motion_glideto': {
        const point = this.resolveMotionPoint(thread.target, String(this.inputValue(thread.target, block, 'TO', block.fields?.TO?.[0] ?? '_random_')))
        if (!point) return null
        return this.executeGlide(thread, block, now, point.x, point.y)
      }
      case 'motion_changexby':
        thread.target.x = (thread.target.x ?? 0) + Cast.toNumber(this.inputValue(thread.target, block, 'DX', 10))
        clampSprite(thread.target)
        return null
      case 'motion_changeyby':
        thread.target.y = (thread.target.y ?? 0) + Cast.toNumber(this.inputValue(thread.target, block, 'DY', 10))
        clampSprite(thread.target)
        return null
      case 'motion_setx':
        thread.target.x = Cast.toNumber(this.inputValue(thread.target, block, 'X', 0))
        clampSprite(thread.target)
        return null
      case 'motion_sety':
        thread.target.y = Cast.toNumber(this.inputValue(thread.target, block, 'Y', 0))
        clampSprite(thread.target)
        return null
      case 'motion_ifonedgebounce':
        bounceIfOnEdge(thread.target)
        return null
      case 'motion_setrotationstyle': {
        const style = String(block.fields?.STYLE?.[0] ?? this.inputValue(thread.target, block, 'STYLE', 'all around'))
        if (isRotationStyle(style)) thread.target.rotationStyle = style
        return null
      }
      case 'looks_show':
        thread.target.visible = true
        return null
      case 'looks_hide':
        thread.target.visible = false
        return null
      case 'looks_say':
        thread.target.speechBubble = { type: 'say', text: String(this.inputValue(thread.target, block, 'MESSAGE', 'Hello!')) }
        return null
      case 'looks_think':
        thread.target.speechBubble = { type: 'think', text: String(this.inputValue(thread.target, block, 'MESSAGE', 'Hmm...')) }
        return null
      case 'looks_thinkforsecs': {
        const text = String(this.inputValue(thread.target, block, 'MESSAGE', 'Hmm...'))
        const duration = durationMsFromSeconds(this.inputValue(thread.target, block, 'SECS', 2), 2)
        const id = findBlockId(thread.target, block)
        if (thread.waitingBlockId !== id) {
          thread.target.speechBubble = { type: 'think', text, until: now + duration }
          thread.waitingBlockId = id
          thread.waitUntil = now + duration
          return 'yield'
        }
        thread.target.speechBubble = undefined
        thread.waitingBlockId = undefined
        thread.waitUntil = 0
        return null
      }
      case 'looks_sayforsecs': {
        const text = String(this.inputValue(thread.target, block, 'MESSAGE', 'Hello!'))
        const duration = durationMsFromSeconds(this.inputValue(thread.target, block, 'SECS', 2), 2)
        const id = findBlockId(thread.target, block)
        if (thread.waitingBlockId !== id) {
          thread.target.speechBubble = { type: 'say', text, until: now + duration }
          thread.waitingBlockId = id
          thread.waitUntil = now + duration
          return 'yield'
        }
        thread.target.speechBubble = undefined
        thread.waitingBlockId = undefined
        thread.waitUntil = 0
        return null
      }
      case 'looks_nextcostume':
        thread.target.currentCostume = (thread.target.currentCostume + 1) % Math.max(1, thread.target.costumes.length)
        return null
      case 'looks_switchcostumeto': {
        const costume = String(this.inputValue(thread.target, block, 'COSTUME', ''))
        const index = resolveCostumeIndex(thread.target.costumes, costume, thread.target.currentCostume)
        if (index >= 0) thread.target.currentCostume = index
        return null
      }
      case 'looks_switchbackdropto': {
        const stage = this.getStage()
        const backdrop = String(this.inputValue(thread.target, block, 'BACKDROP', block.fields?.BACKDROP?.[0] ?? ''))
        const index = resolveCostumeIndex(stage.costumes, backdrop, stage.currentCostume)
        if (index >= 0) {
          stage.currentCostume = index
          this.startBackdropHats(stage.costumes[index]?.name ?? backdrop)
        }
        return null
      }
      case 'looks_switchbackdroptoandwait': {
        const id = findBlockId(thread.target, block)
        if (thread.waitingBroadcastBlockId === id) {
          thread.waitingBroadcastBlockId = undefined
          return null
        }
        const stage = this.getStage()
        const backdrop = String(this.inputValue(thread.target, block, 'BACKDROP', block.fields?.BACKDROP?.[0] ?? ''))
        const index = resolveCostumeIndex(stage.costumes, backdrop, stage.currentCostume)
        if (index >= 0) {
          stage.currentCostume = index
          const before = this.threads.length
          this.startBackdropHats(stage.costumes[index]?.name ?? backdrop)
          thread.waitingFor = this.threads.slice(before).filter((candidate) => candidate !== thread)
          thread.waitingBroadcastBlockId = id
          return thread.waitingFor.length > 0 ? 'yield' : null
        }
        return null
      }
      case 'looks_nextbackdrop': {
        const stage = this.getStage()
        stage.currentCostume = (stage.currentCostume + 1) % Math.max(1, stage.costumes.length)
        this.startBackdropHats(stage.costumes[stage.currentCostume]?.name ?? '')
        return null
      }
      case 'looks_changeeffectby': {
        const effect = normalizeGraphicEffectName(String(block.fields?.EFFECT?.[0] ?? 'color'))
        thread.target.effects ??= {}
        thread.target.effects[effect] = (thread.target.effects[effect] ?? 0) + Cast.toNumber(this.inputValue(thread.target, block, 'CHANGE', 25))
        return null
      }
      case 'looks_seteffectto': {
        const effect = normalizeGraphicEffectName(String(block.fields?.EFFECT?.[0] ?? 'color'))
        thread.target.effects ??= {}
        thread.target.effects[effect] = Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 0))
        return null
      }
      case 'looks_cleargraphiceffects':
        thread.target.effects = {}
        return null
      case 'looks_changesizeby':
        thread.target.size = bounded((thread.target.size ?? 100) + Cast.toNumber(this.inputValue(thread.target, block, 'CHANGE', 10)), 5, 1000)
        return null
      case 'looks_setsizeto':
        thread.target.size = bounded(Cast.toNumber(this.inputValue(thread.target, block, 'SIZE', 100)), 5, 1000)
        return null
      case 'looks_gotofrontback': {
        const option = String(block.fields?.FRONT_BACK?.[0] ?? this.inputValue(thread.target, block, 'FRONT_BACK', 'front'))
        moveLayer(this.project, thread.target, option === 'back' ? 'back' : 'front')
        return null
      }
      case 'looks_goforwardbackwardlayers': {
        const option = String(block.fields?.FORWARD_BACKWARD?.[0] ?? this.inputValue(thread.target, block, 'FORWARD_BACKWARD', 'forward'))
        const layers = Math.max(0, Math.floor(Cast.toNumber(this.inputValue(thread.target, block, 'NUM', 1))))
        moveLayerBy(this.project, thread.target, option === 'backward' ? -layers : layers)
        return null
      }
      case 'sound_play':
        this.playSound(thread.target, String(this.inputValue(thread.target, block, 'SOUND_MENU', block.fields?.SOUND_MENU?.[0] ?? '')))
        return null
      case 'sound_playuntildone': {
        const id = findBlockId(thread.target, block)
        if (thread.waitingSoundBlockId !== id) {
          const wait = this.playSound(thread.target, String(this.inputValue(thread.target, block, 'SOUND_MENU', block.fields?.SOUND_MENU?.[0] ?? '')))
          thread.waitingSoundBlockId = id
          thread.waitingSoundDone = wait.done
          thread.waitingSoundUntil = now + wait.durationMs
          wait.promise?.finally(() => {
            thread.waitingSoundDone = true
          })
          if (!thread.waitingSoundDone && now < thread.waitingSoundUntil) return 'yield'
        }
        if (!thread.waitingSoundDone && now < (thread.waitingSoundUntil ?? now)) {
          return 'yield'
        }
        thread.waitingSoundBlockId = undefined
        thread.waitingSoundDone = undefined
        thread.waitingSoundUntil = undefined
        return null
      }
      case 'sound_stopallsounds':
        callAudio(this.audioEngine, 'stopAllSounds')
        this.clearSoundWaits()
        this.emit('SOUNDS_STOPPED', this.snapshot())
        return null
      case 'sound_changeeffectby': {
        const effect = normalizeSoundEffectName(String(block.fields?.EFFECT?.[0] ?? 'PITCH'))
        thread.target.soundEffects ??= {}
        thread.target.soundEffects[effect] = clampSoundEffect(effect, (thread.target.soundEffects[effect] ?? 0) + Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 10)))
        callAudio(this.audioEngine, 'setEffects', thread.target.name, structuredClone(thread.target.soundEffects))
        return null
      }
      case 'sound_seteffectto': {
        const effect = normalizeSoundEffectName(String(block.fields?.EFFECT?.[0] ?? 'PITCH'))
        thread.target.soundEffects ??= {}
        thread.target.soundEffects[effect] = clampSoundEffect(effect, Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 0)))
        callAudio(this.audioEngine, 'setEffects', thread.target.name, structuredClone(thread.target.soundEffects))
        return null
      }
      case 'sound_cleareffects':
        thread.target.soundEffects = {}
        callAudio(this.audioEngine, 'setEffects', thread.target.name, {})
        return null
      case 'sound_changevolumeby':
        thread.target.volume = bounded((thread.target.volume ?? 100) + Cast.toNumber(this.inputValue(thread.target, block, 'VOLUME', -10)), 0, 100)
        callAudio(this.audioEngine, 'setVolume', thread.target.name, thread.target.volume)
        return null
      case 'sound_setvolumeto':
        thread.target.volume = bounded(Cast.toNumber(this.inputValue(thread.target, block, 'VOLUME', 100)), 0, 100)
        callAudio(this.audioEngine, 'setVolume', thread.target.name, thread.target.volume)
        return null
      case 'sound_sounds_menu':
      case 'sound_beats_menu':
      case 'sound_effects_menu':
        return null
      case 'control_wait':
        if (thread.waitingBlockId !== findBlockId(thread.target, block)) {
          thread.waitingBlockId = findBlockId(thread.target, block)
          thread.waitUntil = now + durationMsFromSeconds(this.inputValue(thread.target, block, 'DURATION', 1), 1)
          return 'yield'
        }
        if (now < thread.waitUntil) return 'yield'
        thread.waitingBlockId = undefined
        thread.waitUntil = 0
        return null
      case 'control_wait_until':
        return truthy(this.inputValue(thread.target, block, 'CONDITION', false)) ? null : 'yield'
      case 'control_repeat': {
        const times = Math.max(0, Math.floor(Cast.toNumber(this.inputValue(thread.target, block, 'TIMES', 10))))
        if (times === 0) return block.next ?? null
        const body = firstSubstack(block)
        if (!body) return block.next ?? null
        thread.stack.push({ kind: 'loop', blockId: findBlockId(thread.target, block), remaining: times - 1, callDepth: thread.callStack.length })
        return body
      }
      case 'control_repeat_until':
        if (truthy(this.inputValue(thread.target, block, 'CONDITION', false))) return block.next ?? null
        if (!firstSubstack(block)) return block.next ?? null
        thread.stack.push({ kind: 'loop', blockId: findBlockId(thread.target, block), remaining: -1, until: true, callDepth: thread.callStack.length })
        return firstSubstack(block)
      case 'control_while':
        if (!truthy(this.inputValue(thread.target, block, 'CONDITION', false))) return block.next ?? null
        if (!firstSubstack(block)) return block.next ?? null
        thread.stack.push({ kind: 'loop', blockId: findBlockId(thread.target, block), remaining: -1, callDepth: thread.callStack.length })
        return firstSubstack(block)
      case 'control_for_each': {
        const total = Math.max(0, Math.floor(Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 10))))
        if (total === 0) return block.next ?? null
        const body = firstSubstack(block)
        if (!body) return block.next ?? null
        const variable = block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0] ?? ''
        this.setLoopVariable(thread.target, variable, 1)
        thread.stack.push({ kind: 'loop', blockId: findBlockId(thread.target, block), remaining: total - 1, callDepth: thread.callStack.length, forEach: { variable, index: 1, total } })
        return body
      }
      case 'control_forever': {
        const body = firstSubstack(block)
        if (!body) return 'yield'
        thread.stack.push({ kind: 'loop', blockId: findBlockId(thread.target, block), remaining: -1, callDepth: thread.callStack.length })
        return body
      }
      case 'control_all_at_once':
        return this.enterContinuation(thread, block, firstSubstack(block))
      case 'control_if':
        return truthy(this.statementInfo(block).condition?.(thread.target) ?? false) ? this.enterContinuation(thread, block, firstSubstack(block)) : block.next ?? null
      case 'control_if_else': {
        const branch = truthy(this.statementInfo(block).condition?.(thread.target) ?? false) ? firstSubstack(block) : substack(block, 'SUBSTACK2')
        return this.enterContinuation(thread, block, branch)
      }
      case 'control_stop':
        switch (String(block.fields?.STOP_OPTION?.[0] ?? this.inputValue(thread.target, block, 'STOP_OPTION', 'all'))) {
          case 'all':
            this.stopAll()
            return 'stop'
          case 'other scripts in sprite':
            for (const candidate of this.threads) {
              if (candidate !== thread && candidate.target === thread.target) candidate.done = true
            }
            return null
          case 'this script':
          default:
            if (thread.callStack.length > 0) return this.returnFromProcedure(thread)
            return 'stop'
        }
      case 'event_broadcast':
        this.startBroadcast(String(this.inputValue(thread.target, block, 'BROADCAST_INPUT', block.fields?.BROADCAST_OPTION?.[0] ?? 'message1')))
        return null
      case 'event_broadcastandwait': {
        const id = findBlockId(thread.target, block)
        if (thread.waitingBroadcastBlockId === id) {
          thread.waitingBroadcastBlockId = undefined
          return null
        }
        const message = String(this.inputValue(thread.target, block, 'BROADCAST_INPUT', block.fields?.BROADCAST_OPTION?.[0] ?? 'message1'))
        thread.waitingFor = this.startBroadcast(message)
        thread.waitingBroadcastBlockId = id
        return thread.waitingFor.length > 0 ? 'yield' : null
      }
      case 'control_create_clone_of': {
        const option = String(this.inputValue(thread.target, block, 'CLONE_OPTION', block.fields?.CLONE_OPTION?.[0] ?? '_myself_'))
        const source = option === '_myself_' ? thread.target : this.getTarget(option)
        if (source && !source.isStage) this.createClone(source)
        return null
      }
      case 'control_delete_this_clone':
        if (thread.target.isClone) {
          this.deleteClone(thread.target, thread)
          return 'stop'
        }
        return null
      case 'data_setvariableto': {
        const info = this.statementInfo(block)
        this.assignVariableFast(thread.target, info.variableId, info.value?.(thread.target) ?? 0)
        return null
      }
      case 'data_changevariableby': {
        const info = this.statementInfo(block)
        this.changeVariableFast(thread.target, info.variableId, Cast.toNumber(info.value?.(thread.target) ?? 1))
        return null
      }
      case 'data_showvariable': {
        const variable = this.variableRecord(thread.target, block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0])
        if (variable) this.upsertVariableMonitor(variable[0].name, variable[2], true)
        return null
      }
      case 'data_hidevariable': {
        const variable = this.variableRecord(thread.target, block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0])
        if (variable) this.setMonitorVisible(`${variable[0].id ?? variable[0].name}:${variable[2]}`, false)
        return null
      }
      case 'data_showlist': {
        const list = this.listRecord(thread.target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        if (list) this.upsertListMonitor(list[0].name, list[2], true)
        return null
      }
      case 'data_hidelist': {
        const list = this.listRecord(thread.target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        if (list) this.setMonitorVisible(`${list[0].id ?? list[0].name}:${list[2]}`, false)
        return null
      }
      case 'data_addtolist': {
        const info = this.statementInfo(block)
        const list = this.fastListValue(thread.target, info.listId)
        if (list) list.push(info.item?.(thread.target) ?? 'thing')
        return null
      }
      case 'data_deleteoflist': {
        const info = this.statementInfo(block)
        const list = this.fastListValue(thread.target, info.listId)
        if (!list) return null
        const index = info.index?.(thread.target) ?? 1
        if (String(index).toLowerCase() === 'all') list.length = 0
        else {
          const resolved = listIndex(list, index)
          if (resolved >= 0) list.splice(resolved, 1)
        }
        return null
      }
      case 'data_deletealloflist': {
        const list = this.fastListValue(thread.target, this.statementInfo(block).listId)
        if (list) list.length = 0
        return null
      }
      case 'data_insertatlist': {
        const info = this.statementInfo(block)
        const list = this.fastListValue(thread.target, info.listId)
        if (!list) return null
        const index = insertIndex(list, info.index?.(thread.target) ?? 1)
        list.splice(index, 0, info.item?.(thread.target) ?? 'thing')
        return null
      }
      case 'data_replaceitemoflist': {
        const info = this.statementInfo(block)
        const list = this.fastListValue(thread.target, info.listId)
        if (!list) return null
        const index = listIndex(list, info.index?.(thread.target) ?? 1)
        if (index >= 0) list[index] = info.item?.(thread.target) ?? 'thing'
        return null
      }
      case 'sensing_askandwait': {
        const id = findBlockId(thread.target, block)
        if (thread.waitingBlockId !== id) {
          thread.waitingBlockId = id
          thread.waitingAnswer = true
          this.emit('QUESTION', { question: String(this.inputValue(thread.target, block, 'QUESTION', 'What is your name?')) })
          return 'yield'
        }
        if (thread.waitingAnswer) return 'yield'
        thread.waitingBlockId = undefined
        thread.waitingAnswer = undefined
        return null
      }
      case 'sensing_resettimer':
        this.resetTimer()
        return null
      case 'sensing_setdragmode':
        thread.target.draggable = String(block.fields?.DRAG_MODE?.[0] ?? this.inputValue(thread.target, block, 'DRAG_MODE', 'draggable')) === 'draggable'
        return null
      case 'control_incr_counter':
        this.runtimeCounter += 1
        return null
      case 'control_clear_counter':
        this.runtimeCounter = 0
        return null
      case 'procedures_definition':
        return block.next ?? null
      case 'procedures_call': {
        const proccode = String(block.mutation?.proccode ?? '')
        const procedure = this.procedureInfo(thread.target, proccode)
        if (!procedure?.body) return block.next ?? null
        const args = this.procedureCallArgs(thread.target, block, procedure)
        thread.callStack.push({ returnTo: block.next ?? null, args, warp: procedure.warp })
        if (procedure.warp) thread.warpDepth += 1
        thread.procArgs = args
        return procedure.body
      }
      case 'pen_clear':
      case 'clear':
        for (const target of this.project.targets) target.penLines = []
        this.renderer?.penClear?.()
        if (this.hasEventListeners('PEN_CLEAR')) this.emit('PEN_CLEAR', this.snapshot())
        return null
      case 'pen_stamp':
      case 'stamp':
        this.renderer?.penStamp?.(thread.target)
        if (this.hasEventListeners('PEN_STAMP')) this.emit('PEN_STAMP', { targetName: thread.target.name, target: structuredClone(thread.target) })
        return null
      case 'pen_penDown':
      case 'penDown':
        ensurePen(thread.target).down = true
        this.stationaryPenDown.set(thread.target, { x: thread.target.x ?? 0, y: thread.target.y ?? 0, moved: false })
        return null
      case 'pen_penUp':
      case 'penUp':
        this.recordStationaryPenDot(thread.target)
        ensurePen(thread.target).down = false
        return null
      case 'pen_setPenColorToColor':
      case 'setPenColorToColor':
        ensurePen(thread.target).color = String(this.inputValue(thread.target, block, 'COLOR', block.fields?.COLOR?.[0] ?? '#000000'))
        return null
      case 'pen_changePenSizeBy':
      case 'changePenSizeBy':
        ensurePen(thread.target).size = bounded(ensurePen(thread.target).size + Cast.toNumber(this.inputValue(thread.target, block, 'SIZE', 1)), 1, 1200)
        return null
      case 'pen_setPenSizeTo':
      case 'setPenSizeTo':
        ensurePen(thread.target).size = bounded(Cast.toNumber(this.inputValue(thread.target, block, 'SIZE', 1)), 1, 1200)
        return null
      case 'pen_changePenColorParamBy':
      case 'changePenColorParamBy':
        changePenParam(thread.target, String(this.inputValue(thread.target, block, 'COLOR_PARAM', block.fields?.COLOR_PARAM?.[0] ?? 'color')), Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 10)), true)
        return null
      case 'pen_setPenColorParamTo':
      case 'setPenColorParamTo':
        changePenParam(thread.target, String(this.inputValue(thread.target, block, 'COLOR_PARAM', block.fields?.COLOR_PARAM?.[0] ?? 'color')), Cast.toNumber(this.inputValue(thread.target, block, 'VALUE', 50)), false)
        return null
      case 'pen_setPenHueToNumber':
      case 'setPenHueToNumber':
        changePenParam(thread.target, 'color', Cast.toNumber(this.inputValue(thread.target, block, 'HUE', 0)), false)
        return null
      case 'pen_changePenHueBy':
      case 'changePenHueBy':
        changePenParam(thread.target, 'color', Cast.toNumber(this.inputValue(thread.target, block, 'HUE', 10)), true)
        return null
      case 'pen_setPenShadeToNumber':
      case 'setPenShadeToNumber':
        changePenParam(thread.target, 'brightness', Cast.toNumber(this.inputValue(thread.target, block, 'SHADE', 50)), false)
        return null
      case 'pen_changePenShadeBy':
      case 'changePenShadeBy':
        changePenParam(thread.target, 'brightness', Cast.toNumber(this.inputValue(thread.target, block, 'SHADE', 10)), true)
        return null
      case 'music_setTempo':
        this.getStage().tempo = Math.max(20, Cast.toNumber(this.inputValue(thread.target, block, 'TEMPO', 60)))
        return null
      case 'music_changeTempo':
        this.getStage().tempo = Math.max(20, (this.getStage().tempo ?? 60) + Cast.toNumber(this.inputValue(thread.target, block, 'TEMPO', 20)))
        return null
      case 'music_setInstrument':
      case 'music_midiSetInstrument':
      case 'midiSetInstrument':
        this.postIOData(`instrument:${thread.target.name}`, this.inputValue(thread.target, block, 'INSTRUMENT', 1))
        return null
      case 'music_playDrumForBeats':
      case 'music_midiPlayDrumForBeats':
      case 'music_playNoteForBeats':
      case 'music_restForBeats': {
        const id = findBlockId(thread.target, block)
        const beats = finiteNonNegative(this.inputValue(thread.target, block, 'BEATS', 0.25), 0.25)
        const tempo = Math.max(1, this.getStage().tempo ?? 60)
        if (thread.waitingBlockId !== id) {
          thread.waitingBlockId = id
          thread.waitUntil = now + (beats * 60000) / tempo
          return thread.waitUntil > now ? 'yield' : null
        }
        thread.waitingBlockId = undefined
        thread.waitUntil = 0
        return null
      }
      case 'midiPlayDrumForBeats':
      case 'playDrumForBeats':
      case 'playNoteForBeats':
      case 'restForBeats':
        return this.executeAliasedExtensionWait(thread, block, now)
      case 'setInstrument':
        this.postIOData(`instrument:${thread.target.name}`, this.inputValue(thread.target, block, 'INSTRUMENT', 1))
        return null
      case 'setTempo':
        this.getStage().tempo = Math.max(20, Cast.toNumber(this.inputValue(thread.target, block, 'TEMPO', 60)))
        return null
      case 'changeTempo':
        this.getStage().tempo = Math.max(20, (this.getStage().tempo ?? 60) + Cast.toNumber(this.inputValue(thread.target, block, 'TEMPO', 20)))
        return null
      case 'videoSensing_videoToggle':
      case 'videoToggle':
        this.getStage().videoState = String(block.fields?.VIDEO_STATE?.[0] ?? this.inputValue(thread.target, block, 'VIDEO_STATE', 'on'))
        return null
      case 'videoSensing_setVideoTransparency':
      case 'setVideoTransparency':
        this.getStage().videoTransparency = bounded(Cast.toNumber(this.inputValue(thread.target, block, 'TRANSPARENCY', 50)), 0, 100)
        return null
      case 'text2speech_setVoice':
      case 'setVoice':
        this.postIOData('textToSpeechVoice', this.inputValue(thread.target, block, 'VOICE', block.fields?.VOICE?.[0] ?? 'alto'))
        return null
      case 'text2speech_setLanguage':
      case 'setLanguage':
        this.getStage().textToSpeechLanguage = String(this.inputValue(thread.target, block, 'LANGUAGE', block.fields?.LANGUAGE?.[0] ?? 'en'))
        return null
      case 'text2speech_speakAndWait': {
        const text = String(this.inputValue(thread.target, block, 'WORDS', ''))
        this.emit('TEXT_TO_SPEECH', { targetName: thread.target.name, text })
        const id = findBlockId(thread.target, block)
        if (thread.waitingBlockId !== id) {
          thread.waitingBlockId = id
          thread.waitUntil = now + Math.min(3000, Math.max(1, text.length) * 40)
          return 'yield'
        }
        thread.waitingBlockId = undefined
        thread.waitUntil = 0
        return null
      }
      case 'speakAndWait':
      case 'speech2text_listenAndWait':
      case 'listenAndWait':
        return this.executeSpeechWait(thread, block, now)
      case 'microbit_displaySymbol':
      case 'microbit_displayText':
      case 'microbit_displayClear':
      case 'displaySymbol':
      case 'displayText':
      case 'displayClear':
        this.emit('EXTENSION_DISPLAY', { opcode: block.opcode, targetName: thread.target.name })
        return null
      case 'ev3_beep':
      case 'beep':
      case 'wedo2_playNoteFor':
      case 'playNoteFor':
        return this.executeAliasedExtensionWait(thread, block, now)
      case 'boost_motorOnFor':
      case 'boost_motorOnForRotation':
      case 'boost_motorOn':
      case 'boost_motorOff':
      case 'boost_setMotorPower':
      case 'boost_setMotorDirection':
      case 'boost_setLightHue':
      case 'ev3_motorTurnClockwise':
      case 'ev3_motorTurnCounterClockwise':
      case 'ev3_motorSetPower':
      case 'wedo2_motorOnFor':
      case 'wedo2_motorOn':
      case 'wedo2_motorOff':
      case 'wedo2_startMotorPower':
      case 'wedo2_setMotorDirection':
      case 'wedo2_setLightHue':
      case 'motorOnFor':
      case 'motorOnForRotation':
      case 'motorOn':
      case 'motorOff':
      case 'motorSetPower':
      case 'setMotorPower':
      case 'setMotorDirection':
      case 'startMotorPower':
      case 'setLightHue':
        this.emit('EXTENSION_ACTUATOR', { opcode: block.opcode, targetName: thread.target.name })
        return null
      case 'faceSensing_setSizeToFaceSize':
      case 'setSizeToFaceSize':
        thread.target.size = bounded(extensionNumber(this.ioData.get('face'), 'size', 100), 5, 1000)
        return null
      case 'faceSensing_pointInFaceTiltDirection':
      case 'pointInFaceTiltDirection':
        thread.target.direction = normalizeDirection(extensionNumber(this.ioData.get('face'), 'tilt', thread.target.direction ?? 90))
        return null
      case 'faceSensing_goToPart':
      case 'goToPart': {
        const point = extensionPoint(this.ioData.get('face'))
        thread.target.x = point.x
        thread.target.y = point.y
        clampSprite(thread.target)
        return null
      }
      default:
        return null
    }
  }

  private inputValue(target: ScratchTarget, block: ScratchBlock, name: string, fallback: ScratchValue): ScratchValue {
    const input = block.inputs?.[name]
    const value = input?.[1]
    if (Array.isArray(value)) {
      const code = value[0]
      if (code === 12) {
        const variable = this.variableRecord(target, String(value[2] ?? value[1] ?? ''))
          ?? this.variableRecord(target, String(value[1] ?? ''))
        return variable?.[1][1] ?? toScratchValue(value[1] ?? fallback)
      }
      if (code === 13) {
        const list = this.listRecord(target, String(value[2] ?? value[1] ?? ''))
          ?? this.listRecord(target, String(value[1] ?? ''))
        return list?.[1][1].join(' ') ?? toScratchValue(value[1] ?? fallback)
      }
      const literal = value[1]
      if (typeof literal === 'number' || typeof literal === 'boolean') return literal
      return String(literal ?? fallback)
    }
    if (typeof value === 'string') {
      const child = target.blocks[value]
      if (child) return this.reporterValue(target, child)
    }
    return fallback
  }

  private literalReporterValue(target: ScratchTarget, value: unknown[]): ScratchValue | undefined {
    const code = value[0]
    if (code === 12) {
      const variable = this.variableRecord(target, String(value[2] ?? value[1] ?? ''))
        ?? this.variableRecord(target, String(value[1] ?? ''))
      return variable?.[1][1]
    }
    if (code === 13) {
      const list = this.listRecord(target, String(value[2] ?? value[1] ?? ''))
        ?? this.listRecord(target, String(value[1] ?? ''))
      return list?.[1][1].join(' ')
    }
    return undefined
  }

  private executeGlide(thread: RuntimeThread, block: ScratchBlock, now: number, endX: number, endY: number): string | null | 'yield' {
    const blockId = findBlockId(thread.target, block)
    const duration = durationMsFromSeconds(this.inputValue(thread.target, block, 'SECS', 1), 1)
    if (duration === 0) {
      thread.target.x = endX
      thread.target.y = endY
      clampSprite(thread.target)
      thread.glide = undefined
      return null
    }
    if (!thread.glide || thread.glide.blockId !== blockId) {
      thread.glide = {
        blockId,
        startTime: now,
        duration,
        startX: thread.target.x ?? 0,
        startY: thread.target.y ?? 0,
        endX,
        endY,
      }
    }
    const glide = thread.glide
    const progress = bounded((now - glide.startTime) / glide.duration, 0, 1)
    thread.target.x = glide.startX + (glide.endX - glide.startX) * progress
    thread.target.y = glide.startY + (glide.endY - glide.startY) * progress
    clampSprite(thread.target)
    if (progress < 1) return 'yield'
    thread.glide = undefined
    return null
  }

  private reporterValue(target: ScratchTarget, block: ScratchBlock): ScratchValue {
    const compiled = this.compiledReporter(block)
    if (compiled) return compiled(target)
    switch (block.opcode) {
      case 'motion_xposition':
        return target.x ?? 0
      case 'motion_yposition':
        return target.y ?? 0
      case 'motion_direction':
        return target.direction ?? 90
      case 'looks_size':
        return target.size ?? 100
      case 'looks_costumenumbername': {
        const costume = target.costumes[target.currentCostume]
        return block.fields?.NUMBER_NAME?.[0] === 'name' ? costume?.name ?? '' : target.currentCostume + 1
      }
      case 'looks_backdropnumbername': {
        const stage = this.getStage()
        const backdrop = stage.costumes[stage.currentCostume]
        return block.fields?.NUMBER_NAME?.[0] === 'name' ? backdrop?.name ?? '' : stage.currentCostume + 1
      }
      case 'sound_volume':
        return target.volume ?? 100
      case 'motion_goto_menu':
      case 'motion_glideto_menu':
        return block.fields?.TO?.[0] ?? '_random_'
      case 'motion_pointtowards_menu':
        return block.fields?.TOWARDS?.[0] ?? '_mouse_'
      case 'looks_costume':
        return block.fields?.COSTUME?.[0] ?? target.costumes[target.currentCostume]?.name ?? ''
      case 'looks_backdrops':
        return block.fields?.BACKDROP?.[0] ?? this.getStage().costumes[this.getStage().currentCostume]?.name ?? ''
      case 'sound_sounds_menu':
        return block.fields?.SOUND_MENU?.[0] ?? target.sounds[0]?.name ?? ''
      case 'event_broadcast_menu':
        return block.fields?.BROADCAST_OPTION?.[0] ?? 'message1'
      case 'sound_beats_menu':
        return this.inputValue(target, block, 'BEATS', block.fields?.BEATS?.[0] ?? 1)
      case 'sound_effects_menu':
        return block.fields?.EFFECT?.[0] ?? 'PITCH'
      case 'control_create_clone_of_menu':
        return block.fields?.CLONE_OPTION?.[0] ?? '_myself_'
      case 'sensing_touchingobjectmenu':
        return block.fields?.TOUCHINGOBJECTMENU?.[0] ?? '_mouse_'
      case 'sensing_distancetomenu':
        return block.fields?.DISTANCETOMENU?.[0] ?? '_mouse_'
      case 'sensing_of_object_menu':
        return block.fields?.OBJECT?.[0] ?? '_stage_'
      case 'sensing_keyoptions':
        return block.fields?.KEY_OPTION?.[0] ?? 'space'
      case 'sensing_loudness':
        return loudnessValue(this.ioData.get('audio'))
      case 'sensing_loud':
        return loudnessValue(this.ioData.get('audio')) > 10
      case 'sensing_touchingcolor': {
        const color = parseColor(this.inputValue(target, block, 'COLOR', block.fields?.COLOR?.[0] ?? '#000000'))
        return !!color && this.targetTouchesColor(target, color)
      }
      case 'sensing_coloristouchingcolor': {
        const color = parseColor(this.inputValue(target, block, 'COLOR', block.fields?.COLOR?.[0] ?? '#000000'))
        const touching = parseColor(this.inputValue(target, block, 'COLOR2', block.fields?.COLOR2?.[0] ?? '#000000'))
        if (color && touching && this.renderer?.isColorTouchingColor && !target.isStage && target.visible !== false) {
          return this.renderer.isColorTouchingColor(target.drawableId ?? target.id ?? target.name, color, touching)
        }
        return !!color && !!touching && this.targetTouchesColor(target, touching) && this.targetLooksLikeColor(target, color)
      }
      case 'sensing_of': {
        const objectName = String(this.inputValue(target, block, 'OBJECT', block.fields?.OBJECT?.[0] ?? '_stage_'))
        const subject = objectName === '_stage_' || objectName.toLowerCase() === 'stage' ? this.getStage() : this.getTarget(objectName)
        return subject ? targetProperty(subject, block.fields?.PROPERTY?.[0] ?? 'x position', this.getStage()) : 0
      }
      case 'argument_reporter_string_number':
      case 'argument_reporter_boolean':
        return this.currentArgumentValue(block)
      case 'control_get_counter':
        return this.runtimeCounter
      case 'music_getTempo':
        return this.getStage().tempo ?? 60
      case 'videoSensing_videoOn':
        return videoSensingValue(this.ioData.get('video'), String(block.fields?.ATTRIBUTE?.[0] ?? 'motion'))
      case 'translate_getTranslate':
        return String(this.inputValue(target, block, 'WORDS', ''))
      case 'translate_getViewerLanguage':
        return viewerLanguage(this.ioData.get('user'))
      case 'getTempo':
        return this.getStage().tempo ?? 60
      case 'getTranslate':
        return String(this.inputValue(target, block, 'WORDS', ''))
      case 'getViewerLanguage':
        return viewerLanguage(this.ioData.get('user'))
      case 'speech2text_getSpeech':
      case 'getSpeech':
        return speechValue(this.ioData.get('speech'))
      case 'microbit_isButtonPressed':
      case 'ev3_buttonPressed':
      case 'buttonPressed':
      case 'isButtonPressed':
        return extensionBoolean(this.ioData.get(extensionDevice(block.opcode)), 'buttonPressed')
      case 'microbit_isTilted':
      case 'wedo2_isTilted':
      case 'boost_isTilted':
      case 'gdxfor_isTilted':
      case 'isTilted':
        return extensionBoolean(this.ioData.get(extensionDevice(block.opcode)), 'tilted')
      case 'microbit_getTiltAngle':
      case 'wedo2_getTiltAngle':
      case 'boost_getTiltAngle':
      case 'getTiltAngle':
        return extensionNumber(this.ioData.get(extensionDevice(block.opcode)), 'tilt', 0)
      case 'gdxfor_getTilt':
      case 'getTilt':
        return extensionNumber(this.ioData.get('gdxfor'), 'tilt', 0)
      case 'gdxfor_getForce':
      case 'getForce':
        return extensionNumber(this.ioData.get('gdxfor'), 'force', 0)
      case 'gdxfor_getSpinSpeed':
      case 'getSpinSpeed':
        return extensionNumber(this.ioData.get('gdxfor'), 'spinSpeed', 0)
      case 'gdxfor_getAcceleration':
      case 'getAcceleration':
        return extensionNumber(this.ioData.get('gdxfor'), 'acceleration', 0)
      case 'gdxfor_isFreeFalling':
      case 'isFreeFalling':
        return extensionBoolean(this.ioData.get('gdxfor'), 'freeFalling')
      case 'ev3_getMotorPosition':
      case 'boost_getMotorPosition':
      case 'getMotorPosition':
        return extensionNumber(this.ioData.get(extensionDevice(block.opcode)), 'motorPosition', 0)
      case 'ev3_getDistance':
      case 'wedo2_getDistance':
      case 'getDistance':
        return extensionNumber(this.ioData.get(extensionDevice(block.opcode)), 'distance', 0)
      case 'ev3_getBrightness':
      case 'getBrightness':
        return extensionNumber(this.ioData.get('ev3'), 'brightness', 0)
      case 'boost_seeingColor':
      case 'seeingColor':
        return extensionBoolean(this.ioData.get('boost'), 'seeingColor')
      case 'faceSensing_faceIsDetected':
      case 'faceIsDetected':
        return extensionBoolean(this.ioData.get('face'), 'detected')
      case 'faceSensing_faceSize':
      case 'faceSize':
        return extensionNumber(this.ioData.get('face'), 'size', 100)
      case 'faceSensing_faceTilt':
      case 'faceTilt':
        return extensionNumber(this.ioData.get('face'), 'tilt', 0)
      case 'operator_add':
        return Cast.toNumber(this.inputValue(target, block, 'NUM1', 0)) + Cast.toNumber(this.inputValue(target, block, 'NUM2', 0))
      case 'operator_subtract':
        return Cast.toNumber(this.inputValue(target, block, 'NUM1', 0)) - Cast.toNumber(this.inputValue(target, block, 'NUM2', 0))
      case 'operator_multiply':
        return Cast.toNumber(this.inputValue(target, block, 'NUM1', 0)) * Cast.toNumber(this.inputValue(target, block, 'NUM2', 0))
      case 'operator_divide':
        return Cast.toNumber(this.inputValue(target, block, 'NUM1', 0)) / Cast.toNumber(this.inputValue(target, block, 'NUM2', 1))
      case 'operator_random':
        return randomBetween(this.inputValue(target, block, 'FROM', 1), this.inputValue(target, block, 'TO', 10))
      case 'operator_equals':
        return Cast.compare(this.inputValue(target, block, 'OPERAND1', ''), this.inputValue(target, block, 'OPERAND2', '')) === 0
      case 'operator_gt':
        return Cast.compare(this.inputValue(target, block, 'OPERAND1', 0), this.inputValue(target, block, 'OPERAND2', 0)) > 0
      case 'operator_lt':
        return Cast.compare(this.inputValue(target, block, 'OPERAND1', 0), this.inputValue(target, block, 'OPERAND2', 0)) < 0
      case 'operator_and':
        return truthy(this.inputValue(target, block, 'OPERAND1', false)) && truthy(this.inputValue(target, block, 'OPERAND2', false))
      case 'operator_or':
        return truthy(this.inputValue(target, block, 'OPERAND1', false)) || truthy(this.inputValue(target, block, 'OPERAND2', false))
      case 'operator_not':
        return !truthy(this.inputValue(target, block, 'OPERAND', false))
      case 'operator_join':
        return `${Cast.toString(this.inputValue(target, block, 'STRING1', ''))}${Cast.toString(this.inputValue(target, block, 'STRING2', ''))}`
      case 'operator_letter_of': {
        const text = Cast.toString(this.inputValue(target, block, 'STRING', ''))
        const index = Math.floor(Cast.toNumber(this.inputValue(target, block, 'LETTER', 1))) - 1
        return text[index] ?? ''
      }
      case 'operator_length':
        return Cast.toString(this.inputValue(target, block, 'STRING', '')).length
      case 'operator_contains':
        return Cast.toString(this.inputValue(target, block, 'STRING1', '')).toLowerCase().includes(Cast.toString(this.inputValue(target, block, 'STRING2', '')).toLowerCase())
      case 'operator_mod': {
        return scratchMod(this.inputValue(target, block, 'NUM1', 0), this.inputValue(target, block, 'NUM2', 1))
      }
      case 'operator_round':
        return Math.round(Cast.toNumber(this.inputValue(target, block, 'NUM', 0)))
      case 'operator_mathop':
        return mathOp(block.fields?.OPERATOR?.[0] ?? 'abs', Cast.toNumber(this.inputValue(target, block, 'NUM', 0)))
      case 'data_variable': {
        const variable = this.variableRecord(target, block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0])
        return variable?.[1][1] ?? 0
      }
      case 'data_listcontents': {
        const list = this.listRecord(target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        return list?.[1][1].join(' ') ?? ''
      }
      case 'data_itemoflist': {
        const list = this.listRecord(target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        if (!list) return ''
        const index = listIndex(list[1][1], this.inputValue(target, block, 'INDEX', 1))
        return index >= 0 ? list[1][1][index] ?? '' : ''
      }
      case 'data_itemnumoflist': {
        const list = this.listRecord(target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        const item = String(this.inputValue(target, block, 'ITEM', 'thing'))
        const index = list?.[1][1].findIndex((value) => String(value) === item) ?? -1
        return index >= 0 ? index + 1 : 0
      }
      case 'data_lengthoflist': {
        const list = this.listRecord(target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        return list?.[1][1].length ?? 0
      }
      case 'data_listcontainsitem': {
        const list = this.listRecord(target, block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0])
        const item = String(this.inputValue(target, block, 'ITEM', 'thing'))
        return list?.[1][1].some((value) => String(value) === item) ?? false
      }
      case 'sensing_mousedown':
        return mouseButtonDown(this.ioData.get('mouse'))
      case 'sensing_mousex':
        return mouseCoordinate(this.ioData.get('mouse'), 'x')
      case 'sensing_mousey':
        return mouseCoordinate(this.ioData.get('mouse'), 'y')
      case 'sensing_touchingobject':
        return this.touchingObject(target, String(this.inputValue(target, block, 'TOUCHINGOBJECTMENU', block.fields?.TOUCHINGOBJECTMENU?.[0] ?? '_mouse_')))
      case 'sensing_distanceto':
        return this.distanceTo(target, String(this.inputValue(target, block, 'DISTANCETOMENU', block.fields?.DISTANCETOMENU?.[0] ?? '_mouse_')))
      case 'sensing_keypressed':
        return keyPressed(this.ioData.get('keyboard'), block.fields?.KEY_OPTION?.[0] ?? String(this.inputValue(target, block, 'KEY_OPTION', 'space')))
      case 'sensing_answer':
        return this.promptAnswer
      case 'sensing_timer':
        return (Date.now() - this.timerStart) / 1000
      case 'sensing_current':
        return currentDatePart(block.fields?.CURRENTMENU?.[0] ?? 'YEAR')
      case 'sensing_dayssince2000':
        return (Date.now() - Date.UTC(2000, 0, 1)) / 86400000
      case 'sensing_online':
        return onlineValue(this.ioData.get('network'))
      case 'sensing_username':
        return userName(this.ioData.get('userData') ?? this.ioData.get('user'))
      default:
        return 0
    }
  }

  private compiledReporter(block: ScratchBlock): CompiledReporter | undefined {
    if (this.reporterCache.has(block)) return this.reporterCache.get(block) ?? undefined
    const numberInput = (name: string, fallback: ScratchValue) => {
      const input = this.compiledInput(block, name, fallback)
      return (target: ScratchTarget) => Cast.toNumber(input(target))
    }
    const valueInput = (name: string, fallback: ScratchValue) => this.compiledInput(block, name, fallback)
    let compiled: CompiledReporter | undefined
    switch (block.opcode) {
      case 'operator_add': {
        const a = numberInput('NUM1', 0)
        const b = numberInput('NUM2', 0)
        compiled = (target) => a(target) + b(target)
        break
      }
      case 'operator_subtract': {
        const a = numberInput('NUM1', 0)
        const b = numberInput('NUM2', 0)
        compiled = (target) => a(target) - b(target)
        break
      }
      case 'operator_multiply': {
        const a = numberInput('NUM1', 0)
        const b = numberInput('NUM2', 0)
        compiled = (target) => a(target) * b(target)
        break
      }
      case 'operator_divide': {
        const a = numberInput('NUM1', 0)
        const b = numberInput('NUM2', 1)
        compiled = (target) => a(target) / b(target)
        break
      }
      case 'operator_equals': {
        const a = valueInput('OPERAND1', '')
        const b = valueInput('OPERAND2', '')
        compiled = (target) => Cast.compare(a(target), b(target)) === 0
        break
      }
      case 'operator_gt': {
        const a = valueInput('OPERAND1', 0)
        const b = valueInput('OPERAND2', 0)
        compiled = (target) => Cast.compare(a(target), b(target)) > 0
        break
      }
      case 'operator_lt': {
        const a = valueInput('OPERAND1', 0)
        const b = valueInput('OPERAND2', 0)
        compiled = (target) => Cast.compare(a(target), b(target)) < 0
        break
      }
      case 'operator_and': {
        const a = valueInput('OPERAND1', false)
        const b = valueInput('OPERAND2', false)
        compiled = (target) => truthy(a(target)) && truthy(b(target))
        break
      }
      case 'operator_or': {
        const a = valueInput('OPERAND1', false)
        const b = valueInput('OPERAND2', false)
        compiled = (target) => truthy(a(target)) || truthy(b(target))
        break
      }
      case 'operator_not': {
        const value = valueInput('OPERAND', false)
        compiled = (target) => !truthy(value(target))
        break
      }
      case 'operator_join': {
        const a = valueInput('STRING1', '')
        const b = valueInput('STRING2', '')
        compiled = (target) => `${Cast.toString(a(target))}${Cast.toString(b(target))}`
        break
      }
      case 'operator_letter_of': {
        const text = valueInput('STRING', '')
        const index = numberInput('LETTER', 1)
        compiled = (target) => Cast.toString(text(target))[Math.floor(index(target)) - 1] ?? ''
        break
      }
      case 'operator_length': {
        const text = valueInput('STRING', '')
        compiled = (target) => Cast.toString(text(target)).length
        break
      }
      case 'operator_contains': {
        const text = valueInput('STRING1', '')
        const search = valueInput('STRING2', '')
        compiled = (target) => Cast.toString(text(target)).toLowerCase().includes(Cast.toString(search(target)).toLowerCase())
        break
      }
      case 'operator_mod': {
        const a = valueInput('NUM1', 0)
        const b = valueInput('NUM2', 1)
        compiled = (target) => scratchMod(a(target), b(target))
        break
      }
      case 'operator_round': {
        const value = numberInput('NUM', 0)
        compiled = (target) => Math.round(value(target))
        break
      }
      case 'operator_mathop': {
        const value = numberInput('NUM', 0)
        const operator = block.fields?.OPERATOR?.[0] ?? 'abs'
        compiled = (target) => mathOp(operator, value(target))
        break
      }
      case 'data_variable': {
        const id = block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0]
        compiled = (target) => this.fastVariableValue(target, id, 0)
        break
      }
      case 'data_itemoflist': {
        const id = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
        const indexValue = valueInput('INDEX', 1)
        compiled = (target) => {
          const list = this.fastListValue(target, id)
          if (!list) return ''
          const index = listIndex(list, indexValue(target))
          return index >= 0 ? list[index] ?? '' : ''
        }
        break
      }
      case 'data_itemnumoflist': {
        const id = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
        const itemValue = valueInput('ITEM', 'thing')
        compiled = (target) => {
          const item = String(itemValue(target))
          const index = this.fastListValue(target, id)?.findIndex((value) => String(value) === item) ?? -1
          return index >= 0 ? index + 1 : 0
        }
        break
      }
      case 'data_lengthoflist': {
        const id = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
        compiled = (target) => this.fastListValue(target, id)?.length ?? 0
        break
      }
      case 'data_listcontainsitem': {
        const id = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
        const itemValue = valueInput('ITEM', 'thing')
        compiled = (target) => {
          const item = String(itemValue(target))
          return this.fastListValue(target, id)?.some((value) => String(value) === item) ?? false
        }
        break
      }
      case 'sensing_keypressed': {
        const key = block.fields?.KEY_OPTION?.[0]
        const input = valueInput('KEY_OPTION', 'space')
        compiled = (target) => keyPressed(this.ioData.get('keyboard'), key ?? String(input(target)))
        break
      }
      case 'sensing_mousedown':
        compiled = () => mouseButtonDown(this.ioData.get('mouse'))
        break
      case 'sensing_mousex':
        compiled = () => mouseCoordinate(this.ioData.get('mouse'), 'x')
        break
      case 'sensing_mousey':
        compiled = () => mouseCoordinate(this.ioData.get('mouse'), 'y')
        break
    }
    this.reporterCache.set(block, compiled ?? null)
    return compiled
  }

  private compiledInput(block: ScratchBlock, name: string, fallback: ScratchValue): CompiledReporter {
    const input = block.inputs?.[name]
    const value = input?.[1]
    if (Array.isArray(value)) {
      const code = value[0]
      if (code === 12) {
        const id = String(value[2] ?? value[1] ?? '')
        const fallbackValue = toScratchValue(value[1] ?? fallback)
        return (target) => this.fastVariableValue(target, id, fallbackValue)
      }
      if (code === 13) {
        const id = String(value[2] ?? value[1] ?? '')
        const fallbackValue = toScratchValue(value[1] ?? fallback)
        return (target) => this.fastListValue(target, id)?.join(' ') ?? fallbackValue
      }
      const literal = value[1]
      const literalValue = typeof literal === 'number' || typeof literal === 'boolean' ? literal : String(literal ?? fallback)
      return () => literalValue
    }
    if (typeof value === 'string') {
      const childId = value
      return (target) => {
        const child = target.blocks[childId]
        return child ? this.reporterValue(target, child) : fallback
      }
    }
    return () => fallback
  }

  private statementInfo(block: ScratchBlock): StatementInfo {
    const cached = this.statementCache.get(block)
    if (cached) return cached
    const info: StatementInfo = {}
    if (block.opcode === 'data_setvariableto' || block.opcode === 'data_changevariableby') {
      info.variableId = block.fields?.VARIABLE?.[1] ?? block.fields?.VARIABLE?.[0] ?? block.fields?.VARIABLE_NAME?.[0]
      info.value = this.compiledInput(block, 'VALUE', block.opcode === 'data_changevariableby' ? 1 : 0)
    } else if (block.opcode === 'data_addtolist') {
      info.listId = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
      info.item = this.compiledInput(block, 'ITEM', 'thing')
    } else if (block.opcode === 'data_deleteoflist') {
      info.listId = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
      info.index = this.compiledInput(block, 'INDEX', 1)
    } else if (block.opcode === 'data_deletealloflist') {
      info.listId = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
    } else if (block.opcode === 'data_insertatlist' || block.opcode === 'data_replaceitemoflist') {
      info.listId = block.fields?.LIST?.[1] ?? block.fields?.LIST?.[0] ?? block.fields?.LIST_NAME?.[0]
      info.index = this.compiledInput(block, 'INDEX', 1)
      info.item = this.compiledInput(block, 'ITEM', 'thing')
    } else if (block.opcode === 'control_if' || block.opcode === 'control_if_else') {
      info.condition = this.compiledInput(block, 'CONDITION', false)
    }
    this.statementCache.set(block, info)
    return info
  }

  private procedureInfo(target: ScratchTarget, proccode: string): ProcedureInfo | null {
    let cache = this.procedureCache.get(target)
    if (!cache) {
      cache = new Map()
      this.procedureCache.set(target, cache)
    }
    if (cache.has(proccode)) return cache.get(proccode) ?? null
    const info = procedureInfo(target, proccode)
    cache.set(proccode, info)
    return info
  }

  private fastVariableValue(target: ScratchTarget, idOrName: string | undefined, fallback: ScratchValue): ScratchValue {
    if (!idOrName) return fallback
    const local = target.variables[idOrName]
    if (local) return local[1]
    const stage = this.getStage()
    const global = stage !== target ? stage.variables[idOrName] : undefined
    if (global) return global[1]
    return this.variableRecord(target, idOrName)?.[1][1] ?? fallback
  }

  private fastListValue(target: ScratchTarget, idOrName: string | undefined): ScratchValue[] | undefined {
    if (!idOrName) return undefined
    const local = target.lists[idOrName]
    if (local) return local[1]
    const stage = this.getStage()
    const global = stage !== target ? stage.lists[idOrName] : undefined
    if (global) return global[1]
    return this.listRecord(target, idOrName)?.[1][1]
  }

  private assignVariableFast(target: ScratchTarget, idOrName: string | undefined, value: ScratchValue): void {
    const local = idOrName ? target.variables[idOrName] : undefined
    if (local) {
      local[1] = value
      return
    }
    const stage = this.getStage()
    const global = idOrName && stage !== target ? stage.variables[idOrName] : undefined
    if (global) {
      global[1] = value
      if (global[2] === true) callProvider(this.cloudProvider, 'updateVariable', global[0], value)
      return
    }
    const record = this.variableRecord(target, idOrName)
    if (record) this.assignVariableValue(record, value)
  }

  private changeVariableFast(target: ScratchTarget, idOrName: string | undefined, delta: number): void {
    const current = this.fastVariableValue(target, idOrName, 0)
    this.assignVariableFast(target, idOrName, Cast.toNumber(current) + delta)
  }

  private variableRecord(target: ScratchTarget, idOrName: string | undefined): [ScratchTarget, VariableRecord, string] | undefined {
    if (!idOrName) return undefined
    const local = this.variableRecordForTarget(target, idOrName)
    if (local) return local
    const stage = this.getStage()
    if (stage !== target) {
      const global = this.variableRecordForTarget(stage, idOrName)
      if (global) return global
    }
    return undefined
  }

  private listRecord(target: ScratchTarget, idOrName: string | undefined): [ScratchTarget, ListRecord, string] | undefined {
    if (!idOrName) return undefined
    const local = this.listRecordForTarget(target, idOrName)
    if (local) return local
    const stage = this.getStage()
    if (stage !== target) {
      const global = this.listRecordForTarget(stage, idOrName)
      if (global) return global
    }
    return undefined
  }

  private variableRecordForTarget(target: ScratchTarget, idOrName: string): [ScratchTarget, VariableRecord, string] | undefined {
    const byId = target.variables[idOrName]
    if (byId) return [target, byId, idOrName]
    const id = this.variableIdByName(target, idOrName)
    return id ? [target, target.variables[id]!, id] : undefined
  }

  private listRecordForTarget(target: ScratchTarget, idOrName: string): [ScratchTarget, ListRecord, string] | undefined {
    const byId = target.lists[idOrName]
    if (byId) return [target, byId, idOrName]
    const id = this.listIdByName(target, idOrName)
    return id ? [target, target.lists[id]!, id] : undefined
  }

  private variableIdByName(target: ScratchTarget, name: string): string | undefined {
    let cache = this.variableLookupCache.get(target)
    if (!cache) {
      cache = new Map(Object.entries(target.variables).map(([id, variable]) => [variable[0], id]))
      this.variableLookupCache.set(target, cache)
    }
    return cache.get(name)
  }

  private listIdByName(target: ScratchTarget, name: string): string | undefined {
    let cache = this.listLookupCache.get(target)
    if (!cache) {
      cache = new Map(Object.entries(target.lists).map(([id, list]) => [list[0], id]))
      this.listLookupCache.set(target, cache)
    }
    return cache.get(name)
  }

  private clearDataLookupCache(target?: ScratchTarget): void {
    if (target) {
      this.variableLookupCache.delete(target)
      this.listLookupCache.delete(target)
      return
    }
    this.variableLookupCache = new WeakMap()
    this.listLookupCache = new WeakMap()
  }

  private clearReporterCache(): void {
    this.reporterCache = new WeakMap()
    this.statementCache = new WeakMap()
    this.procedureCache = new WeakMap()
    this.hatCache.clear()
  }

  private refreshMonitorValues(): void {
    for (const monitor of this.project.monitors) {
      if (!monitor.visible) continue
      if (monitor.opcode === 'data_variable') {
        const target = this.monitorTarget(monitor)
        const variable = this.variableRecord(target, monitorIdTail(monitor.id) ?? String(monitor.params.VARIABLE ?? ''))
          ?? this.variableRecord(target, String(monitor.params.VARIABLE ?? ''))
        if (variable) {
          monitor.params.VARIABLE = variable[1][0]
          monitor.spriteName = variable[0].isStage ? undefined : variable[0].name
          monitor.value = variable[1][1]
        }
      } else if (monitor.opcode === 'data_listcontents') {
        const target = this.monitorTarget(monitor)
        const list = this.listRecord(target, monitorIdTail(monitor.id) ?? String(monitor.params.LIST ?? ''))
          ?? this.listRecord(target, String(monitor.params.LIST ?? ''))
        if (list) {
          monitor.params.LIST = list[1][0]
          monitor.spriteName = list[0].isStage ? undefined : list[0].name
          monitor.value = [...list[1][1]]
        }
      } else if (monitor.opcode) {
        const target = this.monitorTarget(monitor)
        monitor.spriteName = isSpriteSpecificMonitor(monitor.opcode) && !target.isStage ? target.name : undefined
        monitor.value = this.reporterValue(target, {
          opcode: monitor.opcode,
          fields: monitorParamsToFields(monitor.params),
          inputs: {},
          next: null,
          parent: null,
          shadow: false,
        })
      }
    }
  }

  private monitorTarget(monitor: ScratchMonitor): ScratchTarget {
    if (monitor.spriteName) return this.getTarget(monitor.spriteName) ?? this.getStage()
    const prefix = monitor.id.includes(':') ? monitor.id.slice(0, monitor.id.lastIndexOf(':')) : ''
    return (prefix ? this.getTarget(prefix) : undefined) ?? this.getStage()
  }

  private setLoopVariable(target: ScratchTarget, idOrName: string, value: ScratchValue): void {
    const variable = this.variableRecord(target, idOrName)
    if (variable) this.assignVariableValue(variable, value)
  }

  private assignVariableValue(record: [ScratchTarget, VariableRecord, string], value: ScratchValue): void {
    record[1][1] = value
    if (record[0].isStage && record[1][2] === true) callProvider(this.cloudProvider, 'updateVariable', record[1][0], value)
  }

  private currentArgumentValue(block: ScratchBlock): ScratchValue {
    const name = String(block.fields?.VALUE?.[0] ?? block.fields?.VALUE?.[1] ?? '')
    if (!name) return ''
    return this.currentThread?.procArgs[name] ?? ''
  }

  private procedureCallArgs(target: ScratchTarget, block: ScratchBlock, procedure?: ProcedureInfo): Record<string, ScratchValue> {
    const args: Record<string, ScratchValue> = {}
    const ids = parseStringArray(block.mutation?.argumentids)
    const callNames = parseStringArray(block.mutation?.argumentnames)
    const callDefaults = parseScratchValueArray(block.mutation?.argumentdefaults)
    const definitionIds = procedure?.argumentIds ?? []
    const definitionNames = procedure?.argumentNames ?? []
    const definitionDefaults = procedure?.argumentDefaults ?? []
    ids.forEach((id, index) => {
      const definitionIndex = definitionIds.indexOf(id)
      const name = callNames[index] ?? definitionNames[definitionIndex] ?? definitionNames[index] ?? id
      const fallback = callDefaults[index] ?? definitionDefaults[definitionIndex] ?? definitionDefaults[index] ?? ''
      const value = this.inputValue(target, block, id, fallback)
      args[id] = value
      args[name] = value
    })
    return args
  }

  private executeAliasedExtensionWait(thread: RuntimeThread, block: ScratchBlock, now: number): string | null | 'yield' {
    const id = findBlockId(thread.target, block)
    const beats = finiteNonNegative(this.inputValue(thread.target, block, 'BEATS', 0), 0)
    const duration = beats > 0
      ? (beats * 60000) / Math.max(1, this.getStage().tempo ?? 60)
      : durationMsFromMilliseconds(this.inputValue(thread.target, block, 'DURATION', this.inputValue(thread.target, block, 'TIME', 0)), 0)
    this.emit('EXTENSION_ACTUATOR', { opcode: block.opcode, targetName: thread.target.name })
    if (duration <= 0) return null
    if (thread.waitingBlockId !== id) {
      thread.waitingBlockId = id
      thread.waitUntil = now + duration
      return 'yield'
    }
    thread.waitingBlockId = undefined
    thread.waitUntil = 0
    return null
  }

  private executeSpeechWait(thread: RuntimeThread, block: ScratchBlock, now: number): string | null | 'yield' {
    const text = speechValue(this.ioData.get('speech'))
    this.postIOData('speech', { text, listening: true })
    const id = findBlockId(thread.target, block)
    if (thread.waitingBlockId !== id) {
      thread.waitingBlockId = id
      thread.waitUntil = now + 1
      return 'yield'
    }
    thread.waitingBlockId = undefined
    thread.waitUntil = 0
    return null
  }

  private extensionHatActive(target: ScratchTarget, block: ScratchBlock): boolean {
    switch (block.opcode) {
      case 'videoSensing_whenMotionGreaterThan':
      case 'whenMotionGreaterThan':
        return videoSensingValue(this.ioData.get('video'), 'motion') > Cast.toNumber(this.inputValue(target, block, 'REFERENCE', 10))
      case 'speech2text_whenIHearHat':
      case 'whenIHearHat':
        return speechValue(this.ioData.get('speech')).toLowerCase().includes(String(this.inputValue(target, block, 'PHRASE', block.fields?.PHRASE?.[0] ?? '')).toLowerCase())
      case 'makeymakey_whenMakeyKeyPressed':
      case 'whenMakeyKeyPressed':
        return keyPressed(this.ioData.get('keyboard'), String(this.inputValue(target, block, 'KEY', block.fields?.KEY?.[0] ?? 'space')))
      case 'makeymakey_whenCodePressed':
      case 'whenCodePressed':
        return extensionBoolean(this.ioData.get('makeymakey'), 'codePressed')
      case 'microbit_whenButtonPressed':
      case 'ev3_whenButtonPressed':
      case 'whenButtonPressed':
        return extensionBoolean(this.ioData.get(extensionDevice(block.opcode)), 'buttonPressed')
      case 'microbit_whenGesture':
      case 'gdxfor_whenGesture':
      case 'whenGesture':
        return extensionBoolean(this.ioData.get(extensionDevice(block.opcode)), 'gesture')
      case 'microbit_whenTilted':
      case 'wedo2_whenTilted':
      case 'boost_whenTilted':
      case 'gdxfor_whenTilted':
      case 'faceSensing_whenTilted':
      case 'whenTilted':
        return extensionBoolean(this.ioData.get(extensionDevice(block.opcode)), 'tilted')
      case 'microbit_whenPinConnected':
      case 'whenPinConnected':
        return extensionBoolean(this.ioData.get('microbit'), 'pinConnected')
      case 'ev3_whenDistanceLessThan':
      case 'whenDistanceLessThan':
        return extensionNumber(this.ioData.get('ev3'), 'distance', Infinity) < Cast.toNumber(this.inputValue(target, block, 'DISTANCE', 10))
      case 'ev3_whenBrightnessLessThan':
      case 'whenBrightnessLessThan':
        return extensionNumber(this.ioData.get('ev3'), 'brightness', Infinity) < Cast.toNumber(this.inputValue(target, block, 'DISTANCE', 50))
      case 'wedo2_whenDistance':
      case 'whenDistance':
        return extensionBoolean(this.ioData.get('wedo2'), 'distanceChanged')
      case 'boost_whenColor':
      case 'whenColor':
        return extensionBoolean(this.ioData.get('boost'), 'seeingColor')
      case 'gdxfor_whenForcePushedOrPulled':
      case 'whenForcePushedOrPulled':
        return extensionNumber(this.ioData.get('gdxfor'), 'force', 0) !== 0
      case 'faceSensing_whenFaceDetected':
      case 'whenFaceDetected':
        return extensionBoolean(this.ioData.get('face'), 'detected')
      case 'faceSensing_whenSpriteTouchesPart':
      case 'whenSpriteTouchesPart':
        return extensionBoolean(this.ioData.get('face'), 'touchingPart')
      default:
        return false
    }
  }

  private playSound(target: ScratchTarget, nameOrId: string): { done: boolean; durationMs: number; promise?: Promise<unknown> } {
    const sound = resolveSound(target, nameOrId)
    if (!sound) return { done: true, durationMs: 0 }
    const result = callAudio(this.audioEngine, 'playSound', target.name, structuredClone(sound))
    this.emit('SOUND_PLAYED', { targetName: target.name, sound: structuredClone(sound) })
    const promise = isPromiseLike(result) ? Promise.resolve(result) : undefined
    return {
      done: false,
      durationMs: soundDurationMs(sound),
      promise,
    }
  }

  private resolveMotionPoint(target: ScratchTarget, option: string): { x: number; y: number } | undefined {
    if (option === '_random_' || option === 'random position') return { x: randomBetween(-240, 240), y: randomBetween(-180, 180) }
    if (option === '_mouse_' || option === 'mouse-pointer') {
      const mouse = this.ioData.get('mouse')
      return { x: mouseCoordinate(mouse, 'x'), y: mouseCoordinate(mouse, 'y') }
    }
    const other = this.getTarget(option)
    if (other && !other.isStage && other !== target) return { x: other.x ?? 0, y: other.y ?? 0 }
    return undefined
  }

  private touchingObject(target: ScratchTarget, option: string): boolean {
    if (target.isStage || target.visible === false) return false
    const bounds = targetBounds(target)
    if (option === '_mouse_' || option === 'mouse-pointer') {
      const x = mouseCoordinate(this.ioData.get('mouse'), 'x')
      const y = mouseCoordinate(this.ioData.get('mouse'), 'y')
      if (this.renderer?.drawableTouchingScratchPoint) return this.renderer.drawableTouchingScratchPoint(target.drawableId ?? target.id ?? target.name, x, y)
      return pointInBounds(x, y, bounds)
    }
    if (option === '_edge_' || option === 'edge') {
      return bounds.left <= -240 || bounds.right >= 240 || bounds.bottom <= -180 || bounds.top >= 180
    }
    const other = this.getTarget(option)
    if (!other || other.isStage || other.visible === false) return false
    if (this.renderer?.isTouchingDrawables) {
      const candidates = [other.id, other.name, other.drawableId === undefined ? undefined : String(other.drawableId)].filter((value): value is string => !!value)
      return this.renderer.isTouchingDrawables(target.drawableId ?? target.id ?? target.name, candidates)
    }
    return boundsIntersect(bounds, targetBounds(other))
  }

  private distanceTo(target: ScratchTarget, option: string): number {
    const point = this.resolveMotionPoint(target, option)
    if (!point) return 10000
    return Math.hypot((target.x ?? 0) - point.x, (target.y ?? 0) - point.y)
  }

  private targetTouchesColor(target: ScratchTarget, color: { r: number; g: number; b: number; a: number }): boolean {
    if (target.isStage || target.visible === false) return false
    if (this.renderer?.isTouchingColor) return this.renderer.isTouchingColor(target.drawableId ?? target.id ?? target.name, color)
    if (!this.renderer?.sampleColor) return false
    for (const point of collisionSamplePoints(targetBounds(target))) {
      const sampled = this.renderer.sampleColor(point.x, point.y)
      if (colorsClose(sampled, color)) return true
    }
    return false
  }

  private targetLooksLikeColor(target: ScratchTarget, color: { r: number; g: number; b: number; a: number }): boolean {
    const fill = parseColor(spriteFillColor(target, false))
    if (fill && colorsClose(fill, color)) return true
    if (this.renderer?.sampleColor) {
      for (const point of collisionSamplePoints(targetBounds(target))) {
        if (colorsClose(this.renderer.sampleColor(point.x, point.y), color)) return true
      }
    }
    const effectsColor = Number(target.effects?.color) || 0
    if (effectsColor !== 0) return false
    return target.costumes.length === 0 && !!fill && colorsClose(fill, color)
  }

  private recordPenMovement(target: ScratchTarget, beforeX: number, beforeY: number): void {
    if (target.isStage || !target.pen?.down) return
    const afterX = target.x ?? 0
    const afterY = target.y ?? 0
    if (afterX === beforeX && afterY === beforeY) return
    const stationary = this.stationaryPenDown.get(target)
    if (stationary) stationary.moved = true
    this.renderer?.penLine?.({
      x1: beforeX,
      y1: beforeY,
      x2: afterX,
      y2: afterY,
      color: target.pen.color,
      size: target.pen.size,
      transparency: target.pen.transparency,
    })
  }

  private recordStationaryPenDot(target: ScratchTarget): void {
    const stationary = this.stationaryPenDown.get(target)
    this.stationaryPenDown.delete(target)
    if (target.isStage || !target.pen?.down || !stationary || stationary.moved) return
    const x = target.x ?? 0
    const y = target.y ?? 0
    if (x !== stationary.x || y !== stationary.y) return
    this.renderer?.penLine?.({
      x1: x,
      y1: y,
      x2: x,
      y2: y,
      color: target.pen.color,
      size: target.pen.size,
      transparency: target.pen.transparency,
    })
  }
}

export function createDefaultProject(): ScratchProject {
  return {
    targets: [createStageTarget(), createSpriteTarget('Sprite1', 1)],
    monitors: [],
    extensions: [],
    meta: {
      semver: '3.0.0',
      vm: 'hikkaku-clean-room',
      agent: 'hikkaku-cloud',
    },
  }
}

export class ScratchCanvasRenderer implements RendererFacade {
  private canvas?: ScratchCanvasHost
  private context?: ScratchCanvas2DContext
  private backCanvas?: ScratchCanvasHost
  private backContext?: ScratchCanvas2DContext
  private hitCanvas?: ScratchCanvasHost
  private hitContext?: ScratchCanvas2DContext
  private colorHitCanvas?: ScratchCanvasHost
  private colorHitContext?: ScratchCanvas2DContext
  private penCanvas?: ScratchCanvasHost
  private penContext?: ScratchCanvas2DContext
  private gl?: WebGLRenderingContext
  private glProgram?: WebGLProgram
  private glTexture?: WebGLTexture
  private glPositionBuffer?: WebGLBuffer
  private glTexcoordBuffer?: WebGLBuffer
  private lastSnapshot?: RuntimeSnapshot
  private pendingPenLines: PenLine[] = []
  private pendingPenClear = false
  private queuedDrawSnapshot?: RuntimeSnapshot
  private queuedDirectPenLines?: PenLine[]
  private drawScheduled = false
  private nextSkinId = 1
  private nextDrawableId = 1
  private backgroundColor: [number, number, number] = [1, 1, 1]
  private skins = new Map<number, { type: string; data?: unknown; size: [number, number]; rotationCenter: [number, number] }>()
  private drawables = new Map<number, { skinId?: number; group?: string; order: number; visible: boolean; position: [number, number]; direction: number; scale: [number, number]; effects: Record<string, number> }>()
  private assetResolver?: (assetId: string, dataFormat?: string) => Promise<Uint8Array | undefined>
  private costumeImages = new Map<string, { status: 'loading' | 'ready' | 'error'; image?: ScratchCostumeImage; objectUrl?: string }>()

  private createSkin(type: string, data: unknown, rotationCenter: [number, number]): number {
    const id = this.nextSkinId++
    this.skins.set(id, { type, data, size: type === 'text' ? [96, 24] : [96, 96], rotationCenter })
    return id
  }

  attachCanvas(canvas: ScratchCanvasHost): void {
    this.canvas = canvas
    this.configureWebGL(canvas)
    if (!this.gl) this.context = canvas.getContext('2d') ?? undefined
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  setAssetResolver(resolver: (assetId: string, dataFormat?: string) => Promise<Uint8Array | undefined>): void {
    this.assetResolver = resolver
    this.clearCachedCostumes()
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  cacheCostumeImage(assetId: string, dataFormat: string, image: ScratchCostumeImage): void {
    this.releaseCostumeImage(this.costumeImages.get(`${assetId}:${dataFormat}`))
    this.costumeImages.set(`${assetId}:${dataFormat}`, { status: 'ready', image })
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  clearCachedCostumes(): void {
    this.costumeImages.forEach((entry) => this.releaseCostumeImage(entry))
    this.costumeImages.clear()
  }

  private releaseCostumeImage(entry: { image?: ScratchCostumeImage; objectUrl?: string } | undefined): void {
    if (!entry) return
    if (entry.objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(entry.objectUrl)
    if (entry.image && 'close' in entry.image && typeof entry.image.close === 'function') entry.image.close()
  }

  setBackgroundColor(red: number, green: number, blue: number): void {
    this.backgroundColor = [red, green, blue]
    if (this.canvas && this.context && !this.lastSnapshot) {
      this.context.fillStyle = `rgb(${Math.round(red * 255)}, ${Math.round(green * 255)}, ${Math.round(blue * 255)})`
      this.context.fillRect(0, 0, this.canvas.width, this.canvas.height)
    }
  }

  setStageSize(_xLeft = -240, _xRight = 240, _yBottom = -180, _yTop = 180): void {
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  getNativeSize(): [number, number] {
    return [480, 360]
  }

  resize(width: number, height: number): void {
    if (!this.canvas) return
    this.canvas.width = width
    this.canvas.height = height
    if (this.backCanvas) {
      this.backCanvas.width = width
      this.backCanvas.height = height
    }
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  draw(): void {
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  requestDraw(snapshot: RuntimeSnapshot): void {
    this.lastSnapshot = snapshot
    this.prefetchSnapshotCostumes(snapshot)
    if (!this.canvas) return
    this.queuedDrawSnapshot = snapshot
    this.queuedDirectPenLines = undefined
    if (this.drawScheduled) return
    this.drawScheduled = true
    scheduleRendererDraw(() => {
      this.drawScheduled = false
      this.drawQueuedSnapshot()
    })
  }

  private drawQueuedSnapshot(): void {
    const snapshot = this.queuedDrawSnapshot
    if (!snapshot || !this.canvas) return
    const directPenLines = this.queuedDirectPenLines
    this.queuedDrawSnapshot = undefined
    this.queuedDirectPenLines = undefined
    if (!directPenLines) this.flushPenLayer()
    if (this.gl && this.backContext && this.backCanvas) {
      this.backCanvas.width = this.canvas.width
      this.backCanvas.height = this.canvas.height
      drawSnapshot(this.backContext, this.backCanvas.width, this.backCanvas.height, snapshot, snapshot.selectedTargetId, (costume, target) => this.resolveCostumeImage(costume, target), directPenLines ? undefined : this.penCanvas, directPenLines)
      this.presentWebGL()
      return
    }
    if (!this.context) return
    drawSnapshot(this.context, this.canvas.width, this.canvas.height, snapshot, snapshot.selectedTargetId, (costume, target) => this.resolveCostumeImage(costume, target), directPenLines ? undefined : this.penCanvas, directPenLines)
  }

  private prefetchSnapshotCostumes(snapshot: RuntimeSnapshot): void {
    for (const target of snapshot.project.targets) {
      for (const costume of target.costumes) this.resolveCostumeImage(costume)
    }
  }

  private resolveCostumeImage(costume: ScratchCostume | undefined, _target?: ScratchTarget): ResolvedCostumeImage | undefined {
    if (!costume || typeof Blob === 'undefined') return undefined
    const dataFormat = costume.dataFormat ?? extensionFromMd5ext(costume.md5ext) ?? ''
    const assetId = costume.md5ext ?? costume.assetId
    if (!assetId || !dataFormat) return undefined
    const key = `${assetId}:${dataFormat}`
    const cached = this.costumeImages.get(key)
    if (cached?.status === 'ready' && cached.image) {
      return { image: cached.image, costume }
    }
    if (cached) return undefined
    if (!this.assetResolver) return undefined
    this.costumeImages.set(key, { status: 'loading' })
    this.assetResolver(assetId, dataFormat)
      .then((bytes) => {
        if (!bytes) {
          this.costumeImages.set(key, { status: 'error' })
          return
        }
        const type = dataFormat === 'svg' ? 'image/svg+xml' : dataFormat === 'jpg' || dataFormat === 'jpeg' ? 'image/jpeg' : 'image/png'
        const blobBytes = new Uint8Array(bytes.length)
        blobBytes.set(bytes)
        const blob = new Blob([blobBytes], { type })
        if (typeof Image === 'undefined' && typeof createImageBitmap === 'function') {
          createImageBitmap(blob)
            .then((image) => {
              this.costumeImages.set(key, { status: 'ready', image })
              if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
            })
            .catch(() => {
              this.costumeImages.set(key, { status: 'error' })
            })
          return
        }
        if (typeof Image === 'undefined' || typeof URL === 'undefined') {
          this.costumeImages.set(key, { status: 'error' })
          return
        }
        const image = new Image()
        const objectUrl = URL.createObjectURL(blob)
        image.onload = () => {
          this.costumeImages.set(key, { status: 'ready', image, objectUrl })
          if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
        }
        image.onerror = () => {
          if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(objectUrl)
          this.costumeImages.set(key, { status: 'error' })
        }
        image.src = objectUrl
      })
      .catch(() => {
        this.costumeImages.set(key, { status: 'error' })
      })
    return undefined
  }

  createBitmapSkin(bitmapData: unknown, _costumeResolution = 1, rotationCenter: [number, number] = [0, 0]): number {
    return this.createSkin('bitmap', bitmapData, rotationCenter)
  }

  createSVGSkin(svgData: unknown, rotationCenter: [number, number] = [0, 0]): number {
    return this.createSkin('svg', svgData, rotationCenter)
  }

  createPenSkin(): number {
    return this.createSkin('pen', undefined, [0, 0])
  }

  penClear(): void {
    this.pendingPenLines = []
    this.pendingPenClear = true
  }

  penLine(line: PenLine): void {
    this.pendingPenLines.push({ ...line })
  }

  penStamp(target: ScratchTarget): void {
    this.flushPenLayer()
    const canvas = this.canvas ?? this.backCanvas
    const layer = this.ensurePenLayer(canvas?.width ?? 480, canvas?.height ?? 360)
    if (!layer) return
    drawSpriteOnly(layer.context, layer.canvas.width, layer.canvas.height, target, (costume, drawable) => this.resolveCostumeImage(costume, drawable))
  }

  private flushPenLayer(): void {
    if (!this.pendingPenClear && this.pendingPenLines.length === 0) return
    const canvas = this.canvas ?? this.backCanvas
    const layer = this.ensurePenLayer(canvas?.width ?? 480, canvas?.height ?? 360)
    if (!layer) return
    if (this.pendingPenClear) {
      layer.context.clearRect(0, 0, layer.canvas.width, layer.canvas.height)
      this.pendingPenClear = false
    }
    if (this.pendingPenLines.length === 0) return
    const lines = this.pendingPenLines
    this.pendingPenLines = []
    drawPenLineRuns(layer.context, layer.canvas.width, layer.canvas.height, lines)
  }

  private takePendingPenFrame(): PenLine[] {
    const lines = this.pendingPenLines
    this.pendingPenLines = []
    this.pendingPenClear = false
    return lines
  }

  createTextSkin(type: string, text: string, _pointsLeft = 0): number {
    return this.createSkin('text', { type, text }, [0, 0])
  }

  updateSVGSkin(skinId: number, svgData: unknown, rotationCenter: [number, number] = [0, 0]): void {
    this.skins.set(skinId, { type: 'svg', data: svgData, size: [96, 96], rotationCenter })
  }

  updateBitmapSkin(skinId: number, bitmapData: unknown, _bitmapResolution = 1, rotationCenter: [number, number] = [0, 0]): void {
    this.skins.set(skinId, { type: 'bitmap', data: bitmapData, size: [96, 96], rotationCenter })
  }

  updateTextSkin(skinId: number, type: string, text: string, _pointsLeft = 0): void {
    this.skins.set(skinId, { type: 'text', data: { type, text }, size: [96, 24], rotationCenter: [0, 0] })
  }

  destroySkin(skinId: number): void {
    this.skins.delete(skinId)
    for (const drawable of this.drawables.values()) {
      if (drawable.skinId === skinId) drawable.skinId = undefined
    }
  }

  createDrawable(group = 'sprite'): number {
    const id = this.nextDrawableId++
    this.drawables.set(id, { group, order: this.drawables.size, visible: true, position: [0, 0], direction: 90, scale: [100, 100], effects: {} })
    return id
  }

  destroyDrawable(drawableId: number): void {
    this.drawables.delete(drawableId)
  }

  setLayerGroupOrdering(_groupOrdering: string[]): void {
    this.draw()
  }

  getDrawableOrder(drawableId: number): number {
    return this.drawables.get(drawableId)?.order ?? -1
  }

  setDrawableOrder(drawableId: number, order: number, _group?: string, isRelative = false, min = 0): void {
    const drawable = this.drawables.get(drawableId)
    if (!drawable) return
    drawable.order = Math.max(min, isRelative ? drawable.order + order : order)
  }

  updateDrawableSkinId(drawableId: number, skinId: number): void {
    const drawable = this.drawables.get(drawableId)
    if (drawable) drawable.skinId = skinId
  }

  updateDrawableScale(drawableId: number, scale: [number, number] | number): void {
    const drawable = this.drawables.get(drawableId)
    if (!drawable) return
    drawable.scale = Array.isArray(scale) ? scale : [scale, scale]
  }

  updateDrawableDirectionScale(drawableId: number, direction: number, scale: [number, number] | number): void {
    this.updateDrawableDirection(drawableId, direction)
    this.updateDrawableScale(drawableId, scale)
  }

  updateDrawableEffect(drawableId: number, effectName: string, value: number): void {
    const drawable = this.drawables.get(drawableId)
    if (drawable) drawable.effects[effectName] = value
  }

  updateDrawableProperties(drawableId: number, properties: Record<string, unknown>): void {
    if (Array.isArray(properties.position)) this.updateDrawablePosition(drawableId, properties.position as [number, number])
    if (typeof properties.direction === 'number') this.updateDrawableDirection(drawableId, properties.direction)
    if (Array.isArray(properties.scale) || typeof properties.scale === 'number') this.updateDrawableScale(drawableId, properties.scale as [number, number] | number)
    if (typeof properties.visible === 'boolean') this.updateDrawableVisible(drawableId, properties.visible)
    if (typeof properties.skinId === 'number') this.updateDrawableSkinId(drawableId, properties.skinId)
  }

  getCurrentSkinSize(drawableId: number): [number, number] {
    const skinId = this.drawables.get(drawableId)?.skinId
    return skinId ? this.getSkinSize(skinId) : [0, 0]
  }

  getSkinSize(skinId: number): [number, number] {
    return this.skins.get(skinId)?.size ?? [0, 0]
  }

  getSkinRotationCenter(skinId: number): [number, number] {
    return this.skins.get(skinId)?.rotationCenter ?? [0, 0]
  }

  clientSpaceToScratchBounds(centerX: number, centerY: number, width = 1, height = 1): ScratchBounds {
    if (!this.canvas) return normalizeBounds({ left: centerX - width / 2, right: centerX + width / 2, top: centerY + height / 2, bottom: centerY - height / 2 })
    const center = canvasToScratchPoint(centerX, centerY, this.canvas.width, this.canvas.height)
    const scratchWidth = (width / this.canvas.width) * 480
    const scratchHeight = (height / this.canvas.height) * 360
    return normalizeBounds({ left: center.x - scratchWidth / 2, right: center.x + scratchWidth / 2, top: center.y + scratchHeight / 2, bottom: center.y - scratchHeight / 2 })
  }

  pick(x: number, y: number, touchWidth = 1, touchHeight = 1, candidateIds?: string[]): string | null {
    if (!this.lastSnapshot) return null
    const bounds = normalizeBounds({
      left: x - touchWidth / 2,
      right: x + touchWidth / 2,
      top: y + touchHeight / 2,
      bottom: y - touchHeight / 2,
    })
    const sprites = this.lastSnapshot.project.targets
      .filter((target) => !target.isStage && target.visible !== false)
      .filter((target) => !candidateIds || candidateIds.includes(target.id ?? target.name) || candidateIds.includes(target.name))
      .sort((a, b) => (b.layerOrder ?? 0) - (a.layerOrder ?? 0))
    for (const sprite of sprites) {
      if (boundsIntersect(bounds, targetBounds(sprite)) && this.spriteContainsScratchPoint(sprite, x, y)) return sprite.id ?? sprite.name
    }
    return null
  }

  getBounds(drawableIdOrName: string | number): ScratchBounds | null {
    if (typeof drawableIdOrName === 'number') return this.drawableBounds(drawableIdOrName)
    const target = this.findDrawable(drawableIdOrName)
    return target ? targetBounds(target) : null
  }

  getBoundsForBubble(drawableIdOrName: string | number): ScratchBounds | null {
    return this.getBounds(drawableIdOrName)
  }

  extractDrawableScreenSpace(drawableIdOrName: string | number): ImageData | null {
    const bounds = this.getBounds(drawableIdOrName)
    if (!bounds || !this.canvas || !this.context) return null
    const leftTop = scratchToCanvasPoint(bounds.left, bounds.top, this.canvas.width, this.canvas.height)
    const rightBottom = scratchToCanvasPoint(bounds.right, bounds.bottom, this.canvas.width, this.canvas.height)
    const x = Math.max(0, Math.floor(leftTop.x))
    const y = Math.max(0, Math.floor(leftTop.y))
    const width = Math.max(1, Math.ceil(rightBottom.x - leftTop.x))
    const height = Math.max(1, Math.ceil(rightBottom.y - leftTop.y))
    return this.context.getImageData(x, y, Math.min(width, this.canvas.width - x), Math.min(height, this.canvas.height - y))
  }

  isTouchingDrawables(drawableIdOrName: string | number, candidateIds?: string[]): boolean {
    const target = this.findDrawable(drawableIdOrName)
    if (typeof drawableIdOrName === 'number') {
      const bounds = this.drawableBounds(drawableIdOrName)
      if (!bounds) return false
      const candidates = [...this.drawables.entries()].filter(([id, drawable]) => id !== drawableIdOrName && drawable.visible && (!candidateIds || candidateIds.includes(String(id))))
      return candidates.some(([id]) => boundsIntersect(bounds, this.drawableBounds(id) ?? bounds))
    }
    if (!target || target.visible === false) return false
    const bounds = targetBounds(target)
    const candidates = (this.lastSnapshot?.project.targets ?? [])
      .filter((item) => !item.isStage && item.visible !== false && item !== target)
      .filter((item) => !candidateIds || candidateIds.includes(item.id ?? item.name) || candidateIds.includes(item.name))
    return candidates.some((item) => {
      const otherBounds = targetBounds(item)
      if (!boundsIntersect(bounds, otherBounds)) return false
      if (!this.canPixelHitTest(target) || !this.canPixelHitTest(item)) return true
      return this.spritesPixelTouching(target, item, boundsIntersection(bounds, otherBounds))
    })
  }

  drawableTouching(drawableIdOrName: string | number, centerX: number, centerY: number, touchWidth = 1, touchHeight = 1): boolean {
    const bounds = this.clientSpaceToScratchBounds(centerX, centerY, touchWidth, touchHeight)
    return this.drawableTouchingScratchRect(drawableIdOrName, bounds.left, bounds.top, bounds.right, bounds.bottom)
  }

  drawableTouchingScratchPoint(drawableIdOrName: string | number, x: number, y: number): boolean {
    if (typeof drawableIdOrName === 'number') {
      const bounds = this.drawableBounds(drawableIdOrName)
      return bounds ? pointInBounds(x, y, bounds) : false
    }
    const target = this.findDrawable(drawableIdOrName)
    if (!target || target.visible === false) return false
    return pointInBounds(x, y, targetBounds(target)) && this.spriteContainsScratchPoint(target, x, y)
  }

  drawableTouchingScratchRect(drawableIdOrName: string | number, left: number, top: number, right: number, bottom: number): boolean {
    if (typeof drawableIdOrName === 'number') {
      const bounds = this.drawableBounds(drawableIdOrName)
      return bounds ? boundsIntersect(bounds, normalizeBounds({ left, top, right, bottom })) : false
    }
    const target = this.findDrawable(drawableIdOrName)
    if (!target || target.visible === false) return false
    const rect = normalizeBounds({ left, top, right, bottom })
    const bounds = targetBounds(target)
    if (!boundsIntersect(bounds, rect)) return false
    const intersection = boundsIntersection(bounds, rect)
    return denseCollisionSamplePoints(intersection).some((point) => this.spriteContainsScratchPoint(target, point.x, point.y))
  }

  isTouchingColor(drawableIdOrName: string | number, color: { r: number; g: number; b: number; a: number }): boolean {
    const target = this.findDrawable(drawableIdOrName)
    if (!target || target.visible === false) return false
    return this.spriteColorTouchesSceneColor(target, undefined, color)
  }

  isColorTouchingColor(drawableIdOrName: string | number, color: { r: number; g: number; b: number; a: number }, touchingColor: { r: number; g: number; b: number; a: number }): boolean {
    const target = this.findDrawable(drawableIdOrName)
    if (!target || target.visible === false) return false
    return this.spriteColorTouchesSceneColor(target, color, touchingColor)
  }

  getFencedPositionOfDrawable(drawableIdOrName: string | number, position: [number, number]): [number, number] {
    const target = this.findDrawable(drawableIdOrName)
    const bounds = typeof drawableIdOrName === 'number' ? this.drawableBounds(drawableIdOrName) : null
    const radius = target ? hitRadius(target) : bounds ? Math.max((bounds.right - bounds.left) / 2, (bounds.top - bounds.bottom) / 2, 10) : 10
    return [bounded(position[0], -240 + radius, 240 - radius), bounded(position[1], -180 + radius, 180 - radius)]
  }

  updateDrawablePosition(drawableIdOrName: string | number, position: [number, number]): void {
    if (typeof drawableIdOrName === 'number') {
      const drawable = this.drawables.get(drawableIdOrName)
      if (!drawable) return
      drawable.position = this.getFencedPositionOfDrawable(drawableIdOrName, position)
      this.draw()
      return
    }
    const target = this.findDrawable(drawableIdOrName)
    if (!target) return
    const [x, y] = this.getFencedPositionOfDrawable(drawableIdOrName, position)
    target.x = x
    target.y = y
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  updateDrawableDirection(drawableIdOrName: string | number, direction: number): void {
    if (typeof drawableIdOrName === 'number') {
      const drawable = this.drawables.get(drawableIdOrName)
      if (drawable) drawable.direction = normalizeDirection(direction)
      this.draw()
      return
    }
    const target = this.findDrawable(drawableIdOrName)
    if (!target) return
    target.direction = normalizeDirection(direction)
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  updateDrawableVisible(drawableIdOrName: string | number, visible: boolean): void {
    if (typeof drawableIdOrName === 'number') {
      const drawable = this.drawables.get(drawableIdOrName)
      if (drawable) drawable.visible = visible
      this.draw()
      return
    }
    const target = this.findDrawable(drawableIdOrName)
    if (!target) return
    target.visible = visible
    if (this.lastSnapshot) this.requestDraw(this.lastSnapshot)
  }

  private findDrawable(drawableIdOrName: string | number): ScratchTarget | undefined {
    if (typeof drawableIdOrName === 'number') return undefined
    return this.lastSnapshot?.project.targets.find((target) => !target.isStage && (target.id === drawableIdOrName || target.name === drawableIdOrName))
  }

  private spriteContainsScratchPoint(sprite: ScratchTarget, x: number, y: number): boolean {
    const canvas = this.canvas ?? this.backCanvas
    if (!canvas || !this.lastSnapshot) return true
    const context = this.hitTestContext(canvas.width, canvas.height)
    if (!context) return true
    context.clearRect(0, 0, canvas.width, canvas.height)
    drawSpriteOnly(context, canvas.width, canvas.height, sprite, (costume, target) => this.resolveCostumeImage(costume, target))
    const point = scratchToCanvasPoint(x, y, canvas.width, canvas.height)
    const sampleX = bounded(Math.floor(point.x), 0, canvas.width - 1)
    const sampleY = bounded(Math.floor(point.y), 0, canvas.height - 1)
    const alpha = context.getImageData(sampleX, sampleY, 1, 1).data[3] ?? 0
    return alpha > 8
  }

  private canPixelHitTest(sprite: ScratchTarget): boolean {
    if (!(this.canvas ?? this.backCanvas)) return false
    const costume = sprite.costumes[sprite.currentCostume ?? 0]
    if (!costume) return false
    const dataFormat = costume.dataFormat ?? extensionFromMd5ext(costume.md5ext) ?? ''
    const assetId = costume.md5ext ?? costume.assetId
    return !!assetId && this.costumeImages.get(`${assetId}:${dataFormat}`)?.status === 'ready'
  }

  private spritesPixelTouching(a: ScratchTarget, b: ScratchTarget, bounds: ScratchBounds): boolean {
    const width = Math.max(2, Math.min(16, Math.ceil(bounds.width / 8)))
    const height = Math.max(2, Math.min(16, Math.ceil(bounds.height / 8)))
    for (let xIndex = 0; xIndex <= width; xIndex += 1) {
      const x = bounds.left + (bounds.width * xIndex) / width
      for (let yIndex = 0; yIndex <= height; yIndex += 1) {
        const y = bounds.bottom + (bounds.height * yIndex) / height
        if (this.spriteContainsScratchPoint(a, x, y) && this.spriteContainsScratchPoint(b, x, y)) return true
      }
    }
    return false
  }

  private spriteColorTouchesSceneColor(sprite: ScratchTarget, spriteColor: { r: number; g: number; b: number; a: number } | undefined, sceneColor: { r: number; g: number; b: number; a: number }): boolean {
    const canvas = this.canvas ?? this.backCanvas
    if (!canvas || !this.lastSnapshot) return false
    const spriteContext = this.hitTestContext(canvas.width, canvas.height)
    const sceneContext = this.colorHitTestContext(canvas.width, canvas.height)
    if (!spriteContext || !sceneContext) return false
    spriteContext.clearRect(0, 0, canvas.width, canvas.height)
    drawSpriteOnly(spriteContext, canvas.width, canvas.height, sprite, (costume, target) => this.resolveCostumeImage(costume, target))
    this.drawSnapshotWithoutTarget(sceneContext, sprite)
    for (const point of denseCollisionSamplePoints(targetBounds(sprite))) {
      const canvasPoint = scratchToCanvasPoint(point.x, point.y, canvas.width, canvas.height)
      const x = bounded(Math.floor(canvasPoint.x), 0, canvas.width - 1)
      const y = bounded(Math.floor(canvasPoint.y), 0, canvas.height - 1)
      const spritePixel = spriteContext.getImageData(x, y, 1, 1).data
      if ((spritePixel[3] ?? 0) <= 8) continue
      if (spriteColor && !colorsClose({ r: spritePixel[0] ?? 0, g: spritePixel[1] ?? 0, b: spritePixel[2] ?? 0, a: spritePixel[3] ?? 0 }, spriteColor)) continue
      const scenePixel = sceneContext.getImageData(x, y, 1, 1).data
      if (colorsClose({ r: scenePixel[0] ?? 0, g: scenePixel[1] ?? 0, b: scenePixel[2] ?? 0, a: scenePixel[3] ?? 0 }, sceneColor)) return true
    }
    return false
  }

  private drawSnapshotWithoutTarget(context: ScratchCanvas2DContext, target: ScratchTarget): void {
    if (!this.lastSnapshot) return
    const snapshot = {
      ...this.lastSnapshot,
      project: {
        ...this.lastSnapshot.project,
        targets: this.lastSnapshot.project.targets.map((item) => (item === target || item.id === target.id || item.name === target.name ? { ...item, visible: false } : item)),
      },
    }
    const canvas = this.canvas ?? this.backCanvas
    if (!canvas) return
    drawSnapshot(context, canvas.width, canvas.height, snapshot, '', (costume, target) => this.resolveCostumeImage(costume, target), this.penCanvas)
  }

  private hitTestContext(width: number, height: number): ScratchCanvas2DContext | undefined {
    if (!this.hitCanvas) {
      this.hitCanvas = createCanvasHost(width, height)
      this.hitContext = this.hitCanvas.getContext('2d', { willReadFrequently: true }) ?? undefined
    }
    if (!this.hitContext || !this.hitCanvas) return undefined
    if (this.hitCanvas.width !== width) this.hitCanvas.width = width
    if (this.hitCanvas.height !== height) this.hitCanvas.height = height
    return this.hitContext
  }

  private colorHitTestContext(width: number, height: number): ScratchCanvas2DContext | undefined {
    if (!this.colorHitCanvas) {
      this.colorHitCanvas = createCanvasHost(width, height)
      this.colorHitContext = this.colorHitCanvas.getContext('2d', { willReadFrequently: true }) ?? undefined
    }
    if (!this.colorHitContext || !this.colorHitCanvas) return undefined
    if (this.colorHitCanvas.width !== width) this.colorHitCanvas.width = width
    if (this.colorHitCanvas.height !== height) this.colorHitCanvas.height = height
    return this.colorHitContext
  }

  private ensurePenLayer(width: number, height: number): { canvas: ScratchCanvasHost; context: ScratchCanvas2DContext } | undefined {
    width = SCRATCH_STAGE_WIDTH
    height = SCRATCH_STAGE_HEIGHT
    if (!this.penCanvas) {
      this.penCanvas = createCanvasHost(width, height)
      this.penContext = this.penCanvas.getContext('2d') ?? undefined
    }
    if (!this.penCanvas || !this.penContext) return undefined
    if (this.penCanvas.width !== width || this.penCanvas.height !== height) {
      const previous = this.penCanvas.width > 0 && this.penCanvas.height > 0 ? this.penCanvas : undefined
      let copy: ScratchCanvasHost | undefined
      if (previous) {
        copy = createCanvasHost(previous.width, previous.height)
        copy.width = previous.width
        copy.height = previous.height
        copy.getContext('2d')?.drawImage(previous, 0, 0)
      }
      this.penCanvas.width = width
      this.penCanvas.height = height
      if (copy) this.penContext.drawImage(copy, 0, 0, width, height)
    }
    return { canvas: this.penCanvas, context: this.penContext }
  }

  private drawableBounds(drawableId: number): ScratchBounds | null {
    const drawable = this.drawables.get(drawableId)
    if (!drawable || drawable.visible === false) return null
    const skinSize: [number, number] = drawable.skinId ? this.getSkinSize(drawable.skinId) : [20, 20]
    const rotationCenter: [number, number] = drawable.skinId ? this.getSkinRotationCenter(drawable.skinId) : [skinSize[0] / 2, skinSize[1] / 2]
    const scaleX = drawable.scale[0] / 100
    const scaleY = drawable.scale[1] / 100
    const left = -rotationCenter[0] * scaleX
    const right = (skinSize[0] - rotationCenter[0]) * scaleX
    const top = rotationCenter[1] * scaleY
    const bottom = -(skinSize[1] - rotationCenter[1]) * scaleY
    const radians = ((drawable.direction - 90) * Math.PI) / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    const corners = [
      rotatePoint(left, top, cos, sin),
      rotatePoint(right, top, cos, sin),
      rotatePoint(right, bottom, cos, sin),
      rotatePoint(left, bottom, cos, sin),
    ]
    return normalizeBounds({
      left: drawable.position[0] + Math.min(...corners.map((point) => point.x)),
      right: drawable.position[0] + Math.max(...corners.map((point) => point.x)),
      top: drawable.position[1] + Math.max(...corners.map((point) => point.y)),
      bottom: drawable.position[1] + Math.min(...corners.map((point) => point.y)),
    })
  }

  sampleColor(x: number, y: number): { r: number; g: number; b: number; a: number } {
    const sampleContext = this.context ?? this.backContext
    const sampleCanvas = this.context ? this.canvas : this.backCanvas
    if (!sampleCanvas || !sampleContext) return { r: 0, g: 0, b: 0, a: 0 }
    const point = scratchToCanvasPoint(x, y, sampleCanvas.width, sampleCanvas.height)
    const data = sampleContext.getImageData(point.x, point.y, 1, 1).data
    return { r: data[0] ?? 0, g: data[1] ?? 0, b: data[2] ?? 0, a: data[3] ?? 0 }
  }

  extractColor(x: number, y: number, _radius = 1): Uint8ClampedArray {
    const color = this.sampleColor(x, y)
    return new Uint8ClampedArray([color.r, color.g, color.b, color.a])
  }

  requestSnapshot(callback: (uri: string) => void): void {
    callback(this.canvas && 'toDataURL' in this.canvas ? this.canvas.toDataURL('image/png') : '')
  }

  async createThumbnail(_targetId?: string): Promise<Blob | Uint8Array> {
    const canvas = this.canvas
    if (!canvas) return new Uint8Array()
    if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' })
    return new Promise((resolve) => {
      ;(canvas as HTMLCanvasElement).toBlob((blob: Blob | null) => resolve(blob ?? new Uint8Array()), 'image/png')
    })
  }

  dispose(): void {
    this.clearCachedCostumes()
    if (this.gl) {
      if (this.glTexture) this.gl.deleteTexture(this.glTexture)
      if (this.glPositionBuffer) this.gl.deleteBuffer(this.glPositionBuffer)
      if (this.glTexcoordBuffer) this.gl.deleteBuffer(this.glTexcoordBuffer)
      if (this.glProgram) this.gl.deleteProgram(this.glProgram)
    }
    this.canvas = undefined
    this.context = undefined
    this.backCanvas = undefined
    this.backContext = undefined
    this.hitCanvas = undefined
    this.hitContext = undefined
    this.penCanvas = undefined
    this.penContext = undefined
    this.pendingPenLines = []
    this.pendingPenClear = false
    this.queuedDrawSnapshot = undefined
    this.queuedDirectPenLines = undefined
    this.drawScheduled = false
    this.gl = undefined
    this.glProgram = undefined
    this.glTexture = undefined
    this.glPositionBuffer = undefined
    this.glTexcoordBuffer = undefined
    this.lastSnapshot = undefined
  }

  private configureWebGL(canvas: ScratchCanvasHost): void {
    if (typeof document === 'undefined') return
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, preserveDrawingBuffer: true }) as WebGLRenderingContext | null
    if (!gl) return
    const program = createTextureProgram(gl)
    const texture = gl.createTexture()
    const positionBuffer = gl.createBuffer()
    const texcoordBuffer = gl.createBuffer()
    if (!program || !texture || !positionBuffer || !texcoordBuffer) return
    this.gl = gl
    this.glProgram = program
    this.glTexture = texture
    this.glPositionBuffer = positionBuffer
    this.glTexcoordBuffer = texcoordBuffer
    this.backCanvas = createCanvasHost(canvas.width, canvas.height)
    this.backCanvas.width = canvas.width
    this.backCanvas.height = canvas.height
    this.backContext = this.backCanvas.getContext('2d') ?? undefined

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, texcoordBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 1, 1, 0, 0, 0, 0, 1, 1, 1, 0]), gl.STATIC_DRAW)
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  private presentWebGL(): void {
    if (!this.gl || !this.glProgram || !this.glTexture || !this.glPositionBuffer || !this.glTexcoordBuffer || !this.backCanvas || !this.canvas) return
    const gl = this.gl
    gl.viewport(0, 0, this.canvas.width, this.canvas.height)
    gl.clearColor(this.backgroundColor[0], this.backgroundColor[1], this.backgroundColor[2], 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.useProgram(this.glProgram)
    const position = gl.getAttribLocation(this.glProgram, 'a_position')
    const texcoord = gl.getAttribLocation(this.glProgram, 'a_texcoord')
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glPositionBuffer)
    gl.enableVertexAttribArray(position)
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.glTexcoordBuffer)
    gl.enableVertexAttribArray(texcoord)
    gl.vertexAttribPointer(texcoord, 2, gl.FLOAT, false, 0, 0)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.glTexture)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.backCanvas)
    const sampler = gl.getUniformLocation(this.glProgram, 'u_texture')
    gl.uniform1i(sampler, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  }
}

export function normalizeProject(input: unknown): ScratchProject {
  if (!isObject(input)) return createDefaultProject()
  if (isSb2Project(input)) return normalizeProject(convertSb2Project(input))
  if (isSb2Sprite(input)) return normalizeProject(projectFromSpriteJson(convertSb2Target(input, false, 1)))
  const known = new Set(['targets', 'monitors', 'extensions', 'meta'])
  const extras = Object.fromEntries(Object.entries(input).filter(([key]) => !known.has(key)))
  const rawTargets = Array.isArray(input.targets) ? input.targets : []
  const targets = rawTargets.map((target, index) => normalizeTarget(target, index)).filter(Boolean) as ScratchTarget[]
  if (!targets.some((target) => target.isStage)) targets.unshift(createStageTarget())
  if (!targets.some((target) => !target.isStage)) targets.push(createSpriteTarget('Sprite1', targets.length))
  const meta: ScratchProject['meta'] = {
    semver: isObject(input.meta) && typeof input.meta.semver === 'string' ? input.meta.semver : '3.0.0',
    vm: 'hikkaku-clean-room',
    agent: typeof navigator === 'undefined' ? 'node' : navigator.userAgent,
  }
  if (isObject(input.meta) && typeof input.meta.origin === 'string') meta.origin = input.meta.origin
  return {
    ...structuredClone(extras),
    targets,
    monitors: normalizeMonitors(input.monitors),
    extensions: Array.isArray(input.extensions) ? input.extensions.map(String) : [],
    meta,
  }
}

export function validateProject(input: unknown, isSprite = false): ProjectValidationResult {
  const source = decodeValidationInput(input)
  const errors: string[] = []
  if (!isObject(source)) return { valid: false, format: 'unknown', errors: ['Input is not a project object'] }
  const format = inferProjectFormat(source)
  if (isSprite) {
    if (format !== 'sprite3' && format !== 'sprite2') errors.push('Expected sprite data')
  } else if (format !== 'sb3' && format !== 'sb2') {
    errors.push('Expected project data')
  }
  if (format === 'sb3') {
    const targets = Array.isArray(source.targets) ? source.targets : []
    if (!targets.length) errors.push('Project has no targets')
    if (!targets.some((target) => isObject(target) && target.isStage === true)) errors.push('Project has no stage target')
  }
  if (format === 'sprite3') {
    if (source.isStage === true) errors.push('Sprite data cannot be a stage')
    if (typeof source.name !== 'string') errors.push('Sprite has no name')
  }
  if (format === 'sb2' && !Array.isArray(source.children)) errors.push('Scratch 2 project has no children array')
  if (format === 'sprite2' && typeof source.objName !== 'string') errors.push('Scratch 2 sprite has no objName')
  if (format === 'unknown') errors.push('Unknown Scratch project format')
  return { valid: errors.length === 0, format, errors }
}

export function parseScratchJson(input: string): unknown {
  return JSON.parse(cleanJsonText(input))
}

export { ScratchVM as VirtualMachine }
export default ScratchVM

export function unpackScratchInput(input: string | Uint8Array | ArrayBuffer, isSprite = false): UnpackedScratchInput {
  if (typeof input === 'string') return { json: input, archive: null }
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (isScratch1Bytes(bytes)) throw new Error('Parser only supports Scratch 2.X and above')
  if (isZip(bytes)) {
    const archive = unzipSync(bytes)
    const jsonBytes = findArchiveJson(archive, isSprite ? 'sprite.json' : 'project.json')
    if (!jsonBytes) throw new Error(`Archive is missing ${isSprite ? 'sprite.json' : 'project.json'}`)
    return { json: strFromU8(jsonBytes), archive }
  }
  return { json: strFromU8(bytes), archive: null }
}

export function parseScratchProject(input: string | Uint8Array | ArrayBuffer | Record<string, unknown>, isSprite = false): ParsedScratchInput {
  const unpacked = isObject(input) ? { json: '', archive: null } : unpackScratchInput(input, isSprite)
  const project = isObject(input) ? input : parseScratchJson(unpacked.json)
  const validation = validateProject(project, isSprite)
  if (!validation.valid) throw makeParserValidationError(validation)
  const projectVersion: 2 | 3 = validation.format === 'sb2' || validation.format === 'sprite2' ? 2 : 3
  if (isObject(project)) project.projectVersion = projectVersion
  return { project: project as ParsedScratchInput['project'], archive: unpacked.archive, projectVersion, format: validation.format }
}

export function parse(input: string | Uint8Array | ArrayBuffer | Record<string, unknown>, isSpriteOrCallback?: boolean | ((error: unknown, output?: [unknown, Record<string, Uint8Array> | null]) => void), callback?: (error: unknown, output?: [unknown, Record<string, Uint8Array> | null]) => void): [unknown, Record<string, Uint8Array> | null] | undefined {
  const isSprite = typeof isSpriteOrCallback === 'boolean' ? isSpriteOrCallback : false
  const done = typeof isSpriteOrCallback === 'function' ? isSpriteOrCallback : callback
  try {
    const parsed = parseScratchProject(input, isSprite)
    const output: [unknown, Record<string, Uint8Array> | null] = [parsed.project, parsed.archive]
    done?.(null, output)
    return output
  } catch (error) {
    done?.(error)
    if (!done) throw error
    return undefined
  }
}

export function unpack(input: string | Uint8Array | ArrayBuffer, isSpriteOrCallback?: boolean | ((error: unknown, output?: [string, Record<string, Uint8Array> | null]) => void), callback?: (error: unknown, output?: [string, Record<string, Uint8Array> | null]) => void): [string, Record<string, Uint8Array> | null] | undefined {
  const isSprite = typeof isSpriteOrCallback === 'boolean' ? isSpriteOrCallback : false
  const done = typeof isSpriteOrCallback === 'function' ? isSpriteOrCallback : callback
  try {
    const result = unpackScratchInput(input, isSprite)
    const output: [string, Record<string, Uint8Array> | null] = [result.json, result.archive]
    done?.(null, output)
    return output
  } catch (error) {
    done?.(error)
    if (!done) throw error
    return undefined
  }
}

export function validate(isSprite: boolean, input: unknown, callback?: (error: unknown, output?: unknown) => void): ProjectValidationResult | undefined {
  const result = validateProject(input, isSprite)
  if (result.valid) {
    const source = decodeValidationInput(input)
    const projectVersion: 2 | 3 = result.format === 'sb2' || result.format === 'sprite2' ? 2 : 3
    if (isObject(source)) source.projectVersion = projectVersion
    callback?.(null, source)
    return result
  }
  const error = makeParserValidationError(result)
  callback?.(error)
  if (!callback) throw error
  return result
}

export const scratchParser = {
  parse,
  unpack,
  validate,
  parseScratchJson,
  parseScratchProject,
  unpackScratchInput,
}

export function extractFileName(nameExt: string): string {
  return String(nameExt).split('.', 1)[0] ?? ''
}

export function getProjectTitleFromFilename(fileInputFilename: string | null | undefined): string {
  if (!fileInputFilename) return ''
  const match = String(fileInputFilename).match(/^(.*)\.sb[23]?$/)
  return match ? match[1]!.substring(0, 100) : ''
}

export function createVMAsset(storage: Pick<ScratchStorage, 'createAsset'>, assetType: ScratchAssetType, dataFormat: DataFormat, data: AssetData): VMAssetUpload {
  const asset = storage.createAsset(assetType, dataFormat, data, undefined, true)
  const assetId = asset.assetId ?? bytesHash(assetDataBytes(data))
  asset.assetId = assetId
  return {
    name: null,
    dataFormat,
    asset,
    md5: `${assetId}.${dataFormat}`,
    assetId,
  }
}

export function handleFileUpload(fileInput: HTMLInputElement & { files: FileList | null }, onload: (data: ArrayBuffer | string | null, fileType: string, fileName: string, index: number, total: number) => void, onerror: (event: ProgressEvent<FileReader>) => void = () => {}): void {
  const files = Array.from(fileInput.files ?? [])
  const readFile = (index: number): void => {
    if (index >= files.length) {
      fileInput.value = ''
      return
    }
    const file = files[index]!
    const reader = new FileReader()
    reader.onload = () => {
      onload(reader.result, file.type, extractFileName(file.name), index, files.length)
      readFile(index + 1)
    }
    reader.onerror = onerror
    reader.readAsArrayBuffer(file)
  }
  readFile(0)
}

export function costumeUpload(fileData: ArrayBuffer | Uint8Array | string, fileType: string, storage: ScratchStorage, handleCostume: (costumes: VMAssetUpload[]) => void, handleError: (error: unknown) => void = () => {}): void {
  const normalizedType = normalizeMimeType(fileType)
  if (normalizedType === 'image/gif') {
    const costume = createVMAsset(storage, AssetType.ImageBitmap, DataFormat.PNG, assetUploadBytes(fileData))
    handleCostume([costume])
    return
  }
  if (normalizedType === 'image/bmp') {
    const costume = createVMAsset(storage, AssetType.ImageBitmap, DataFormat.PNG, assetUploadBytes(fileData))
    handleCostume([costume])
    return
  }
  const dataFormat = imageDataFormat(normalizedType)
  if (!dataFormat) {
    handleError(`Encountered unexpected file type: ${fileType}`)
    return
  }
  const assetType = dataFormat === DataFormat.SVG ? AssetType.ImageVector : AssetType.ImageBitmap
  const data = dataFormat === DataFormat.SVG ? sanitizeSvgByteStream(assetUploadBytes(fileData)) : assetUploadBytes(fileData)
  const costume = createVMAsset(storage, assetType, dataFormat, data)
  handleCostume([costume])
}

export function soundUpload(fileData: ArrayBuffer | Uint8Array | string, fileType: string, storage: ScratchStorage, handleSound: (sound: VMAssetUpload) => void, handleError: (error: unknown) => void = () => {}): void {
  const normalizedType = normalizeMimeType(fileType)
  const dataFormat = normalizedType === 'audio/mp3' || normalizedType === 'audio/mpeg' ? DataFormat.MP3 : normalizedType === 'audio/wav' || normalizedType === 'audio/wave' || normalizedType === 'audio/x-wav' || normalizedType === 'audio/x-pn-wav' ? DataFormat.WAV : undefined
  if (!dataFormat) {
    handleError(`Encountered unexpected file type: ${fileType}`)
    return
  }
  handleSound(createVMAsset(storage, AssetType.Sound, dataFormat, assetUploadBytes(fileData)))
}

export function spriteUpload(fileData: ArrayBuffer | Uint8Array | string, fileType: string, spriteName: string, storage: ScratchStorage, handleSprite: (sprite: Uint8Array | string) => void, handleError: (error: unknown) => void = () => {}): void {
  const normalizedType = normalizeMimeType(fileType)
  if (!normalizedType || normalizedType === 'application/x-scratch3-sprite' || normalizedType === 'application/zip') {
    handleSprite(assetUploadBytes(fileData))
    return
  }
  if (!imageDataFormat(normalizedType) && normalizedType !== 'image/bmp' && normalizedType !== 'image/gif') {
    handleError(`Encountered unexpected file type: ${fileType}`)
    return
  }
  costumeUpload(fileData, normalizedType, storage, (costumes) => {
    const namedCostumes = costumes.map((costume, index) => ({ ...costume, name: `${spriteName}${index ? index + 1 : ''}` }))
    const sprite = {
      name: spriteName,
      isStage: false,
      x: 0,
      y: 0,
      visible: true,
      size: 100,
      rotationStyle: 'all around',
      direction: 90,
      draggable: false,
      currentCostume: 0,
      blocks: {},
      variables: {},
      costumes: namedCostumes,
      sounds: [],
    }
    handleSprite(JSON.stringify(sprite))
  }, handleError)
}

function decodeValidationInput(input: unknown): unknown {
  try {
    if (typeof input === 'string') return JSON.parse(cleanJsonText(input))
    if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
      if (isZip(bytes)) {
        const files = unzipSync(bytes)
        const projectBytes = findArchiveJson(files, 'project.json')
        const spriteBytes = findArchiveJson(files, 'sprite.json')
        if (projectBytes) return JSON.parse(cleanJsonText(strFromU8(projectBytes)))
        if (spriteBytes) return JSON.parse(cleanJsonText(strFromU8(spriteBytes)))
      }
      return JSON.parse(cleanJsonText(strFromU8(bytes)))
    }
  } catch {
    return undefined
  }
  return input
}

function inferProjectFormat(input: Record<string, unknown>): ProjectValidationResult['format'] {
  if (Array.isArray(input.targets)) return 'sb3'
  if (input.isStage === false || (typeof input.name === 'string' && isObject(input.blocks))) return 'sprite3'
  if (isSb2Project(input)) return 'sb2'
  if (isSb2Sprite(input)) return 'sprite2'
  return 'unknown'
}

function cleanJsonText(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function escapeXmlText(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[char] ?? char)
}

function findArchiveJson(files: Record<string, Uint8Array>, name: 'project.json' | 'sprite.json'): Uint8Array | undefined {
  return files[name] ?? Object.entries(files).find(([path]) => fileBasename(path) === name)?.[1]
}

function fileBasename(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

function makeParserValidationError(result: ProjectValidationResult): ScratchParserValidationError {
  return {
    validationError: 'Could not parse as a valid SB2 or SB3 project.',
    sb2Errors: result.format === 'sb2' || result.format === 'sprite2' ? result.errors : [...result.errors],
    sb3Errors: result.format === 'sb3' || result.format === 'sprite3' ? result.errors : [...result.errors],
  }
}

function isScratch1Bytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x53 && bytes[1] === 0x63 && bytes[2] === 0x72
}

function normalizeMimeType(fileType: string): string {
  return fileType.trim().toLowerCase()
}

function imageDataFormat(fileType: string): DataFormat | undefined {
  if (fileType === 'image/svg+xml') return DataFormat.SVG
  if (fileType === 'image/png') return DataFormat.PNG
  if (fileType === 'image/jpeg' || fileType === 'image/jpg') return DataFormat.JPG
  return undefined
}

function assetUploadBytes(fileData: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (fileData instanceof Uint8Array) return new Uint8Array(fileData)
  if (fileData instanceof ArrayBuffer) return new Uint8Array(fileData)
  return strToU8(fileData)
}

function normalizeArchiveAssetBytes(name: string, data: Uint8Array): Uint8Array {
  return normalizeAssetBytes(new Uint8Array(data), extensionFromMd5ext(name) ?? '')
}

function projectFromSpriteJson(sprite: unknown): ScratchProject {
  return {
    targets: [createStageTarget(), normalizeTarget(sprite, 1) ?? createSpriteTarget('Sprite1', 1)],
    monitors: [],
    extensions: [],
    meta: {
      semver: '3.0.0',
      vm: 'hikkaku-clean-room',
      agent: typeof navigator === 'undefined' ? 'node' : navigator.userAgent,
    },
  }
}

function isSb2Project(input: Record<string, unknown>): boolean {
  return typeof input.objName === 'string' && Array.isArray(input.children)
}

function isSb2Sprite(input: Record<string, unknown>): boolean {
  return typeof input.objName === 'string' && !Array.isArray(input.targets) && !('isStage' in input)
}

function convertSb2Project(input: Record<string, unknown>): ScratchProject {
  const children = Array.isArray(input.children) ? input.children : []
  const sprites = children.filter((child) => isObject(child) && typeof child.objName === 'string').map((child, index) => convertSb2Target(child as Record<string, unknown>, false, index + 1))
  const stage = convertSb2Target(input, true, 0)
  return {
    targets: [stage, ...sprites],
    monitors: [],
    extensions: [],
    meta: {
      semver: '3.0.0',
      vm: 'hikkaku-clean-room',
      agent: typeof navigator === 'undefined' ? 'node' : navigator.userAgent,
    },
  }
}

function convertSb2Target(input: Record<string, unknown>, isStage: boolean, index: number): ScratchTarget {
  const target = isStage ? createStageTarget() : createSpriteTarget(String(input.objName ?? `Sprite${index}`), index)
  target.id = isStage ? 'stage' : `sprite${index}`
  target.name = String(input.objName ?? (isStage ? 'Stage' : `Sprite${index}`))
  target.variables = convertSb2Variables(input.variables)
  target.lists = convertSb2Lists(input.lists)
  target.blocks = convertSb2Scripts(input.scripts, target.variables)
  target.currentCostume = finiteNumberOr(input.currentCostumeIndex, 0)
  target.costumes = convertSb2Costumes(input.costumes, isStage)
  target.sounds = convertSb2Sounds(input.sounds)
  target.volume = bounded(finiteNumberOr(input.volume, 100), 0, 100)
  target.layerOrder = finiteNumberOr(input.indexInLibrary, index)
  if (isStage) {
    target.tempo = finiteNumberOr(input.tempoBPM, 60)
    target.videoTransparency = finiteNumberOr(input.videoAlpha, 50)
    target.videoState = input.info && isObject(input.info) && input.info.videoOn === false ? 'off' : 'on'
  } else {
    target.x = finiteNumberOr(input.scratchX, 0)
    target.y = finiteNumberOr(input.scratchY, 0)
    target.size = finiteNumberOr(input.scale, 1) * 100
    target.direction = normalizeDirection(finiteNumberOr(input.direction, 90))
    target.visible = input.visible !== false
    target.draggable = input.isDraggable === true
    target.rotationStyle = convertSb2RotationStyle(input.rotationStyle)
    clampSprite(target)
  }
  return target
}

function convertSb2Variables(input: unknown): Record<string, VariableRecord> {
  if (!Array.isArray(input)) return {}
  const output: Record<string, VariableRecord> = {}
  for (const variable of input) {
    if (!isObject(variable)) continue
    const name = String(variable.name ?? variable.varName ?? '')
    if (!name) continue
    output[name] = [name, toScratchValue(variable.value), variable.isPersistent === true]
  }
  return output
}

function convertSb2Lists(input: unknown): Record<string, ListRecord> {
  if (!Array.isArray(input)) return {}
  const output: Record<string, ListRecord> = {}
  for (const list of input) {
    if (!isObject(list)) continue
    const name = String(list.listName ?? list.name ?? '')
    if (!name) continue
    output[name] = [name, Array.isArray(list.contents) ? list.contents.map(toScratchValue) : []]
  }
  return output
}

function convertSb2Costumes(input: unknown, isStage: boolean): ScratchCostume[] {
  if (!Array.isArray(input) || input.length === 0) return [isStage ? stageCostume : spriteCostume]
  return input.flatMap((costume, index) => {
    if (!isObject(costume)) return []
    const md5ext = typeof costume.baseLayerMD5 === 'string' ? costume.baseLayerMD5 : typeof costume.md5 === 'string' ? costume.md5 : undefined
    const dataFormat = extensionFromMd5ext(md5ext) ?? (costume.bitmapResolution ? 'png' : 'svg')
    return [{
      assetId: stripExtension(md5ext),
      md5ext,
      dataFormat,
      name: String(costume.costumeName ?? costume.name ?? (isStage ? `backdrop${index + 1}` : `costume${index + 1}`)),
      bitmapResolution: Math.max(1, finiteNumberOr(costume.bitmapResolution, 1)),
      rotationCenterX: finiteNumberOr(costume.rotationCenterX, 0),
      rotationCenterY: finiteNumberOr(costume.rotationCenterY, 0),
    }]
  })
}

function convertSb2Sounds(input: unknown): ScratchSound[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((sound, index) => {
    if (!isObject(sound)) return []
    const md5ext = typeof sound.md5 === 'string' ? sound.md5 : undefined
    const dataFormat = extensionFromMd5ext(md5ext) ?? String(sound.format ?? 'wav')
    return [{
      assetId: stripExtension(md5ext),
      md5ext,
      dataFormat,
      format: typeof sound.format === 'string' ? sound.format : undefined,
      rate: Number(sound.rate) || undefined,
      sampleCount: Number(sound.sampleCount) || undefined,
      name: String(sound.soundName ?? sound.name ?? `sound${index + 1}`),
    }]
  })
}

function convertSb2RotationStyle(value: unknown): RotationStyle {
  if (value === 'none' || value === 0) return "don't rotate"
  if (value === 'leftRight' || value === 'left-right' || value === 1) return 'left-right'
  return 'all around'
}

function convertSb2Scripts(input: unknown, variables: Record<string, VariableRecord>): Record<string, ScratchBlock> {
  if (!Array.isArray(input)) return {}
  const blocks: Record<string, ScratchBlock> = {}
  let scriptIndex = 0
  for (const script of input) {
    if (!Array.isArray(script) || !Array.isArray(script[2])) continue
    const converted = convertSb2BlockStack(script[2], `sb2_${scriptIndex}`, Number(script[0]) || 0, Number(script[1]) || 0, variables)
    Object.assign(blocks, converted)
    scriptIndex += 1
  }
  return blocks
}

function convertSb2BlockStack(stack: unknown[], prefix: string, x: number, y: number, variables: Record<string, VariableRecord>): Record<string, ScratchBlock> {
  const blocks: Record<string, ScratchBlock> = {}
  let previousId: string | null = null
  stack.forEach((rawBlock, index) => {
    if (!Array.isArray(rawBlock)) return
    const id = `${prefix}_${index}`
    const block = convertSb2Block(rawBlock, id, variables)
    block.parent = previousId
    block.topLevel = index === 0
    if (index === 0) {
      block.x = x
      block.y = y
    }
    if (previousId) blocks[previousId]!.next = id
    blocks[id] = block
    previousId = id
  })
  return blocks
}

function convertSb2Block(rawBlock: unknown[], id: string, variables: Record<string, VariableRecord>): ScratchBlock {
  const spec = String(rawBlock[0] ?? '')
  const block: ScratchBlock = { opcode: sb2Opcode(spec), next: null, parent: null, inputs: {}, fields: {} }
  const args = rawBlock.slice(1)
  switch (spec) {
    case 'whenGreenFlag':
      block.opcode = 'event_whenflagclicked'
      break
    case 'whenIReceive':
      block.opcode = 'event_whenbroadcastreceived'
      block.fields = { BROADCAST_OPTION: [String(args[0] ?? ''), String(args[0] ?? '')] }
      break
    case 'broadcast:':
      block.opcode = 'event_broadcast'
      block.inputs = { BROADCAST_INPUT: [1, [10, String(args[0] ?? '')]] }
      break
    case 'forward:':
      block.inputs = { STEPS: [1, toScratchValue(args[0])] }
      break
    case 'turnRight:':
    case 'turnLeft:':
      block.inputs = { DEGREES: [1, toScratchValue(args[0])] }
      break
    case 'gotoX:y:':
      block.inputs = { X: [1, toScratchValue(args[0])], Y: [1, toScratchValue(args[1])] }
      break
    case 'changeXposBy:':
    case 'changeYposBy:':
      block.inputs = { DX: [1, toScratchValue(args[0])], DY: [1, toScratchValue(args[0])] }
      break
    case 'setXpos:':
      block.inputs = { X: [1, toScratchValue(args[0])] }
      break
    case 'setYpos:':
      block.inputs = { Y: [1, toScratchValue(args[0])] }
      break
    case 'say:':
      block.inputs = { MESSAGE: [1, toScratchValue(args[0])] }
      break
    case 'think:':
      block.inputs = { MESSAGE: [1, toScratchValue(args[0])] }
      break
    case 'wait:elapsed:from:':
      block.inputs = { DURATION: [1, toScratchValue(args[0])] }
      break
    case 'setVar:to:':
    case 'changeVar:by:': {
      const variableName = String(args[0] ?? '')
      if (variableName && !variables[variableName]) variables[variableName] = [variableName, 0]
      block.fields = { VARIABLE: [variableName, variableName] }
      block.inputs = { VALUE: [1, toScratchValue(args[1])], NUM: [1, toScratchValue(args[1])] }
      break
    }
  }
  block.id = id
  return block
}

function sb2Opcode(spec: string): string {
  const map: Record<string, string> = {
    whenGreenFlag: 'event_whenflagclicked',
    whenIReceive: 'event_whenbroadcastreceived',
    'broadcast:': 'event_broadcast',
    'forward:': 'motion_movesteps',
    'turnRight:': 'motion_turnright',
    'turnLeft:': 'motion_turnleft',
    'gotoX:y:': 'motion_gotoxy',
    'changeXposBy:': 'motion_changexby',
    'changeYposBy:': 'motion_changeyby',
    'setXpos:': 'motion_setx',
    'setYpos:': 'motion_sety',
    'say:': 'looks_say',
    'think:': 'looks_think',
    'wait:elapsed:from:': 'control_wait',
    'setVar:to:': 'data_setvariableto',
    'changeVar:by:': 'data_changevariableby',
  }
  return map[spec] ?? `sb2_${spec.replace(/[^a-z0-9_]+/gi, '_') || 'unknown'}`
}

function normalizeTarget(input: unknown, index: number): ScratchTarget | null {
  if (!isObject(input)) return null
  const isStage = input.isStage === true
  const target: ScratchTarget = {
    id: typeof input.id === 'string' ? input.id : isStage ? 'stage' : `sprite${index}`,
    isStage,
    name: typeof input.name === 'string' ? input.name : isStage ? 'Stage' : `Sprite${index}`,
    variables: normalizeVariables(input.variables),
    lists: normalizeLists(input.lists),
    broadcasts: normalizeStringRecord(input.broadcasts),
    blocks: normalizeBlocks(input.blocks),
    comments: isObject(input.comments) ? structuredClone(input.comments) : {},
    currentCostume: finiteNumberOr(input.currentCostume, 0),
    costumes: normalizeCostumes(input.costumes, isStage),
    sounds: normalizeSounds(input.sounds),
    volume: bounded(finiteNumberOr(input.volume, 100), 0, 100),
    soundEffects: normalizeNumberRecord(input.soundEffects),
    layerOrder: finiteNumberOr(input.layerOrder, index),
  }
  if (isStage) {
    target.tempo = finiteNumberOr(input.tempo, 60)
    target.videoTransparency = finiteNumberOr(input.videoTransparency, 50)
    target.videoState = typeof input.videoState === 'string' ? input.videoState : 'on'
    target.textToSpeechLanguage = typeof input.textToSpeechLanguage === 'string' ? input.textToSpeechLanguage : null
  } else {
    target.visible = input.visible !== false
    target.drawableId = optionalNumber(input.drawableId)
    target.x = finiteNumberOr(input.x, 0)
    target.y = finiteNumberOr(input.y, 0)
    target.size = finiteNumberOr(input.size, 100)
    target.direction = normalizeDirection(finiteNumberOr(input.direction, 90))
    target.draggable = input.draggable === true
    target.rotationStyle = isRotationStyle(input.rotationStyle) ? input.rotationStyle : 'all around'
    target.effects = normalizeNumberRecord(input.effects)
    target.pen = normalizePen(input.pen)
    target.penLines = normalizePenLines(input.penLines)
    target.isClone = input.isClone === true
    target.cloneOf = typeof input.cloneOf === 'string' ? input.cloneOf : undefined
    clampSprite(target)
  }
  return target
}

function cloneRuntimeTarget(source: ScratchTarget): ScratchTarget {
  return {
    ...source,
    variables: structuredClone(source.variables),
    lists: structuredClone(source.lists),
    broadcasts: structuredClone(source.broadcasts),
    blocks: source.blocks,
    comments: source.comments,
    costumes: source.costumes,
    sounds: source.sounds,
    effects: source.effects ? { ...source.effects } : undefined,
    soundEffects: source.soundEffects ? { ...source.soundEffects } : undefined,
    pen: source.pen ? { ...source.pen } : undefined,
    penLines: source.penLines ? source.penLines.map((line) => ({ ...line })) : undefined,
    speechBubble: source.speechBubble ? { ...source.speechBubble } : undefined,
  }
}

function isRuntimeSnapshot(value: unknown): value is RuntimeSnapshot {
  return isObject(value) && isObject(value.project) && Array.isArray(value.threads) && typeof value.running === 'boolean'
}

function isMotionOpcode(opcode: string): boolean {
  return opcode.startsWith('motion_')
    || opcode === 'forward:'
    || opcode === 'gotoX:y:'
    || opcode === 'changeXposBy:'
    || opcode === 'changeYposBy:'
    || opcode === 'setXpos:'
    || opcode === 'setYpos:'
}

function createStageTarget(): ScratchTarget {
  return {
    id: 'stage',
    isStage: true,
    name: 'Stage',
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [stageCostume],
    sounds: [],
    volume: 100,
    soundEffects: {},
    layerOrder: 0,
    tempo: 60,
    videoTransparency: 50,
    videoState: 'on',
    textToSpeechLanguage: null,
  }
}

function createSpriteTarget(name: string, layerOrder: number): ScratchTarget {
  return {
    id: layerOrder === 1 ? 'sprite1' : `sprite${layerOrder}`,
    isStage: false,
    name,
    variables: {},
    lists: {},
    broadcasts: {},
    blocks: {},
    comments: {},
    currentCostume: 0,
    costumes: [{ ...spriteCostume }],
    sounds: [],
    volume: 100,
    soundEffects: {},
    layerOrder,
    visible: true,
    x: 0,
    y: 0,
    size: 100,
    direction: 90,
    draggable: false,
    rotationStyle: 'all around',
    effects: {},
    penLines: [],
  }
}

function normalizeVariables(input: unknown): Record<string, VariableRecord> {
  if (!isObject(input)) return {}
  const output: Record<string, VariableRecord> = {}
  for (const [id, value] of Object.entries(input)) {
    if (Array.isArray(value)) output[id] = [String(value[0] ?? id), toScratchValue(value[1]), value[2] === true]
  }
  return output
}

function normalizeLists(input: unknown): Record<string, ListRecord> {
  if (!isObject(input)) return {}
  const output: Record<string, ListRecord> = {}
  for (const [id, value] of Object.entries(input)) {
    if (Array.isArray(value)) output[id] = [String(value[0] ?? id), Array.isArray(value[1]) ? value[1].map(toScratchValue) : []]
  }
  return output
}

function normalizeStringRecord(input: unknown): Record<string, string> {
  if (!isObject(input)) return {}
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, String(value)]))
}

function normalizeNumberRecord(input: unknown): Record<string, number> {
  if (!isObject(input)) return {}
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, finiteNumberOr(value, 0)]))
}

function normalizePen(input: unknown): ScratchTarget['pen'] {
  if (!isObject(input)) return undefined
  return {
    down: input.down === true,
    size: bounded(finiteNumberOr(input.size, 1), 1, 1200),
    color: typeof input.color === 'string' ? input.color : '#000000',
    brightness: bounded(finiteNumberOr(input.brightness, 50), 0, 100),
    saturation: bounded(finiteNumberOr(input.saturation, 100), 0, 100),
    transparency: bounded(finiteNumberOr(input.transparency, 0), 0, 100),
  }
}

function normalizePenLines(input: unknown): NonNullable<ScratchTarget['penLines']> {
  if (!Array.isArray(input)) return []
  return input.flatMap((line) => {
    if (!isObject(line)) return []
    return [{
      x1: finiteNumberOr(line.x1, 0),
      y1: finiteNumberOr(line.y1, 0),
      x2: finiteNumberOr(line.x2, 0),
      y2: finiteNumberOr(line.y2, 0),
      color: typeof line.color === 'string' ? line.color : '#000000',
      size: Math.max(1, finiteNumberOr(line.size, 1)),
      transparency: bounded(finiteNumberOr(line.transparency, 0), 0, 100),
    }]
  })
}

function normalizeMonitors(input: unknown): ScratchMonitor[] {
  if (!Array.isArray(input)) return []
  return input.flatMap((item, index) => {
    if (!isObject(item)) return []
    return [
      {
        id: typeof item.id === 'string' ? item.id : `monitor${index}`,
        mode: typeof item.mode === 'string' ? item.mode : 'default',
        opcode: typeof item.opcode === 'string' ? item.opcode : '',
        params: isObject(item.params)
          ? Object.fromEntries(Object.entries(item.params).map(([key, value]) => [key, toScratchValue(value)]))
          : {},
        spriteName: typeof item.spriteName === 'string' ? item.spriteName : undefined,
        value: Array.isArray(item.value) ? item.value.map(toScratchValue) : item.value === undefined ? undefined : toScratchValue(item.value),
        width: optionalNumber(item.width),
        height: optionalNumber(item.height),
        x: optionalNumber(item.x),
        y: optionalNumber(item.y),
        visible: item.visible === true,
        sliderMin: optionalNumber(item.sliderMin),
        sliderMax: optionalNumber(item.sliderMax),
        isDiscrete: item.isDiscrete === true,
      },
    ]
  })
}

function monitorPatch(input: Partial<ScratchMonitor> | ScratchMonitor | Map<string, unknown>): Partial<ScratchMonitor> {
  if (input instanceof Map) return Object.fromEntries(input.entries()) as Partial<ScratchMonitor>
  return structuredClone(input)
}

function monitorIdTail(id: string): string | undefined {
  if (!id.includes(':')) return undefined
  return id.slice(id.lastIndexOf(':') + 1)
}

const globalMonitorOpcodes = new Set([
  'looks_backdropnumbername',
  'sensing_answer',
  'sensing_mousedown',
  'sensing_mousex',
  'sensing_mousey',
  'sensing_loudness',
  'sensing_loud',
  'sensing_timer',
  'sensing_current',
  'sensing_dayssince2000',
  'sensing_online',
  'sensing_username',
  'control_get_counter',
  'music_getTempo',
  'translate_getViewerLanguage',
  'speech2text_getSpeech',
  'getTempo',
  'getViewerLanguage',
  'getSpeech',
])

function isSpriteSpecificMonitor(opcode: string): boolean {
  return !globalMonitorOpcodes.has(opcode)
}

function monitorIdForOpcode(target: ScratchTarget, opcode: string, params: Record<string, ScratchValue>): string {
  const fieldId = getMonitorIdForBlockWithArgs(opcode, Object.fromEntries(Object.entries(params).map(([key, value]) => [key, { value }])))
  return isSpriteSpecificMonitor(opcode) && !target.isStage ? `${target.id ?? target.name}:${fieldId}` : fieldId
}

function monitorParamsToFields(params: Record<string, ScratchValue>): NonNullable<ScratchBlock['fields']> {
  return Object.fromEntries(Object.entries(params).map(([key, value]) => [key, [String(value), undefined] as [string, string | undefined]]))
}

function normalizeMonitorPatch(existing: ScratchMonitor | undefined, patch: Partial<ScratchMonitor>): ScratchMonitor {
  return {
    id: String(patch.id ?? existing?.id ?? makeId('monitor')),
    mode: String(patch.mode ?? existing?.mode ?? 'default'),
    opcode: String(patch.opcode ?? existing?.opcode ?? ''),
    params: isObject(patch.params) ? Object.fromEntries(Object.entries(patch.params).map(([key, value]) => [key, toScratchValue(value)])) : existing?.params ?? {},
    spriteName: patch.spriteName === undefined ? existing?.spriteName : patch.spriteName,
    value: patch.value === undefined ? existing?.value : Array.isArray(patch.value) ? patch.value.map(toScratchValue) : toScratchValue(patch.value),
    width: optionalNumber(patch.width ?? existing?.width),
    height: optionalNumber(patch.height ?? existing?.height),
    x: optionalNumber(patch.x ?? existing?.x),
    y: optionalNumber(patch.y ?? existing?.y),
    visible: patch.visible === undefined ? existing?.visible ?? true : patch.visible === true,
    sliderMin: optionalNumber(patch.sliderMin ?? existing?.sliderMin),
    sliderMax: optionalNumber(patch.sliderMax ?? existing?.sliderMax),
    isDiscrete: patch.isDiscrete === undefined ? existing?.isDiscrete : patch.isDiscrete === true,
  }
}

function normalizeBlocks(input: unknown): Record<string, ScratchBlock> {
  if (!isObject(input)) return {}
  const output: Record<string, ScratchBlock> = {}
  for (const [id, block] of Object.entries(input)) {
    if (!isObject(block) || typeof block.opcode !== 'string') continue
    const known = new Set(['opcode', 'next', 'parent', 'inputs', 'fields', 'shadow', 'topLevel', 'x', 'y', 'mutation'])
    const extras = Object.fromEntries(Object.entries(block).filter(([key]) => !known.has(key)))
    const fields = normalizeBlockFields(block.opcode, normalizeFields(block.fields))
    output[id] = {
      ...structuredClone(extras),
      opcode: block.opcode,
      next: typeof block.next === 'string' ? block.next : null,
      parent: typeof block.parent === 'string' ? block.parent : null,
      inputs: normalizeBlockInputs(block.opcode, normalizeInputs(block.inputs)),
      fields,
      mutation: isObject(block.mutation) ? structuredClone(block.mutation) : undefined,
      shadow: block.shadow === true,
      topLevel: block.topLevel === true,
      x: typeof block.x === 'number' ? block.x : undefined,
      y: typeof block.y === 'number' ? block.y : undefined,
    }
    setBlockRuntimeId(output[id]!, id)
  }
  hydrateMenuFields(output)
  return output
}

function hydrateMenuFields(blocks: Record<string, ScratchBlock>): void {
  const menuFields: Record<string, string> = {
    motion_goto_menu: 'TO',
    motion_glideto_menu: 'TO',
    motion_pointtowards_menu: 'TOWARDS',
    event_broadcast_menu: 'BROADCAST_OPTION',
    sensing_touchingobjectmenu: 'TOUCHINGOBJECTMENU',
    sensing_distancetomenu: 'DISTANCETOMENU',
    sensing_keyoptions: 'KEY_OPTION',
    control_create_clone_of_menu: 'CLONE_OPTION',
  }
  for (const block of Object.values(blocks)) {
    for (const [inputName, input] of Object.entries(block.inputs ?? {})) {
      if (inputName === 'BROADCAST_INPUT') continue
      const childId = typeof input[1] === 'string' ? input[1] : undefined
      const child = childId ? blocks[childId] : undefined
      const fieldName = child ? menuFields[child.opcode] : undefined
      const field = fieldName ? child?.fields?.[fieldName] : undefined
      const literalValue = Array.isArray(input[1]) ? input[1][1] : undefined
      const value = field?.[0] ?? (literalValue === undefined ? undefined : String(literalValue))
      if (!value) continue
      const targetFieldName = fieldName ?? menuInputFieldName(inputName)
      if (!targetFieldName) continue
      block.fields ??= {}
      block.fields[targetFieldName] = [value, field?.[1] ?? value]
    }
  }
}

function menuInputFieldName(inputName: string): string | undefined {
  return ['TO', 'TOWARDS', 'DISTANCETOMENU', 'TOUCHINGOBJECTMENU', 'CLONE_OPTION'].includes(inputName) ? inputName : undefined
}

function cloneSharedBlocks(blocks: Record<string, ScratchBlock>, existingBlocks: Record<string, ScratchBlock>): Record<string, ScratchBlock> {
  const idMap = new Map<string, string>()
  const used = new Set([...Object.keys(existingBlocks), ...Object.keys(blocks)])
  for (const id of Object.keys(blocks)) {
    let next = uid()
    while (used.has(next)) next = uid()
    used.add(next)
    idMap.set(id, next)
  }
  const output: Record<string, ScratchBlock> = {}
  for (const [oldId, block] of Object.entries(blocks)) {
    const newId = idMap.get(oldId)
    if (!newId) continue
    const cloned = remapBlockReferences(structuredClone(block), idMap)
    if (cloned.topLevel) {
      cloned.x = typeof cloned.x === 'number' ? cloned.x + 24 : 24
      cloned.y = typeof cloned.y === 'number' ? cloned.y + 24 : 24
    }
    setBlockRuntimeId(cloned, newId)
    output[newId] = cloned
  }
  return output
}

function remapBlockReferences(block: ScratchBlock, idMap: Map<string, string>): ScratchBlock {
  block.next = remapBlockId(block.next, idMap)
  block.parent = remapBlockId(block.parent, idMap)
  block.inputs = remapInputReferences(block.inputs, idMap)
  if (isObject(block.mutation)) block.mutation = remapUnknownReferences(block.mutation, idMap) as Record<string, unknown>
  return block
}

function setBlockRuntimeId(block: ScratchBlock, id: string): void {
  Object.defineProperty(block, 'id', { value: id, configurable: true, writable: true })
}

function remapInputReferences(inputs: Record<string, [number, unknown, unknown?]> | undefined, idMap: Map<string, string>): Record<string, [number, unknown, unknown?]> {
  const output: Record<string, [number, unknown, unknown?]> = {}
  for (const [name, input] of Object.entries(inputs ?? {})) {
    output[name] = input.map((value) => remapUnknownReferences(value, idMap)) as [number, unknown, unknown?]
  }
  return output
}

function replaceSpriteInputReference(input: [number, unknown, unknown?], previousName: string, nextName: string): void {
  for (let index = 1; index < input.length; index += 1) {
    const value = input[index]
    if (value === previousName) input[index] = nextName
    else if (Array.isArray(value) && value[1] === previousName) value[1] = nextName
  }
}

function removeBlocksWithFieldReference(target: ScratchTarget, fieldNames: string[], id: string, name: string): void {
  const removeIds = new Set<string>()
  for (const [blockId, block] of Object.entries(target.blocks)) {
    for (const fieldName of fieldNames) {
      const field = block.fields?.[fieldName]
      if (field && (field[1] === id || field[0] === name)) removeIds.add(blockId)
    }
  }
  if (removeIds.size === 0) return
  childBlockClosure(target.blocks, removeIds)
  for (const blockId of removeIds) delete target.blocks[blockId]
  for (const block of Object.values(target.blocks)) {
    if (block.next && removeIds.has(block.next)) block.next = null
    if (block.parent && removeIds.has(block.parent)) block.parent = null
    for (const input of Object.values(block.inputs ?? {})) {
      if (typeof input[1] === 'string' && removeIds.has(input[1])) input[1] = null
      if (typeof input[2] === 'string' && removeIds.has(input[2])) input[2] = null
    }
  }
}

function updateDataLiteralInputReferences(block: ScratchBlock, code: number, id: string, oldName: string, nextName: string): void {
  for (const input of Object.values(block.inputs ?? {})) {
    const value = input[1]
    if (!Array.isArray(value) || value[0] !== code) continue
    if (value[2] === id || value[1] === oldName) value[1] = nextName
  }
}

function removeDataLiteralInputReferences(target: ScratchTarget, code: number, id: string, name: string): void {
  for (const block of Object.values(target.blocks)) {
    for (const input of Object.values(block.inputs ?? {})) {
      const value = input[1]
      if (Array.isArray(value) && value[0] === code && (value[2] === id || value[1] === name)) input[1] = null
    }
  }
}

function childBlockClosure(blocks: Record<string, ScratchBlock>, removeIds: Set<string>): Set<string> {
  let changed = true
  while (changed) {
    changed = false
    for (const [blockId, block] of Object.entries(blocks)) {
      if (removeIds.has(blockId)) continue
      if (block.parent && removeIds.has(block.parent)) {
        removeIds.add(blockId)
        changed = true
      }
    }
  }
  return removeIds
}

function remapUnknownReferences(value: unknown, idMap: Map<string, string>): unknown {
  if (typeof value === 'string') return idMap.get(value) ?? value
  if (Array.isArray(value)) return value.map((item) => remapUnknownReferences(item, idMap))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remapUnknownReferences(item, idMap)]))
  return value
}

function remapBlockId(value: string | null | undefined, idMap: Map<string, string>): string | null {
  if (!value) return null
  return idMap.get(value) ?? value
}

function applyBlockChange(block: ScratchBlock, event: Record<string, unknown>): void {
  const element = String(event.element ?? '')
  const name = String(event.name ?? '')
  const value = event.newValue ?? event.value
  if (element === 'field' && name) {
    block.fields ??= {}
    const previous = block.fields[name]
    block.fields[name] = [String(value ?? ''), previous?.[1]]
  } else if (element === 'mutation' && isObject(value)) {
    block.mutation = structuredClone(value) as Record<string, unknown>
  } else if (name === 'next') {
    block.next = typeof value === 'string' ? value : null
  } else if (name === 'parent') {
    block.parent = typeof value === 'string' ? value : null
  } else if (name === 'enabled') {
    block.disabled = value === false
  } else if (name) {
    block[name] = structuredClone(value)
  }
}

function normalizeInputs(input: unknown): Record<string, [number, unknown, unknown?]> {
  if (!isObject(input)) return {}
  const output: Record<string, [number, unknown, unknown?]> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!Array.isArray(value)) continue
    const normalized: [number, unknown, unknown?] = [Number(value[0]) || 0, value[1]]
    if (value.length > 2) normalized[2] = value[2]
    output[name] = normalized
  }
  return output
}

function normalizeBlockInputs(opcode: string, inputs: Record<string, [number, unknown, unknown?]>): Record<string, [number, unknown, unknown?]> {
  if (opcode !== 'event_broadcast' && opcode !== 'event_broadcastandwait') return inputs
  const input = inputs.BROADCAST_INPUT
  if (!input || input[0] !== 1 || typeof input[1] !== 'string') return inputs
  inputs.BROADCAST_INPUT = input.length > 2 ? [input[0], [10, input[1]], input[2]] : [input[0], [10, input[1]]]
  return inputs
}

function normalizeFields(input: unknown): Record<string, [string, string?]> {
  if (!isObject(input)) return {}
  const output: Record<string, [string, string?]> = {}
  for (const [name, value] of Object.entries(input)) {
    if (!Array.isArray(value)) continue
    output[name] = [String(value[0] ?? ''), value[1] === undefined ? undefined : String(value[1])]
  }
  return output
}

function normalizeBlockFields(opcode: string, fields: Record<string, [string, string?]>): Record<string, [string, string?]> {
  if ((opcode === 'looks_changeeffectby' || opcode === 'looks_seteffectto') && fields.EFFECT) {
    const value = normalizeGraphicEffectName(fields.EFFECT[0])
    fields.EFFECT = [value, fields.EFFECT[1] ?? value]
  }
  if ((opcode === 'sound_changeeffectby' || opcode === 'sound_seteffectto' || opcode === 'sound_effects_menu') && fields.EFFECT) {
    const value = normalizeSoundEffectName(fields.EFFECT[0]).toUpperCase()
    fields.EFFECT = [value, fields.EFFECT[1] ?? value]
  }
  return fields
}

function normalizeCostumes(input: unknown, isStage: boolean): ScratchCostume[] {
  if (!Array.isArray(input) || input.length === 0) return [{ ...(isStage ? stageCostume : spriteCostume) }]
  return input.map((item, index) => normalizeCostume(isObject(item) ? item : {}, index, isStage))
}

function normalizeCostume(input: Partial<ScratchCostume> | Record<string, unknown>, index: number, isStage: boolean): ScratchCostume {
  return {
    assetId: typeof input.assetId === 'string' ? input.assetId : undefined,
    name: typeof input.name === 'string' && input.name ? input.name : isStage ? `backdrop${index + 1}` : `costume${index + 1}`,
    md5ext: typeof input.md5ext === 'string' ? input.md5ext : undefined,
    dataFormat: typeof input.dataFormat === 'string' ? input.dataFormat : 'svg',
    bitmapResolution: Math.max(1, finiteNumberOr(input.bitmapResolution, 1)),
    rotationCenterX: finiteNumberOr(input.rotationCenterX, 0),
    rotationCenterY: finiteNumberOr(input.rotationCenterY, 0),
  }
}

function normalizeSounds(input: unknown): ScratchSound[] {
  if (!Array.isArray(input)) return []
  return input.map((item, index) => normalizeSound(isObject(item) ? item : {}, index))
}

function normalizeSound(input: Partial<ScratchSound> | Record<string, unknown>, index: number): ScratchSound {
  return {
    assetId: typeof input.assetId === 'string' ? input.assetId : undefined,
    name: typeof input.name === 'string' && input.name ? input.name : `sound${index + 1}`,
    md5ext: typeof input.md5ext === 'string' ? input.md5ext : undefined,
    dataFormat: typeof input.dataFormat === 'string' ? input.dataFormat : 'wav',
    format: typeof input.format === 'string' ? input.format : undefined,
    rate: Number(input.rate) || undefined,
    sampleCount: Number(input.sampleCount) || undefined,
  }
}

function literalInput(value: unknown[], fallback: ScratchValue): ScratchValue {
  const literal = value[1]
  return toScratchValue(literal ?? fallback)
}

function toScratchValue(value: unknown): ScratchValue {
  if (typeof value === 'number' || typeof value === 'boolean') return value
  return String(value ?? '')
}

function moveSteps(target: ScratchTarget, steps: number): void {
  const radians = (((target.direction ?? 90) - 90) * Math.PI) / 180
  target.x = (target.x ?? 0) + Math.cos(radians) * steps
  target.y = (target.y ?? 0) - Math.sin(radians) * steps
  clampSprite(target)
}

function bounceIfOnEdge(target: ScratchTarget): void {
  const radius = hitRadius(target)
  const onHorizontal = Math.abs(target.x ?? 0) + radius >= 240
  const onVertical = Math.abs(target.y ?? 0) + radius >= 180
  if (!onHorizontal && !onVertical) return
  let direction = target.direction ?? 90
  if (onHorizontal) direction = -direction
  if (onVertical) direction = 180 - direction
  target.direction = normalizeDirection(direction)
  clampSprite(target)
}

function directionToPoint(target: ScratchTarget, x: number, y: number): number {
  const dx = x - (target.x ?? 0)
  const dy = y - (target.y ?? 0)
  return normalizeDirection(90 - (Math.atan2(dy, dx) * 180) / Math.PI)
}

function clampSprite(target: ScratchTarget): void {
  target.x = Cast.toNumber(target.x)
  target.y = Cast.toNumber(target.y)
  target.size = bounded(target.size === undefined ? 100 : Cast.toNumber(target.size), 5, 1000)
  target.direction = normalizeDirection(target.direction === undefined ? 90 : Cast.toNumber(target.direction))
}

function bounded(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function finiteNumberOr(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  const number = Cast.toNumber(value)
  const normalized = Number.isFinite(number) ? number : fallback
  return Math.max(0, normalized)
}

function durationMsFromSeconds(value: unknown, fallback = 0): number {
  return finiteNonNegative(value, fallback) * 1000
}

function durationMsFromMilliseconds(value: unknown, fallback = 0): number {
  return finiteNonNegative(value, fallback)
}

function applyScratchFetchMetadata(options?: RequestInit): RequestInit | undefined {
  if (![...fetchMetadata.keys()].length) return options
  const next: RequestInit = { ...(options ?? {}) }
  const headers = new Headers(fetchMetadata)
  if (options?.headers) {
    for (const [name, value] of new Headers(options.headers).entries()) headers.set(name, value)
  }
  next.headers = headers
  return next
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function moveLayer(project: ScratchProject, target: ScratchTarget, position: 'front' | 'back'): void {
  if (target.isStage) return
  target.layerOrder = position === 'front' ? Math.max(...project.targets.map((item) => item.layerOrder ?? 0)) + 1 : 1
  normalizeLayerOrder(project)
}

function moveLayerBy(project: ScratchProject, target: ScratchTarget, delta: number): void {
  if (target.isStage || delta === 0) return
  const sprites = project.targets.filter((item) => !item.isStage).sort((a, b) => (a.layerOrder ?? 0) - (b.layerOrder ?? 0))
  const current = sprites.indexOf(target)
  if (current < 0) return
  sprites.splice(current, 1)
  sprites.splice(bounded(current + delta, 0, sprites.length), 0, target)
  sprites.forEach((sprite, index) => {
    sprite.layerOrder = index + 1
  })
}

function normalizeLayerOrder(project: ScratchProject): void {
  const stage = project.targets.find((target) => target.isStage)
  if (stage) stage.layerOrder = 0
  project.targets
    .filter((target) => !target.isStage)
    .sort((a, b) => (a.layerOrder ?? 0) - (b.layerOrder ?? 0))
    .forEach((target, index) => {
      target.layerOrder = index + 1
    })
}

function normalizeDirection(value: number): number {
  let direction = value % 360
  if (direction > 180) direction -= 360
  if (direction <= -180) direction += 360
  return direction
}

function firstSubstack(block: ScratchBlock): string | null {
  return substack(block, 'SUBSTACK')
}

function isLoopOpcode(opcode: string | undefined): boolean {
  return opcode === 'control_forever'
    || opcode === 'control_repeat'
    || opcode === 'control_repeat_until'
    || opcode === 'control_while'
    || opcode === 'control_for_each'
}

function substack(block: ScratchBlock, name: string): string | null {
  const value = block.inputs?.[name]?.[1]
  return typeof value === 'string' ? value : null
}

function findBlockId(target: ScratchTarget, block: ScratchBlock): string {
  if (typeof block.id === 'string') return block.id
  return Object.entries(target.blocks).find(([, candidate]) => candidate === block)?.[0] ?? ''
}

interface ProcedureInfo {
  body: string | null
  warp: boolean
  argumentIds: string[]
  argumentNames: string[]
  argumentDefaults: ScratchValue[]
}

function procedureInfo(target: ScratchTarget, proccode: string): ProcedureInfo | null {
  if (!proccode) return null
  for (const block of Object.values(target.blocks)) {
    if (block.opcode !== 'procedures_definition') continue
    const prototypeId = block.inputs?.custom_block?.[1]
    const prototype = typeof prototypeId === 'string' ? target.blocks[prototypeId] : undefined
    if (prototype?.mutation?.proccode === proccode) {
      return {
        body: block.next ?? null,
        warp: prototype.mutation?.warp === true || prototype.mutation?.warp === 'true',
        argumentIds: parseStringArray(prototype.mutation?.argumentids),
        argumentNames: parseStringArray(prototype.mutation?.argumentnames),
        argumentDefaults: parseScratchValueArray(prototype.mutation?.argumentdefaults),
      }
    }
  }
  return null
}

function parseStringArray(value: unknown): string[] {
  const parsed = parseArray(value)
  return parsed.map((item) => String(item))
}

function parseScratchValueArray(value: unknown): ScratchValue[] {
  return parseArray(value).map(toScratchValue)
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function truthy(value: ScratchValue): boolean {
  return Cast.toBoolean(value)
}

function listIndex(list: ScratchValue[], value: ScratchValue): number {
  const text = String(value).toLowerCase()
  if (text === 'last') return list.length - 1
  if (text === 'random' || text === 'any') return list.length === 0 ? -1 : Math.floor(Math.random() * list.length)
  const index = Math.floor(Cast.toNumber(value)) - 1
  return index >= 0 && index < list.length ? index : -1
}

function insertIndex(list: ScratchValue[], value: ScratchValue): number {
  const text = String(value).toLowerCase()
  if (text === 'last') return list.length
  if (text === 'random' || text === 'any') return Math.floor(Math.random() * (list.length + 1))
  return bounded(Math.floor(Cast.toNumber(value)) - 1, 0, list.length)
}

function mouseCoordinate(data: unknown, axis: 'x' | 'y'): number {
  if (!isObject(data)) return 0
  const value = Number(data[axis])
  return Number.isFinite(value) ? value : 0
}

function normalizeMouseData(data: unknown): Record<string, unknown> & { x: number; y: number; isDown: boolean; down: boolean; wasDragged?: boolean } {
  const source = isObject(data) ? data : {}
  const width = Number(source.canvasWidth)
  const height = Number(source.canvasHeight)
  const rawX = Number(source.x)
  const rawY = Number(source.y)
  const hasCanvasSpace = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
  const scratchX = Number.isFinite(Number(source.scratchX))
    ? Number(source.scratchX)
    : hasCanvasSpace && Number.isFinite(rawX)
      ? (rawX / width) * ScratchVM.STAGE_WIDTH - ScratchVM.STAGE_WIDTH / 2
      : rawX
  const scratchY = Number.isFinite(Number(source.scratchY))
    ? Number(source.scratchY)
    : hasCanvasSpace && Number.isFinite(rawY)
      ? ScratchVM.STAGE_HEIGHT / 2 - (rawY / height) * ScratchVM.STAGE_HEIGHT
      : rawY
  const isDown = source.isDown === true || source.down === true || Number(source.buttons) > 0
  return {
    ...source,
    x: Number.isFinite(scratchX) ? Math.round(bounded(scratchX, -240, 240)) : 0,
    y: Number.isFinite(scratchY) ? Math.round(bounded(scratchY, -180, 180)) : 0,
    clientX: hasCanvasSpace && Number.isFinite(rawX) ? rawX : source.clientX,
    clientY: hasCanvasSpace && Number.isFinite(rawY) ? rawY : source.clientY,
    canvasWidth: hasCanvasSpace ? width : source.canvasWidth,
    canvasHeight: hasCanvasSpace ? height : source.canvasHeight,
    isDown,
    down: isDown,
  }
}

function mouseButtonDown(data: unknown): boolean {
  if (!isObject(data)) return false
  return data.down === true || data.isDown === true || Number(data.buttons) > 0
}

function pointInsideStage(x: number, y: number): boolean {
  return x > -240 && x < 240 && y > -180 && y < 180
}

function loudnessValue(data: unknown): number {
  if (!isObject(data)) return 0
  return Number(data.loudness ?? data.volume ?? 0) || 0
}

function onlineValue(data: unknown): boolean {
  if (!isObject(data)) return typeof navigator === 'undefined' ? true : navigator.onLine
  if (typeof data.online === 'boolean') return data.online
  if (typeof data.isOnline === 'boolean') return data.isOnline
  return true
}

function hitRadius(target: ScratchTarget): number {
  return Math.max(10, Math.min(48, (target.size ?? 100) * 0.18))
}

function targetBounds(target: ScratchTarget): ScratchBounds {
  const box = targetCostumeBox(target)
  const scale = (target.size ?? 100) / 100
  const left = box.left * scale
  const right = box.right * scale
  const top = box.top * scale
  const bottom = box.bottom * scale
  if (target.rotationStyle === "don't rotate" || target.rotationStyle === 'left-right') {
    return normalizeBounds({
      left: (target.x ?? 0) + left,
      right: (target.x ?? 0) + right,
      top: (target.y ?? 0) + top,
      bottom: (target.y ?? 0) + bottom,
    })
  }
  const radians = (((target.direction ?? 90) - 90) * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const corners = [
    rotatePoint(left, top, cos, sin),
    rotatePoint(right, top, cos, sin),
    rotatePoint(right, bottom, cos, sin),
    rotatePoint(left, bottom, cos, sin),
  ]
  return normalizeBounds({
    left: (target.x ?? 0) + Math.min(...corners.map((point) => point.x)),
    right: (target.x ?? 0) + Math.max(...corners.map((point) => point.x)),
    top: (target.y ?? 0) + Math.max(...corners.map((point) => point.y)),
    bottom: (target.y ?? 0) + Math.min(...corners.map((point) => point.y)),
  })
}

function targetCostumeBox(target: ScratchTarget): { left: number; right: number; top: number; bottom: number } {
  const costume = target.costumes[target.currentCostume ?? 0]
  const bitmapResolution = Math.max(1, Number(costume?.bitmapResolution) || 1)
  const centerX = finiteNumberOr(costume?.rotationCenterX, 48)
  const centerY = finiteNumberOr(costume?.rotationCenterY, 48)
  const width = finiteNumberOr((costume as ScratchCostume & { width?: number } | undefined)?.width, Math.max(96, centerX * 2))
  const height = finiteNumberOr((costume as ScratchCostume & { height?: number } | undefined)?.height, Math.max(96, centerY * 2))
  return {
    left: -centerX / bitmapResolution,
    right: (width - centerX) / bitmapResolution,
    top: centerY / bitmapResolution,
    bottom: -(height - centerY) / bitmapResolution,
  }
}

function rotatePoint(x: number, y: number, cos: number, sin: number): { x: number; y: number } {
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

function collisionSamplePoints(bounds: ScratchBounds): Array<{ x: number; y: number }> {
  const xSteps = Math.max(2, Math.min(8, Math.ceil(bounds.width / 24)))
  const ySteps = Math.max(2, Math.min(8, Math.ceil(bounds.height / 24)))
  const points: Array<{ x: number; y: number }> = [{ x: bounds.left + bounds.width / 2, y: bounds.bottom + bounds.height / 2 }]
  for (let xIndex = 0; xIndex <= xSteps; xIndex += 1) {
    const x = bounds.left + (bounds.width * xIndex) / xSteps
    for (let yIndex = 0; yIndex <= ySteps; yIndex += 1) {
      points.push({ x, y: bounds.bottom + (bounds.height * yIndex) / ySteps })
    }
  }
  return points
}

function denseCollisionSamplePoints(bounds: ScratchBounds): Array<{ x: number; y: number }> {
  const xSteps = Math.max(2, Math.min(48, Math.ceil(bounds.width / 4)))
  const ySteps = Math.max(2, Math.min(48, Math.ceil(bounds.height / 4)))
  const points: Array<{ x: number; y: number }> = [{ x: bounds.left + bounds.width / 2, y: bounds.bottom + bounds.height / 2 }]
  for (let xIndex = 0; xIndex <= xSteps; xIndex += 1) {
    const x = bounds.left + (bounds.width * xIndex) / xSteps
    for (let yIndex = 0; yIndex <= ySteps; yIndex += 1) {
      points.push({ x, y: bounds.bottom + (bounds.height * yIndex) / ySteps })
    }
  }
  return points
}

function normalizeBounds(bounds: { left: number; right: number; top: number; bottom: number }): ScratchBounds {
  const left = Math.min(bounds.left, bounds.right)
  const right = Math.max(bounds.left, bounds.right)
  const bottom = Math.min(bounds.bottom, bounds.top)
  const top = Math.max(bounds.bottom, bounds.top)
  return { left, right, top, bottom, width: right - left, height: top - bottom }
}

function boundsIntersect(a: ScratchBounds, b: ScratchBounds): boolean {
  return a.left <= b.right && a.right >= b.left && a.bottom <= b.top && a.top >= b.bottom
}

function boundsIntersection(a: ScratchBounds, b: ScratchBounds): ScratchBounds {
  return normalizeBounds({
    left: Math.max(a.left, b.left),
    right: Math.min(a.right, b.right),
    top: Math.min(a.top, b.top),
    bottom: Math.max(a.bottom, b.bottom),
  })
}

function pointInBounds(x: number, y: number, bounds: ScratchBounds): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.bottom && y <= bounds.top
}

function keyPressed(data: unknown, key: string): boolean {
  if (!isObject(data)) return false
  const normalized = normalizeKeyName(key)
  const pressed = data.isDown === true || data.down === true || data.pressed === true
  const currentKey = normalizeKeyName(data.key)
  if (normalized === 'any' && pressed && currentKey) return true
  if (currentKey === normalized && pressed) return true
  const keys = data.keys
  if (Array.isArray(keys)) {
    const normalizedKeys = keys.map((value) => normalizeKeyName(value))
    return normalized === 'any' ? normalizedKeys.length > 0 : normalizedKeys.includes(normalized)
  }
  if (isObject(keys)) {
    const entries = Object.entries(keys)
    return normalized === 'any'
      ? entries.some(([, value]) => value === true)
      : entries.some(([name, value]) => value === true && normalizeKeyName(name) === normalized)
  }
  return data[key] === true || data[normalized] === true
}

function normalizeKeyName(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase()
  const aliases: Record<string, string> = {
    arrowup: 'up arrow',
    up: 'up arrow',
    arrowdown: 'down arrow',
    down: 'down arrow',
    arrowleft: 'left arrow',
    left: 'left arrow',
    arrowright: 'right arrow',
    right: 'right arrow',
    ' ': 'space',
    spacebar: 'space',
    esc: 'escape',
  }
  return aliases[text] ?? text
}

function currentDatePart(part: string): number {
  const now = new Date()
  switch (part.toLowerCase()) {
    case 'year':
      return now.getFullYear()
    case 'month':
      return now.getMonth() + 1
    case 'date':
      return now.getDate()
    case 'dayofweek':
    case 'day of week':
      return now.getDay() + 1
    case 'hour':
      return now.getHours()
    case 'minute':
      return now.getMinutes()
    case 'second':
      return now.getSeconds()
    default:
      return 0
  }
}

function userName(data: unknown): string {
  if (!isObject(data)) return ''
  return String(data.username ?? data.name ?? '')
}

function viewerLanguage(data: unknown): string {
  if (!isObject(data)) return typeof navigator === 'undefined' ? 'en' : navigator.language.split('-')[0] ?? 'en'
  return String(data.language ?? data.locale ?? 'en').split('-')[0] ?? 'en'
}

function videoSensingValue(data: unknown, attribute: string): number {
  if (!isObject(data)) return 0
  const key = attribute.toLowerCase()
  const value = key.includes('direction') ? data.direction : key.includes('motion') ? data.motion : data[key]
  return Number(value) || 0
}

function ensurePen(target: ScratchTarget): NonNullable<ScratchTarget['pen']> {
  target.pen ??= { down: false, size: 1, color: '#000000', brightness: 50, saturation: 100, transparency: 0 }
  return target.pen
}

function targetProperty(target: ScratchTarget, property: string, stage: ScratchTarget): ScratchValue {
  switch (property.toLowerCase()) {
    case 'x position':
    case 'xposition':
      return target.x ?? 0
    case 'y position':
    case 'yposition':
      return target.y ?? 0
    case 'direction':
      return target.direction ?? 90
    case 'costume #':
    case 'costume number':
    case 'costumenumber':
      return target.currentCostume + 1
    case 'costume name':
    case 'costumename':
      return target.costumes[target.currentCostume]?.name ?? ''
    case 'backdrop #':
    case 'backdrop number':
    case 'backdropnumber':
      return stage.currentCostume + 1
    case 'backdrop name':
    case 'backdropname':
      return stage.costumes[stage.currentCostume]?.name ?? ''
    case 'size':
      return target.size ?? 100
    case 'volume':
      return target.volume ?? 100
    default:
      for (const variable of Object.values(target.variables)) {
        if (variable[0] === property) return variable[1]
      }
      return 0
  }
}

function parseColor(value: unknown): { r: number; g: number; b: number; a: number } | null {
  if (isObject(value)) {
    const r = Number(value.r)
    const g = Number(value.g)
    const b = Number(value.b)
    const a = Number(value.a ?? 255)
    return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : null
  }
  const hex = String(value ?? '').trim().replace(/^#/, '')
  if (!/^[\da-f]{6}$/i.test(hex)) return null
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
    a: 255,
  }
}

function colorsClose(a: { r: number; g: number; b: number; a: number }, b: { r: number; g: number; b: number; a: number }): boolean {
  return Math.abs(a.r - b.r) <= 8 && Math.abs(a.g - b.g) <= 8 && Math.abs(a.b - b.b) <= 8 && Math.abs((a.a ?? 255) - (b.a ?? 255)) <= 8
}

function callAudio(audio: unknown, method: string, ...args: unknown[]): unknown {
  if (!isObject(audio)) return undefined
  const fn = audio[method]
  return typeof fn === 'function' ? fn.apply(audio, args) : undefined
}

function resolveSound(target: ScratchTarget, nameOrId: string): ScratchSound | undefined {
  if (target.sounds.length === 0) return undefined
  const text = String(nameOrId ?? '')
  const direct = target.sounds.find((item) => item.name === text || item.assetId === text || item.md5ext === text)
  if (direct) return direct
  const numeric = Number(text)
  if (Number.isFinite(numeric) && text.trim() !== '') {
    const index = wrapIndex(Math.floor(numeric), target.sounds.length)
    return target.sounds[index]
  }
  return undefined
}

function resolveCostumeIndex(costumes: ScratchCostume[], nameOrIndex: ScratchValue, currentIndex: number): number {
  if (costumes.length === 0) return -1
  const text = String(nameOrIndex ?? '').trim()
  const lower = text.toLowerCase()
  if (lower === 'next backdrop' || lower === 'next costume' || lower === 'next') return (currentIndex + 1) % costumes.length
  if (lower === 'previous backdrop' || lower === 'previous costume' || lower === 'previous') return (currentIndex - 1 + costumes.length) % costumes.length
  if (lower === 'random backdrop' || lower === 'random costume' || lower === 'random') return Math.floor(Math.random() * costumes.length)
  const direct = costumes.findIndex((item) => item.name === text || item.assetId === text || item.md5ext === text)
  if (direct >= 0) return direct
  const numeric = Number(text)
  return Number.isFinite(numeric) && text !== '' ? wrapIndex(Math.floor(numeric), costumes.length) : -1
}

function wrapIndex(oneBasedIndex: number, length: number): number {
  if (length <= 0) return 0
  return ((oneBasedIndex - 1) % length + length) % length
}

function soundDurationMs(sound: ScratchSound): number {
  const samples = Number(sound.sampleCount ?? 0)
  const rate = Number(sound.rate ?? 44100)
  if (Number.isFinite(samples) && samples > 0 && Number.isFinite(rate) && rate > 0) {
    return Math.max(1, Math.ceil((samples / rate) * 1000))
  }
  return 1
}

function normalizeSoundEffectName(effect: string): string {
  const text = effect.toLowerCase().trim()
  if (text.includes('pan')) return 'pan'
  if (text.includes('pitch')) return 'pitch'
  return text || 'pitch'
}

function normalizeGraphicEffectName(effect: string): string {
  const text = effect.toLowerCase().trim().replace(/\s+/g, '')
  if (text.includes('fisheye')) return 'fisheye'
  if (text.includes('whirl')) return 'whirl'
  if (text.includes('pixelate')) return 'pixelate'
  if (text.includes('mosaic')) return 'mosaic'
  if (text.includes('brightness')) return 'brightness'
  if (text.includes('ghost')) return 'ghost'
  if (text.includes('color')) return 'color'
  return text || 'color'
}

function clampSoundEffect(effect: string, value: number): number {
  const finite = Number.isFinite(value) ? value : 0
  return effect === 'pan' ? bounded(finite, -100, 100) : bounded(finite, -360, 360)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === 'function'
}

function looksLikeSerializedSprite(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return trimmed.startsWith('{') || trimmed.startsWith('[')
}

function thenableTarget(target: ScratchTarget): ScratchTarget & PromiseLike<ScratchTarget> {
  const promise = Promise.resolve(structuredClone(target))
  Object.defineProperties(target, {
    then: { value: promise.then.bind(promise), enumerable: false },
    catch: { value: promise.catch.bind(promise), enumerable: false },
    finally: { value: promise.finally.bind(promise), enumerable: false },
  })
  return target as ScratchTarget & PromiseLike<ScratchTarget>
}

function callProvider(provider: unknown, method: string, ...args: unknown[]): unknown {
  if (!isObject(provider)) return undefined
  const fn = provider[method]
  return typeof fn === 'function' ? fn.apply(provider, args) : undefined
}

function randomBetween(fromValue: ScratchValue, toValue: ScratchValue): number {
  const from = Cast.toNumber(fromValue)
  const to = Cast.toNumber(toValue)
  const min = Math.min(from, to)
  const max = Math.max(from, to)
  const value = min + Math.random() * (max - min)
  return Cast.isInt(fromValue) && Cast.isInt(toValue) ? Math.round(value) : value
}

function scratchMod(dividendValue: ScratchValue, divisorValue: ScratchValue): number {
  const dividend = Cast.toNumber(dividendValue)
  const divisor = Cast.toNumber(divisorValue)
  if (divisor === 0) return NaN
  return dividend - Math.floor(dividend / divisor) * divisor
}

function mathOp(operator: string, value: number): number {
  switch (operator) {
    case 'abs':
      return Math.abs(value)
    case 'floor':
      return Math.floor(value)
    case 'ceiling':
      return Math.ceil(value)
    case 'sqrt':
      return Math.sqrt(value)
    case 'sin':
      return Math.sin((value * Math.PI) / 180)
    case 'cos':
      return Math.cos((value * Math.PI) / 180)
    case 'tan':
      return MathUtil.tan(value)
    case 'asin':
      return (Math.asin(value) * 180) / Math.PI
    case 'acos':
      return (Math.acos(value) * 180) / Math.PI
    case 'atan':
      return (Math.atan(value) * 180) / Math.PI
    case 'ln':
      return Math.log(value)
    case 'log':
      return Math.log10(value)
    case 'e ^':
      return Math.E ** value
    case '10 ^':
      return 10 ** value
    default:
      return value
  }
}

function createCanvasHost(width: number, height: number): ScratchCanvasHost {
  if (typeof OffscreenCanvas !== 'undefined' && typeof document === 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function scheduleRendererDraw(callback: () => void): void {
  const globalScope = globalThis as { window?: unknown; importScripts?: unknown }
  const inWorker = typeof self !== 'undefined' && typeof globalScope.window === 'undefined' && typeof globalScope.importScripts === 'function'
  if (!inWorker && typeof window === 'undefined') {
    callback()
    return
  }
  if (!inWorker && typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(callback)
    return
  }
  setTimeout(callback, 0)
}

function drawSnapshot(
  context: ScratchCanvas2DContext,
  width: number,
  height: number,
  snapshot: RuntimeSnapshot,
  selectedTargetId: string,
  resolveCostumeImage: CostumeImageResolver = () => undefined,
  penLayer?: CanvasImageSource,
  pendingPenLines?: PenLine[],
): void {
  context.imageSmoothingEnabled = false
  context.clearRect(0, 0, width, height)
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  const stage = snapshot.project.targets.find((target) => target.isStage)
  const backdrop = stage?.costumes[stage.currentCostume ?? 0]
  const backdropImage = resolveCostumeImage(backdrop, stage)
  if (backdropImage) {
    drawBackdropImage(context, backdropImage.image, backdropImage.costume, width, height)
  }
  if (!backdropImage) {
    context.strokeStyle = '#e2e8f0'
    context.lineWidth = 1
    for (let x = 0; x <= width; x += width / 16) {
      context.beginPath()
      context.moveTo(x, 0)
      context.lineTo(x, height)
      context.stroke()
    }
    for (let y = 0; y <= height; y += height / 12) {
      context.beginPath()
      context.moveTo(0, y)
      context.lineTo(width, y)
      context.stroke()
    }
    context.strokeStyle = '#cbd5e1'
    context.beginPath()
    context.moveTo(width / 2, 0)
    context.lineTo(width / 2, height)
    context.moveTo(0, height / 2)
    context.lineTo(width, height / 2)
    context.stroke()
  }

  if (penLayer) context.drawImage(penLayer, 0, 0, width, height)
  if (pendingPenLines?.length) drawGroupedPenLines(context, width, height, pendingPenLines)
  const sprites = snapshot.project.targets
    .filter((target) => !target.isStage)
    .sort((a, b) => (a.layerOrder ?? 0) - (b.layerOrder ?? 0))
  for (const sprite of sprites) drawPenLines(context, width, height, sprite)
  for (const sprite of sprites.filter((target) => target.visible !== false)) {
    const { point, radius } = drawSpriteOnly(context, width, height, sprite, resolveCostumeImage, selectedTargetId)
    if (sprite.speechBubble?.text) drawSpeechBubble(context, point.x + radius * 0.7, point.y - radius * 1.25, sprite.speechBubble)
  }
}

function drawSpriteOnly(
  context: ScratchCanvas2DContext,
  width: number,
  height: number,
  sprite: ScratchTarget,
  resolveCostumeImage: CostumeImageResolver,
  selectedTargetId = '',
): { point: { x: number; y: number }; radius: number } {
  const point = scratchToCanvasPoint(sprite.x ?? 0, sprite.y ?? 0, width, height)
  const radius = Math.max(10, Math.min(48, (sprite.size ?? 100) * 0.18))
  const selected = selectedTargetId === sprite.id || selectedTargetId === sprite.name
  const costume = sprite.costumes[sprite.currentCostume ?? 0]
  if (!selected && !targetMayTouchStage(sprite)) return { point, radius }
  if (!selected && costumeIsTransparentPlaceholder(costume)) return { point, radius }
  const costumeImage = resolveCostumeImage(costume, sprite)
  if (costumeImage && !selected && costumeImageIsTransparent(costumeImage.image)) return { point, radius }
  context.save()
  context.translate(point.x, point.y)
  applySpriteTransform(context, sprite)
  if (spriteHasGraphicEffects(sprite)) applySpriteEffects(context, sprite)
  if (costumeImage) drawCostumeImage(context, costumeImage.image, costumeImage.costume, sprite)
  else drawFallbackSprite(context, sprite, selected, radius)
  if (selected) drawSelectionHalo(context, costumeImage?.image, costumeImage?.costume, sprite, radius)
  context.restore()
  return { point, radius }
}

function drawBackdropImage(context: ScratchCanvas2DContext, image: ScratchCostumeImage, costume: ScratchCostume | undefined, width: number, height: number): void {
  const scaleX = width / 480
  const scaleY = height / 360
  const bitmapResolution = Math.max(1, Number(costume?.bitmapResolution) || 1)
  const centerX = Number(costume?.rotationCenterX)
  const centerY = Number(costume?.rotationCenterY)
  const raster = rasterizedCostumeImage(image, costume)
  const imageWidth = raster.width
  const imageHeight = raster.height
  const x = Number.isFinite(centerX) ? 240 - centerX / bitmapResolution : 240 - imageWidth / (2 * bitmapResolution)
  const y = Number.isFinite(centerY) ? 180 - centerY / bitmapResolution : 180 - imageHeight / (2 * bitmapResolution)
  context.save()
  context.scale(scaleX, scaleY)
  context.drawImage(raster.image, x, y, imageWidth / bitmapResolution, imageHeight / bitmapResolution)
  context.restore()
}

function drawCostumeImage(context: ScratchCanvas2DContext, image: ScratchCostumeImage, costume: ScratchCostume | undefined, sprite: ScratchTarget): void {
  context.save()
  const bitmapResolution = Math.max(1, Number(costume?.bitmapResolution) || 1)
  const scale = ((sprite.size ?? 100) / 100) / bitmapResolution
  context.scale(scale, scale)
  const centerX = Number(costume?.rotationCenterX)
  const centerY = Number(costume?.rotationCenterY)
  const raster = rasterizedCostumeImage(image, costume)
  const { width, height } = raster
  const x = Number.isFinite(centerX) ? -centerX : -width / 2
  const y = Number.isFinite(centerY) ? -centerY : -height / 2
  context.drawImage(raster.image, x, y, width, height)
  context.restore()
}

function drawFallbackSprite(context: ScratchCanvas2DContext, sprite: ScratchTarget, selected: boolean, radius: number): void {
  context.fillStyle = spriteFillColor(sprite, selected)
  context.strokeStyle = '#c2410c'
  context.lineWidth = selected ? 4 : 2
  context.beginPath()
  context.arc(0, 0, radius, 0, Math.PI * 2)
  context.fill()
  context.stroke()
  context.fillStyle = '#7c2d12'
  context.beginPath()
  context.moveTo(radius * 0.65, 0)
  context.lineTo(-radius * 0.35, -radius * 0.35)
  context.lineTo(-radius * 0.2, radius * 0.35)
  context.closePath()
  context.fill()
}

function drawSelectionHalo(context: ScratchCanvas2DContext, image: ScratchCostumeImage | undefined, costume: ScratchCostume | undefined, sprite: ScratchTarget, fallbackRadius: number): void {
  context.save()
  context.filter = 'none'
  context.globalAlpha = 1
  context.strokeStyle = '#4c97ff'
  context.lineWidth = 2
  context.setLineDash([5, 4])
  if (image) {
    const bitmapResolution = Math.max(1, Number(costume?.bitmapResolution) || 1)
    const scale = ((sprite.size ?? 100) / 100) / bitmapResolution
    const { width: imageWidth, height: imageHeight } = costumeImageSize(image, costume)
    const centerX = Number.isFinite(Number(costume?.rotationCenterX)) ? Number(costume?.rotationCenterX) : imageWidth / 2
    const centerY = Number.isFinite(Number(costume?.rotationCenterY)) ? Number(costume?.rotationCenterY) : imageHeight / 2
    context.strokeRect(-centerX * scale, -centerY * scale, imageWidth * scale, imageHeight * scale)
  } else {
    context.beginPath()
    context.arc(0, 0, fallbackRadius + 5, 0, Math.PI * 2)
    context.stroke()
  }
  context.restore()
}

function targetMayTouchStage(target: ScratchTarget): boolean {
  const bounds = targetBounds(target)
  return bounds.right >= -260 && bounds.left <= 260 && bounds.top >= -200 && bounds.bottom <= 200
}

function costumeImageWidth(image: ScratchCostumeImage): number {
  return 'naturalWidth' in image ? image.naturalWidth : image.width
}

function costumeImageHeight(image: ScratchCostumeImage): number {
  return 'naturalHeight' in image ? image.naturalHeight : image.height
}

function costumeIsTransparentPlaceholder(costume: ScratchCostume | undefined): boolean {
  if (!costume) return false
  const isSvg = costume.dataFormat === 'svg' || costume.md5ext?.endsWith('.svg') === true
  return isSvg
    && costume.name.trim().toLowerCase() === 'blank'
    && Number(costume.rotationCenterX) === 0
    && Number(costume.rotationCenterY) === 0
}

const transparentCostumeImages = new WeakMap<ScratchCostumeImage, boolean>()
const rasterizedCostumeImages = new WeakMap<ScratchCostumeImage, { image: ScratchCanvasHost; width: number; height: number }>()

function rasterizedCostumeImage(image: ScratchCostumeImage, costume: ScratchCostume | undefined): { image: CanvasImageSource; width: number; height: number } {
  const { width, height } = costumeImageSize(image, costume)
  const isSvg = costume?.dataFormat === 'svg' || costume?.md5ext?.endsWith('.svg') === true
  if (!isSvg || width <= 0 || height <= 0 || (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined')) return { image, width, height }
  const cached = rasterizedCostumeImages.get(image)
  if (cached && cached.width === width && cached.height === height) return cached
  try {
    const canvas = createCanvasHost(width, height)
    const context = canvas.getContext('2d')
    if (!context) return { image, width, height }
    context.clearRect(0, 0, width, height)
    context.drawImage(image, 0, 0, width, height)
    const raster = { image: canvas, width, height }
    rasterizedCostumeImages.set(image, raster)
    return raster
  } catch {
    return { image, width, height }
  }
}

function costumeImageIsTransparent(image: ScratchCostumeImage): boolean {
  const cached = transparentCostumeImages.get(image)
  if (cached !== undefined) return cached
  if (typeof document === 'undefined' && typeof OffscreenCanvas === 'undefined') {
    transparentCostumeImages.set(image, false)
    return false
  }
  try {
    const canvas = createCanvasHost(8, 8)
    const context = canvas.getContext('2d')
    if (!context) {
      transparentCostumeImages.set(image, false)
      return false
    }
    context.clearRect(0, 0, 8, 8)
    context.drawImage(image, 0, 0, 8, 8)
    const pixels = context.getImageData(0, 0, 8, 8).data
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i] !== 0) {
        transparentCostumeImages.set(image, false)
        return false
      }
    }
    transparentCostumeImages.set(image, true)
    return true
  } catch {
    transparentCostumeImages.set(image, false)
    return false
  }
}

function costumeImageSize(image: ScratchCostumeImage, costume: ScratchCostume | undefined): { width: number; height: number } {
  let width = costumeImageWidth(image)
  let height = costumeImageHeight(image)
  const centerX = Number(costume?.rotationCenterX)
  const centerY = Number(costume?.rotationCenterY)
  const isSvg = costume?.dataFormat === 'svg' || costume?.md5ext?.endsWith('.svg')
  if (isSvg && width === 300 && Number.isFinite(centerX) && centerX > 0) {
    if (Number.isFinite(centerX) && centerX > 0) width = centerX * 2
    if (Number.isFinite(centerY) && centerY > 0) height = centerY * 2
  }
  return { width, height }
}

function createTextureProgram(gl: WebGLRenderingContext): WebGLProgram | undefined {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec2 a_position;
    attribute vec2 a_texcoord;
    varying vec2 v_texcoord;
    void main() {
      gl_Position = vec4(a_position, 0.0, 1.0);
      v_texcoord = a_texcoord;
    }
  `)
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_texture;
    varying vec2 v_texcoord;
    void main() {
      gl_FragColor = texture2D(u_texture, v_texcoord);
    }
  `)
  if (!vertex || !fragment) return undefined
  const program = gl.createProgram()
  if (!program) return undefined
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  gl.deleteShader(vertex)
  gl.deleteShader(fragment)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program)
    return undefined
  }
  return program
}

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | undefined {
  const shader = gl.createShader(type)
  if (!shader) return undefined
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader)
    return undefined
  }
  return shader
}

function drawPenLines(context: ScratchCanvas2DContext, width: number, height: number, sprite: ScratchTarget): void {
  if (!sprite.penLines?.length) return
  drawPenLineRuns(context, width, height, sprite.penLines)
}

function drawPenLineRuns(context: ScratchCanvas2DContext, width: number, height: number, lines: PenLine[]): void {
  if (!lines.length) return
  context.save()
  context.lineJoin = 'round'
  let currentStyle = ''
  let pathOpen = false
  const strokeOpenPath = () => {
    if (!pathOpen) return
    context.stroke()
    pathOpen = false
  }
  for (const line of lines) {
    const alpha = bounded(1 - line.transparency / 100, 0, 1)
    const strokeStyle = penColorToCss(line.color)
    const lineWidth = penLineWidth(line, width)
    const lineCap: CanvasLineCap = isStationaryPenLine(line) ? 'round' : 'butt'
    const styleKey = `${alpha}|${strokeStyle}|${lineWidth}|${lineCap}`
    const transparent = alpha < 1 || /^rgba\(/i.test(strokeStyle)
    const singleStroke = transparent || (line.size <= 1 && !isStationaryPenLine(line))
    if (singleStroke || styleKey !== currentStyle) {
      strokeOpenPath()
      currentStyle = singleStroke ? '' : styleKey
      context.globalAlpha = alpha
      context.strokeStyle = strokeStyle
      context.lineWidth = lineWidth
      context.lineCap = lineCap
      context.beginPath()
      pathOpen = true
    }
    drawPenLinePath(context, width, height, line)
    if (singleStroke) strokeOpenPath()
  }
  strokeOpenPath()
  context.restore()
}

function drawGroupedPenLines(context: ScratchCanvas2DContext, width: number, height: number, lines: PenLine[]): void {
  drawPenLineRuns(context, width, height, lines)
}

function drawPenLinePath(context: ScratchCanvas2DContext, width: number, height: number, line: PenLine): void {
  const start = scratchToCanvasPoint(line.x1, line.y1, width, height)
  const end = scratchToCanvasPoint(line.x2, line.y2, width, height)
  context.moveTo(start.x, start.y)
  if (start.x === end.x && start.y === end.y) context.lineTo(end.x + 0.01, end.y)
  else context.lineTo(end.x, end.y)
}

function isStationaryPenLine(line: PenLine): boolean {
  return line.x1 === line.x2 && line.y1 === line.y2
}

function penLineWidth(line: PenLine, width: number): number {
  const scaled = (line.size / SCRATCH_STAGE_WIDTH) * width
  if (isStationaryPenLine(line)) return Math.max(1, scaled)
  return line.size <= 1 ? Math.max(0.75, scaled * 0.75) : Math.max(1, scaled)
}

function penColorToCss(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (/^#[\da-f]{3}([\da-f]{3})?$/i.test(trimmed) || /^[a-z]+$/i.test(trimmed) || /^rgba?\(/i.test(trimmed)) return trimmed
  }
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim())
  if (!Number.isFinite(numeric)) return '#000000'
  const unsigned = numeric >>> 0
  const alpha = (unsigned >>> 24) & 0xff
  const red = (unsigned >>> 16) & 0xff
  const green = (unsigned >>> 8) & 0xff
  const blue = unsigned & 0xff
  return alpha === 0 ? `rgb(${red}, ${green}, ${blue})` : `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`
}

function applySpriteTransform(context: ScratchCanvas2DContext, sprite: ScratchTarget): void {
  const direction = sprite.direction ?? 90
  if (sprite.rotationStyle === "don't rotate") return
  if (sprite.rotationStyle === 'left-right') {
    if (direction < 0) context.scale(-1, 1)
    return
  }
  context.rotate(((direction - 90) * Math.PI) / 180)
}

function applySpriteEffects(context: ScratchCanvas2DContext, sprite: ScratchTarget): void {
  const effects = sprite.effects ?? {}
  const ghost = bounded(Number(effects.ghost) || 0, 0, 100)
  const brightness = bounded(Number(effects.brightness) || 0, -100, 100)
  context.globalAlpha = bounded(1 - ghost / 100, 0, 1)
  context.filter = brightness === 0 ? 'none' : `brightness(${bounded(100 + brightness, 0, 200)}%)`
}

function spriteHasGraphicEffects(sprite: ScratchTarget): boolean {
  const effects = sprite.effects
  return !!effects && ((Number(effects.ghost) || 0) !== 0 || (Number(effects.brightness) || 0) !== 0)
}

function spriteFillColor(sprite: ScratchTarget, selected: boolean): string {
  const color = Number(sprite.effects?.color) || 0
  if (color === 0) return selected ? '#fb923c' : '#fdba74'
  const hue = ((color % 200) / 200) * 360
  return `hsl(${hue} 85% ${selected ? 56 : 68}%)`
}

function drawSpeechBubble(
  context: ScratchCanvas2DContext,
  x: number,
  y: number,
  bubble: { type: 'say' | 'think'; text: string },
): void {
  const text = bubble.text.slice(0, 80)
  context.save()
  context.font = '13px system-ui, sans-serif'
  const width = Math.min(180, Math.max(48, context.measureText(text).width + 22))
  const height = 34
  const left = bounded(x, 4, context.canvas.width - width - 4)
  const top = bounded(y, 4, context.canvas.height - height - 4)
  context.fillStyle = '#ffffff'
  context.strokeStyle = '#94a3b8'
  context.lineWidth = 1.5
  context.beginPath()
  roundedRectPath(context, left, top, width, height, 8)
  context.fill()
  context.stroke()
  if (bubble.type === 'think') {
    context.beginPath()
    context.arc(left + 8, top + height + 7, 3, 0, Math.PI * 2)
    context.arc(left + 1, top + height + 14, 2, 0, Math.PI * 2)
    context.fill()
    context.stroke()
  } else {
    context.beginPath()
    context.moveTo(left + 18, top + height - 1)
    context.lineTo(left + 8, top + height + 10)
    context.lineTo(left + 34, top + height - 1)
    context.closePath()
    context.fill()
    context.stroke()
  }
  context.fillStyle = '#0f172a'
  context.fillText(text, left + 11, top + 22)
  context.restore()
}

function roundedRectPath(context: ScratchCanvas2DContext, x: number, y: number, width: number, height: number, radius: number): void {
  context.moveTo(x + radius, y)
  context.lineTo(x + width - radius, y)
  context.quadraticCurveTo(x + width, y, x + width, y + radius)
  context.lineTo(x + width, y + height - radius)
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height)
  context.lineTo(x + radius, y + height)
  context.quadraticCurveTo(x, y + height, x, y + height - radius)
  context.lineTo(x, y + radius)
  context.quadraticCurveTo(x, y, x + radius, y)
}

function scratchToCanvasPoint(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: ((x + 240) / 480) * width,
    y: ((180 - y) / 360) * height,
  }
}

function canvasToScratchPoint(x: number, y: number, width: number, height: number): { x: number; y: number } {
  return {
    x: (x / width) * 480 - 240,
    y: 180 - (y / height) * 360,
  }
}

function uniqueSpriteName(project: ScratchProject, base = 'Sprite'): string {
  const names = new Set(project.targets.map((target) => target.name))
  if (base !== 'Sprite' && !names.has(base)) return base
  let index = project.targets.filter((target) => !target.isStage).length + 1
  let candidate = `${base}${index}`
  while (names.has(candidate)) {
    index += 1
    candidate = `${base}${index}`
  }
  return candidate
}

function uniqueAssetName(names: string[], base: string): string {
  const used = new Set(names)
  if (!used.has(base)) return base
  let index = 2
  let candidate = `${base}${index}`
  while (used.has(candidate)) {
    index += 1
    candidate = `${base}${index}`
  }
  return candidate
}

function uniqueTargetId(project: ScratchProject, base: string): string {
  const ids = new Set(project.targets.map((target) => target.id).filter(Boolean))
  let index = project.targets.length
  let candidate = `${base}${index}`
  while (ids.has(candidate)) {
    index += 1
    candidate = `${base}${index}`
  }
  return candidate
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

function referencedAssets(project: ScratchProject): Array<{ assetId: string; md5ext: string; dataFormat: string }> {
  const assets = new Map<string, { assetId: string; md5ext: string; dataFormat: string }>()
  for (const target of project.targets) {
    for (const costume of target.costumes) {
      const dataFormat = costume.dataFormat ?? extensionFromMd5ext(costume.md5ext) ?? 'svg'
      const assetId = costume.assetId ?? stripExtension(costume.md5ext) ?? ''
      const md5ext = costume.md5ext ?? (assetId ? `${assetId}.${dataFormat}` : '')
      if (assetId && md5ext) assets.set(md5ext, { assetId, md5ext, dataFormat })
    }
    for (const sound of target.sounds) {
      const dataFormat = sound.dataFormat ?? extensionFromMd5ext(sound.md5ext) ?? 'wav'
      const assetId = sound.assetId ?? stripExtension(sound.md5ext) ?? ''
      const md5ext = sound.md5ext ?? (assetId ? `${assetId}.${dataFormat}` : '')
      if (assetId && md5ext) assets.set(md5ext, { assetId, md5ext, dataFormat })
    }
  }
  return [...assets.values()]
}

function placeholderAssetBytes(dataFormat: string): Uint8Array | undefined {
  if (dataFormat === 'svg') {
    return strToU8('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="40" fill="#ffab19" stroke="#c2410c" stroke-width="4"/></svg>')
  }
  if (dataFormat === 'wav') return new Uint8Array(placeholderWav)
  return undefined
}

function normalizeAssetBytes(data: Uint8Array, dataFormat: string): Uint8Array {
  if (dataFormat.toLowerCase() !== 'svg') return new Uint8Array(data)
  const text = new TextDecoder().decode(data)
  return strToU8(sanitizeSvgText(text))
}

export function sanitizeSvgText(text: string): string {
  let output = text
  output = output.replace(/<script[\s\S]*?<\/script>/gi, '')
  output = output.replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
  output = output.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
  output = output.replace(/\s(?:href|xlink:href)\s*=\s*(['"])\s*(?:javascript:|data:text\/html)[\s\S]*?\1/gi, '')
  output = output.replace(/@import[^;]+;/gi, '')
  if (!/<svg[\s>]/i.test(output)) return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
  if (!/xmlns=/.test(output)) output = output.replace(/<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"')
  return output
}

export function sanitizeSvgByteStream(rawData: Uint8Array): Uint8Array {
  return strToU8(sanitizeSvgText(new TextDecoder().decode(rawData)))
}

export function loadSvgString(svgString: string, _fromVersion2 = false): SVGSVGElement | { outerHTML: string; viewBox: { baseVal: { x: number; y: number; width: number; height: number } } } {
  const sanitized = sanitizeSvgText(svgString)
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(sanitized, 'image/svg+xml')
    const svg = doc.documentElement as unknown as SVGSVGElement
    if (!svg.getAttribute('viewBox')) {
      const width = Number(svg.getAttribute('width')) || 1
      const height = Number(svg.getAttribute('height')) || 1
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    }
    return svg
  }
  const width = Number(/width=["']?([\d.]+)/i.exec(sanitized)?.[1]) || 1
  const height = Number(/height=["']?([\d.]+)/i.exec(sanitized)?.[1]) || 1
  return { outerHTML: sanitized, viewBox: { baseVal: { x: 0, y: 0, width, height } } }
}

export function serializeSvgToString(svgTag: unknown, _shouldInjectFonts = false): string {
  if (typeof svgTag === 'string') return sanitizeSvgText(svgTag)
  if (svgTag && typeof XMLSerializer !== 'undefined') return sanitizeSvgText(new XMLSerializer().serializeToString(svgTag as Node))
  if (isObject(svgTag) && typeof svgTag.outerHTML === 'string') return sanitizeSvgText(svgTag.outerHTML)
  return '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
}

export function inlineSvgFonts(svgText: string): string {
  return svgText
}

export function convertFonts<T>(svgTag: T): T {
  return svgTag
}

export const SvgElement = {
  set: (element: Element, name: string, value: string) => element.setAttribute(name, value),
  get: (element: Element, name: string) => element.getAttribute(name),
}

export class BitmapAdapter {
  constructor(private makeImage: () => HTMLImageElement = () => new Image(), private makeCanvas: () => HTMLCanvasElement = () => document.createElement('canvas')) {}

  resize(image: CanvasImageSource & { width: number; height: number }, newWidth: number, newHeight: number): HTMLCanvasElement {
    const canvas = this.makeCanvas()
    canvas.width = newWidth
    canvas.height = newHeight
    const context = canvas.getContext('2d')
    if (context) {
      context.imageSmoothingEnabled = false
      context.drawImage(image, 0, 0, newWidth, newHeight)
    }
    return canvas
  }

  getResizedWidthHeight(oldWidth: number, oldHeight: number): { width: number; height: number } {
    const stageWidth = 480
    const stageHeight = 360
    if (oldWidth <= stageWidth && oldHeight <= stageHeight) return { width: oldWidth * 2, height: oldHeight * 2 }
    if (oldWidth <= stageWidth * 2 && oldHeight <= stageHeight * 2) return { width: oldWidth, height: oldHeight }
    const ratio = oldWidth / oldHeight
    return ratio >= stageWidth / stageHeight ? { width: stageWidth * 2, height: (stageWidth * 2) / ratio } : { width: stageHeight * 2 * ratio, height: stageHeight * 2 }
  }

  convertResolution1Bitmap(dataURI: string, callback: (error: unknown, dataURI?: string) => void): void {
    const image = this.makeImage()
    image.onload = () => callback(null, this.resize(image, image.width * 2, image.height * 2).toDataURL())
    image.onerror = () => callback('Image load failed')
    image.src = dataURI
  }

  async importBitmap(fileData: ArrayBuffer | string, _fileType = 'image/png'): Promise<Uint8Array | string> {
    return typeof fileData === 'string' ? fileData : new Uint8Array(fileData)
  }
}

export class SVGRenderer {
  private svgTag?: ReturnType<typeof loadSvgString>
  private measurements = { x: 0, y: 0, width: 1, height: 1 }
  loaded = false

  constructor(readonly canvas: HTMLCanvasElement = typeof document === 'undefined' ? (undefined as unknown as HTMLCanvasElement) : document.createElement('canvas')) {}

  get size(): [number, number] {
    return [this.measurements.width, this.measurements.height]
  }

  get viewOffset(): [number, number] {
    return [this.measurements.x, this.measurements.y]
  }

  loadString(svgString: string, fromVersion2 = false): void {
    this.svgTag = loadSvgString(svgString, fromVersion2)
    const baseVal = this.svgTag.viewBox.baseVal
    this.measurements = { x: baseVal.x, y: baseVal.y, width: baseVal.width || 1, height: baseVal.height || 1 }
  }

  loadSVG(svgString: string, fromVersion2 = false, onFinish?: () => void): void {
    this.loadString(svgString, fromVersion2)
    this.loaded = true
    onFinish?.()
  }

  toString(shouldInjectFonts = false): string {
    return serializeSvgToString(this.svgTag, shouldInjectFonts)
  }

  draw(scale = 1): HTMLCanvasElement {
    this.canvas.width = Math.max(1, Math.ceil(this.measurements.width * scale))
    this.canvas.height = Math.max(1, Math.ceil(this.measurements.height * scale))
    return this.canvas
  }
}

export const sanitizeSvg = {
  sanitizeSvgText,
  sanitizeByteStream: sanitizeSvgByteStream,
}

function isZip(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b
}

function bytesHash(bytes: Uint8Array): string {
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function assetDataBytes(data: AssetData): Uint8Array {
  return typeof data === 'string' ? strToU8(data) : new Uint8Array(data)
}

function isByteSource(value: unknown): value is Uint8Array | ArrayBuffer {
  return value instanceof Uint8Array || value instanceof ArrayBuffer || ArrayBuffer.isView(value)
}

function byteSourceToUint8Array(value: unknown): Uint8Array | undefined {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  return undefined
}

async function bitmapToPngBytes(bitmap: Uint8Array | ImageData | HTMLCanvasElement): Promise<Uint8Array> {
  if (bitmap instanceof Uint8Array) return bitmap
  if (typeof HTMLCanvasElement !== 'undefined' && bitmap instanceof HTMLCanvasElement) {
    const blob = await new Promise<Blob | null>((resolve) => bitmap.toBlob(resolve, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array()
  }
  if (typeof document !== 'undefined' && typeof ImageData !== 'undefined' && bitmap instanceof ImageData) {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.putImageData(bitmap, 0, 0)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array()
  }
  return new Uint8Array()
}

function bytesToBase64(bytes: Uint8Array): string {
  const bufferCtor = (globalThis as typeof globalThis & { Buffer?: { from(data: Uint8Array): { toString(encoding: 'base64'): string } } }).Buffer
  if (bufferCtor) return bufferCtor.from(bytes).toString('base64')
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function stripExtension(value: string | undefined): string | undefined {
  if (!value) return undefined
  const index = value.lastIndexOf('.')
  return index >= 0 ? value.slice(0, index) : value
}

function extensionFromMd5ext(value: string | undefined): string | undefined {
  if (!value) return undefined
  const index = value.lastIndexOf('.')
  return index >= 0 ? value.slice(index + 1) : undefined
}

function normalizeExtensionId(idOrUrl: string): string {
  const text = String(idOrUrl || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    return url.pathname.split('/').filter(Boolean).pop()?.replace(/\.[cm]?js$/i, '') || url.hostname
  } catch {
    return text.replace(/^scratch3_/, '').replace(/\.[cm]?js$/i, '')
  }
}

const placeholderWav = [
  0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
  0x66, 0x6d, 0x74, 0x20, 0x10, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00,
  0x44, 0xac, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x02, 0x00, 0x10, 0x00,
  0x64, 0x61, 0x74, 0x61, 0x00, 0x00, 0x00, 0x00,
]

function isExtensionHatOpcode(opcode: string): boolean {
  return [
    'videoSensing_whenMotionGreaterThan', 'whenMotionGreaterThan',
    'speech2text_whenIHearHat', 'whenIHearHat',
    'makeymakey_whenMakeyKeyPressed', 'whenMakeyKeyPressed',
    'makeymakey_whenCodePressed', 'whenCodePressed',
    'microbit_whenButtonPressed', 'ev3_whenButtonPressed', 'whenButtonPressed',
    'microbit_whenGesture', 'gdxfor_whenGesture', 'whenGesture',
    'microbit_whenTilted', 'wedo2_whenTilted', 'boost_whenTilted', 'gdxfor_whenTilted', 'faceSensing_whenTilted', 'whenTilted',
    'microbit_whenPinConnected', 'whenPinConnected',
    'ev3_whenDistanceLessThan', 'whenDistanceLessThan',
    'ev3_whenBrightnessLessThan', 'whenBrightnessLessThan',
    'wedo2_whenDistance', 'whenDistance',
    'boost_whenColor', 'whenColor',
    'gdxfor_whenForcePushedOrPulled', 'whenForcePushedOrPulled',
    'faceSensing_whenFaceDetected', 'whenFaceDetected',
    'faceSensing_whenSpriteTouchesPart', 'whenSpriteTouchesPart',
  ].includes(opcode)
}

function extensionDevice(opcode: string): string {
  if (opcode.includes('microbit')) return 'microbit'
  if (opcode.includes('ev3')) return 'ev3'
  if (opcode.includes('wedo2')) return 'wedo2'
  if (opcode.includes('boost')) return 'boost'
  if (opcode.includes('gdx')) return 'gdxfor'
  if (opcode.includes('face')) return 'face'
  if (opcode.includes('makey')) return 'makeymakey'
  return 'extension'
}

function extensionNumber(data: unknown, key: string, fallback: number): number {
  if (!isObject(data)) return fallback
  const value = data[key] ?? data.value
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function extensionBoolean(data: unknown, key: string): boolean {
  if (!isObject(data)) return false
  return data[key] === true || data.value === true
}

function extensionPoint(data: unknown): { x: number; y: number } {
  if (!isObject(data)) return { x: 0, y: 0 }
  return { x: Number(data.x) || 0, y: Number(data.y) || 0 }
}

function speechValue(data: unknown): string {
  if (!isObject(data)) return ''
  return String(data.text ?? data.transcript ?? data.speech ?? '')
}

function changePenParam(target: ScratchTarget, param: string, value: number, change: boolean): void {
  const pen = ensurePen(target)
  const key = param.toLowerCase()
  if (key.includes('saturation')) pen.saturation = bounded(change ? pen.saturation + value : value, 0, 100)
  else if (key.includes('transparency')) pen.transparency = bounded(change ? pen.transparency + value : value, 0, 100)
  else if (key.includes('brightness') || key.includes('shade')) pen.brightness = bounded(change ? pen.brightness + value : value, 0, 100)
  else pen.color = String(change ? Number.parseFloat(pen.color.replace('#', '0x')) + value : value)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isRotationStyle(value: unknown): value is RotationStyle {
  return value === 'all around' || value === "don't rotate" || value === 'left-right'
}
