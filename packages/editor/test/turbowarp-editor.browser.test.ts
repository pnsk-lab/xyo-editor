import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate'
import { type Browser, type Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Runs source editor + real pinned CDN; requires network, Chromium and WebGL.
const suite = process.env.TURBOWARP_CDN_TEST === '1' ? describe : describe.skip
const root = join(import.meta.dir, '..')
const base = 'http://127.0.0.1:4179'
let server: ChildProcessWithoutNullStreams | undefined
let browser: Browser | undefined
let page: Page | undefined
let browserDiagnostics: string[] = []

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><rect width="50" height="50" fill="red"/></svg>'
const costume = {
  name: 'red',
  assetId: '12345678901234567890123456789012',
  md5ext: '12345678901234567890123456789012.svg',
  dataFormat: 'svg',
  rotationCenterX: 25,
  rotationCenterY: 25,
}
function archive(blocks: Record<string, unknown>, spriteOptions: Record<string, unknown> = {}) {
  const common = {
    variables: {},
    lists: {},
    broadcasts: {},
    comments: {},
    currentCostume: 0,
    costumes: [costume],
    sounds: [],
    volume: 100,
  }
  const project = {
    targets: [
      {
        ...common,
        isStage: true,
        name: 'Stage',
        blocks: {},
        layerOrder: 0,
        tempo: 60,
        videoTransparency: 50,
        videoState: 'on',
      },
      {
        ...common,
        isStage: false,
        name: 'Sprite1',
        blocks,
        layerOrder: 1,
        visible: true,
        x: 0,
        y: 0,
        size: 100,
        direction: 90,
        draggable: false,
        rotationStyle: 'all around',
        ...spriteOptions,
      },
    ],
    monitors: [],
    extensions: [],
    meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' },
  }
  return Buffer.from(
    zipSync({ 'project.json': strToU8(JSON.stringify(project)), [costume.md5ext]: strToU8(svg) }),
  )
}
const moveBlocks = {
  flag: {
    opcode: 'event_whenflagclicked',
    next: 'move',
    parent: null,
    inputs: {},
    fields: {},
    shadow: false,
    topLevel: true,
    x: 32,
    y: 32,
  },
  move: {
    opcode: 'motion_changexby',
    next: null,
    parent: 'flag',
    inputs: { DX: [1, [4, '25']] },
    fields: {},
    shadow: false,
    topLevel: false,
  },
}
async function loadProject(
  blocks: Record<string, unknown>,
  spriteOptions: Record<string, unknown> = {},
) {
  await page!.getByTestId('project-file-input').setInputFiles({
    name: 'test.sb3',
    mimeType: 'application/x.scratch.sb3',
    buffer: archive(blocks, spriteOptions),
  })
  const firstId = Object.keys(blocks)[0]
  await page!.waitForFunction(
    (id) => (window as any).__hikkakuEditorTest?.workspaceBlocks?.()[id],
    firstId,
    { timeout: 10000 },
  )
}
async function x() {
  return page!.evaluate(
    () =>
      (window as any).__hikkakuEditorTest
        .snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.x,
  )
}
async function waitX(value: number) {
  await page!.waitForFunction(
    (n) =>
      (window as any).__hikkakuEditorTest
        .snapshot()
        .project.targets.find((t: any) => t.name === 'Sprite1')?.x === n,
    value,
    { timeout: 7000 },
  )
}

suite('real TurboWarp backend in editor', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], {
      cwd: root,
      stdio: 'pipe',
    })
    let ready = false
    for (let i = 0; i < 100; i++) {
      if (server.exitCode !== null) throw new Error(`Vite exited ${server.exitCode}`)
      try {
        if ((await fetch(base)).ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    if (!ready) throw new Error('Vite failed to start')
    browser = await launchBrowser({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
    })
  }, 30000)
  beforeEach(async () => {
    page = await browser!.newPage({ viewport: { width: 1280, height: 800 } })
    browserDiagnostics = []
    page.on('pageerror', (error) =>
      browserDiagnostics.push(`pageerror: ${error.stack || error.message}`),
    )
    page.on('console', (message) => {
      if (message.type() === 'error' || message.text().includes('[vite]'))
        browserDiagnostics.push(`console ${message.type()}: ${message.text()}`)
    })
    page.on('framenavigated', (frame) => {
      if (frame === page?.mainFrame()) browserDiagnostics.push(`navigation: ${frame.url()}`)
    })
    await page.addInitScript(() => localStorage.setItem('hikkaku.runtime-backend', 'tw'))
    await page.goto(`${base}/test/turbowarp-editor-fixture.html`)
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible', timeout: 20000 })
    expect(await page.evaluate(() => !!(window as any).__twBackend)).toBe(true)
    expect(await page.getByRole('alert').count()).toBe(0)
  }, 30000)
  afterEach(async () => {
    if (browserDiagnostics.length)
      console.log('Browser diagnostics:', browserDiagnostics.join('\n'))
    await page?.close()
    page = undefined
  })
  afterAll(async () => {
    await browser?.close()
    server?.kill()
  })

  it('mounts the selected backend with a live WebGL stage', async () => {
    const details = await page!.getByTestId('stage-canvas').evaluate((element) => {
      const canvas = element as HTMLCanvasElement
      return {
        width: canvas.width,
        height: canvas.height,
        webgl: !!(canvas.getContext('webgl2') || canvas.getContext('webgl')),
      }
    })
    expect(details.width).toBeGreaterThan(0)
    expect(details.height).toBeGreaterThan(0)
    expect(details.webgl).toBe(true)
  })
  it('loads an SB3 and runs green flag', async () => {
    await loadProject(moveBlocks)
    expect(await x()).toBe(0)
    await page!.getByLabel('Green flag').click()
    await waitX(25)
    expect(await x()).toBe(25)
  }, 30000)
  it('applies sprite position edits before green flag', async () => {
    await loadProject(moveBlocks)
    await page!.getByLabel('Sprite x').fill('40')
    await page!.getByLabel('Sprite x').press('Tab')
    await waitX(40)
    await page!.getByLabel('Green flag').click()
    await waitX(65)
    expect(await x()).toBe(65)
  }, 30000)
  it('preserves the live x position after a y edit and in the exported SB3', async () => {
    await loadProject(moveBlocks)
    await page!.getByLabel('Green flag').click()
    await waitX(25)
    await page!.getByLabel('Sprite y').fill('40')
    await page!.getByLabel('Sprite y').press('Tab')
    await page!.waitForFunction(
      () =>
        (window as any).__hikkakuEditorTest
          .snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.y === 40,
      null,
      { timeout: 7000 },
    )
    expect(await x()).toBe(25)
    await page!.locator('summary').filter({ hasText: 'ファイル' }).click()
    const downloadPromise = page!.waitForEvent('download', { timeout: 10000 })
    await page!.getByRole('button', { name: 'SB3 で保存' }).click()
    const download = await downloadPromise
    expect(download.suggestedFilename().endsWith('.sb3')).toBe(true)
    const downloadPath = await download.path()
    if (!downloadPath) throw new Error('SB3 download has no local path')
    const files = unzipSync(new Uint8Array(await readFile(downloadPath)))
    if (!files['project.json']) throw new Error('Exported SB3 has no project.json')
    const project = JSON.parse(strFromU8(files['project.json']))
    const sprite = project.targets.find((t: any) => t.name === 'Sprite1')
    expect(sprite?.x).toBe(25)
    expect(sprite?.y).toBe(40)
    expect(await x()).toBe(25)
  }, 30000)
  it('forwards keyboard input to running scripts', async () => {
    await loadProject({
      ...moveBlocks,
      key: {
        opcode: 'event_whenkeypressed',
        next: 'keyMove',
        parent: null,
        inputs: {},
        fields: { KEY_OPTION: ['space', null] },
        shadow: false,
        topLevel: true,
        x: 32,
        y: 150,
      },
      keyMove: {
        opcode: 'motion_changexby',
        next: null,
        parent: 'key',
        inputs: { DX: [1, [4, '10']] },
        fields: {},
        shadow: false,
        topLevel: false,
      },
    })
    await page!.getByLabel('Green flag').click()
    await waitX(25)
    await page!.locator('body').click({ position: { x: 5, y: 5 } })
    await page!.keyboard.press('Space')
    await waitX(35)
    expect(await x()).toBe(35)
  }, 30000)
  it('executes a workspace command on click without the green flag', async () => {
    await loadProject({
      move: {
        opcode: 'motion_changexby',
        next: null,
        parent: null,
        inputs: { DX: [1, [4, '25']] },
        fields: {},
        shadow: false,
        topLevel: true,
        x: 32,
        y: 32,
      },
    })
    await page!
      .locator('.blocklyWorkspace .blocklyDraggable[data-id="move"] .blocklyPath')
      .first()
      .click({ position: { x: 12, y: 12 } })
    await waitX(25)
  }, 30000)
  it('shows the value of a clicked reporter', async () => {
    await loadProject(
      {
        reporter: {
          opcode: 'motion_xposition',
          next: null,
          parent: null,
          inputs: {},
          fields: {},
          shadow: false,
          topLevel: true,
          x: 32,
          y: 32,
        },
      },
      { x: 42 },
    )
    await page!
      .locator('.blocklyWorkspace .blocklyDraggable[data-id="reporter"] .blocklyPath')
      .first()
      .click({ position: { x: 12, y: 10 } })
    await page!
      .getByTestId('visual-report')
      .filter({ hasText: '42' })
      .waitFor({ state: 'visible', timeout: 7000 })
  }, 30000)
  for (const operation of ['reporter', 'move', 'step'] as const)
    it(`shows a synchronous VM error for ${operation} without page errors`, async () => {
      await loadProject({
        reporter: {
          opcode: 'motion_xposition',
          next: null,
          parent: null,
          inputs: {},
          fields: {},
          shadow: false,
          topLevel: true,
          x: 32,
          y: 32,
        },
        move: {
          opcode: 'motion_changexby',
          next: null,
          parent: null,
          inputs: { DX: [1, [4, '25']] },
          fields: {},
          shadow: false,
          topLevel: true,
          x: 32,
          y: 130,
        },
      })
      // The disposed adapter is a real synchronous failure state. Assigning
      // methods on the VM proxy would not override its get trap.
      await page!.evaluate(() => (window as any).__twBackend.vm.dispose())
      const error = 'TurboWarp runtime is disposed'
      expect(await page!.evaluate(() => (window as any).__hikkakuEditorTest.status())).not.toBe(
        error,
      )
      if (operation === 'step') await page!.getByLabel('Pause', { exact: true }).click()
      else
        await page!
          .locator(`.blocklyWorkspace .blocklyDraggable[data-id="${operation}"] .blocklyPath`)
          .first()
          .click({ position: { x: 12, y: 10 } })
      await page!.waitForFunction(
        (message) => (window as any).__hikkakuEditorTest.status() === message,
        error,
      )
      expect(browserDiagnostics.filter((message) => message.startsWith('pageerror:'))).toEqual([])
    }, 30000)
  it('drags a draggable sprite on the stage', async () => {
    await loadProject(moveBlocks, { draggable: true })
    const box = await page!.getByTestId('stage-canvas').boundingBox()
    if (!box) throw new Error('Missing stage bounds')
    await page!.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page!.mouse.down()
    await page!.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 10 })
    await page!.mouse.up()
    await page!.waitForFunction(
      () =>
        (window as any).__hikkakuEditorTest
          .snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.x > 30,
      null,
      { timeout: 7000 },
    )
    expect(browserDiagnostics.filter((message) => message.startsWith('pageerror:'))).toEqual([])
  }, 30000)
  it('updates a variable through a clicked stack', async () => {
    await loadProject(
      {
        set: {
          opcode: 'data_setvariableto',
          next: null,
          parent: null,
          inputs: { VALUE: [1, [4, '17']] },
          fields: { VARIABLE: ['score', 'score'] },
          shadow: false,
          topLevel: true,
          x: 32,
          y: 32,
        },
      },
      { variables: { score: ['score', 0] } },
    )
    await page!
      .locator('.blocklyWorkspace .blocklyDraggable[data-id="set"] .blocklyPath')
      .first()
      .click({ position: { x: 12, y: 12 } })
    await page!.waitForFunction(
      () =>
        Number(
          (window as any).__hikkakuEditorTest
            .snapshot()
            .project.targets.find((t: any) => t.name === 'Sprite1')?.variables.score?.[1],
        ) === 17,
      null,
      { timeout: 7000 },
    )
  }, 30000)
  it('applies a sound volume block through the editor', async () => {
    await loadProject({
      volume: {
        opcode: 'sound_setvolumeto',
        next: null,
        parent: null,
        inputs: { VOLUME: [1, [4, '35']] },
        fields: {},
        shadow: false,
        topLevel: true,
        x: 32,
        y: 32,
      },
    })
    await page!
      .locator('.blocklyWorkspace .blocklyDraggable[data-id="volume"] .blocklyPath')
      .first()
      .click({ position: { x: 12, y: 12 } })
    await page!.waitForFunction(
      () =>
        (window as any).__hikkakuEditorTest
          .snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.volume === 35,
      null,
      { timeout: 7000 },
    )
  }, 30000)
  it('stops a running forever loop', async () => {
    await loadProject({
      flag: {
        opcode: 'event_whenflagclicked',
        next: 'forever',
        parent: null,
        inputs: {},
        fields: {},
        shadow: false,
        topLevel: true,
        x: 32,
        y: 32,
      },
      forever: {
        opcode: 'control_forever',
        next: null,
        parent: 'flag',
        inputs: { SUBSTACK: [2, 'move'] },
        fields: {},
        shadow: false,
        topLevel: false,
      },
      move: {
        opcode: 'motion_changexby',
        next: null,
        parent: 'forever',
        inputs: { DX: [1, [4, '1']] },
        fields: {},
        shadow: false,
        topLevel: false,
      },
    })
    await page!.getByLabel('Green flag').click()
    await page!.waitForFunction(
      () =>
        (window as any).__hikkakuEditorTest
          .snapshot()
          .project.targets.find((t: any) => t.name === 'Sprite1')?.x > 2,
      null,
      { timeout: 7000 },
    )
    await page!.getByLabel('Stop all').click()
    await page!.waitForTimeout(250)
    const stopped = await x()
    await page!.waitForTimeout(250)
    expect(await x()).toBe(stopped)
  }, 30000)
})
