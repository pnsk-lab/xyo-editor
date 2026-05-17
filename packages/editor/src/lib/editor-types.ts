import type { ScratchCostume, ScratchSound } from '@hikkaku/vm'
import type { costumeLibrary, extensionLibrary, soundLibrary, spriteLibrary } from './editor-libraries'

export type BitmapTool = 'brush' | 'eraser' | 'fill' | 'line' | 'rect' | 'oval' | 'text' | 'select'

export type VectorResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export type VectorPathPointInfo = {
  index: number
  x: number
  y: number
  kind?: 'anchor' | 'control'
  controlRole?: 'in' | 'out'
  pairIndex?: number
  command?: string
  relatedAnchorIndex?: number
}

export type EditorTab = 'code' | 'costumes' | 'sounds'

export type SoundEffect =
  | 'reverse'
  | 'louder'
  | 'softer'
  | 'faster'
  | 'slower'
  | 'echo'
  | 'robot'
  | 'fade-in'
  | 'fade-out'
  | 'trim-start'
  | 'trim-end'
  | 'insert-silence'
  | 'mute'

export type AssetHistoryEntry =
  | { kind: 'costume'; targetName: string; index: number; meta: ScratchCostume; bytes: Uint8Array }
  | { kind: 'sound'; targetName: string; index: number; meta: ScratchSound; bytes: Uint8Array }

export type VectorObjectInfo = {
  index: number
  tag: string
  label: string
  fill?: string
  stroke?: string
  strokeWidth?: number
  opacity?: number
  rotation?: number
  x?: number
  y?: number
  width?: number
  height?: number
  boundsX?: number
  boundsY?: number
  boundsWidth?: number
  boundsHeight?: number
  points?: VectorPathPointInfo[]
  text?: string
}

export type LibraryPanel = 'sprite' | 'costume' | 'backdrop' | 'sound' | 'extension' | undefined

export type LibraryItem =
  | (typeof spriteLibrary)[number]
  | (typeof costumeLibrary)[number]
  | (typeof soundLibrary)[number]
  | (typeof extensionLibrary)[number]
