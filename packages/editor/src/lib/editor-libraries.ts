import { scratchCostumeLibrary, scratchSoundLibrary, scratchSpriteLibrary } from './scratch-asset-libraries'

export const spriteLibrary = scratchSpriteLibrary

export const costumeLibrary = scratchCostumeLibrary

export const soundLibrary = scratchSoundLibrary

export const extensionLibrary = [
  { extensionId: 'pen', name: 'Pen', icon: '✎', color: '#0fbd8c', tags: ['drawing', 'stage'] },
  { extensionId: 'music', name: 'Music', icon: '♪', color: '#0fbd8c', tags: ['sound', 'tempo'] },
  { extensionId: 'videoSensing', name: 'Video Sensing', icon: '▣', color: '#0fbd8c', tags: ['camera', 'motion'] },
  { extensionId: 'translate', name: 'Translate', icon: '文', color: '#0fbd8c', tags: ['language', 'text'] },
  { extensionId: 'text2speech', name: 'Text to Speech', icon: '☊', color: '#0fbd8c', tags: ['voice', 'speech'] },
  { extensionId: 'speech2text', name: 'Speech to Text', icon: '☌', color: '#0fbd8c', tags: ['voice', 'listening'] },
  { extensionId: 'microbit', name: 'micro:bit', icon: '▦', color: '#0fbd8c', tags: ['hardware', 'sensors'] },
  { extensionId: 'makeymakey', name: 'Makey Makey', icon: '⌨', color: '#0fbd8c', tags: ['hardware', 'keys'] },
  { extensionId: 'ev3', name: 'LEGO EV3', icon: '▤', color: '#0fbd8c', tags: ['hardware', 'motors'] },
  { extensionId: 'wedo2', name: 'LEGO WeDo 2.0', icon: '⚙', color: '#0fbd8c', tags: ['hardware', 'motors'] },
  { extensionId: 'boost', name: 'LEGO BOOST', icon: '⬢', color: '#0fbd8c', tags: ['hardware', 'motors'] },
  { extensionId: 'gdxfor', name: 'Go Direct Force & Acceleration', icon: '↯', color: '#0fbd8c', tags: ['hardware', 'sensors'] },
  { extensionId: 'faceSensing', name: 'Face Sensing', icon: '◉', color: '#0fbd8c', tags: ['camera', 'face'] },
] as const
