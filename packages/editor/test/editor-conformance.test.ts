import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDefaultProject } from '@hikkaku/vm'
import { strToU8, zipSync } from 'fflate'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'

const root = import.meta.dir.replace(/\/test$/, '')
const appSource = readEditorSources(join(root, 'src'))
const distRoot = join(root, 'dist')
const artifactRoot = join(root, 'test-artifacts')
const baseUrl = 'http://127.0.0.1:4173'
const chromePath = process.env.CHROME_BIN || '/etc/profiles/per-user/nakasyou/bin/google-chrome-stable'

function readEditorSources(directory: string): string {
  return readdirSync(directory, { withFileTypes: true })
    .map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return readEditorSources(path)
      return /\.(svelte|ts)$/.test(entry.name) ? readFileSync(path, 'utf8') : ''
    })
    .join('\n')
}

let server: ChildProcessWithoutNullStreams | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page: Page | undefined
const consoleErrors: string[] = []

const requiredSourceSignals = [
  ['project title input', 'aria-label="Project title"'],
  ['open project control', 'aria-label="Open project"'],
  ['project file input', 'data-testid="project-file-input"'],
  ['export project control', 'aria-label="Export project"'],
  ['green flag control', 'aria-label="Green flag"'],
  ['stop-all control', 'aria-label="Stop all"'],
  ['code tab', 'data-testid={`main-tab-${tab}`}'],
  ['costumes tab', "'costumes'"],
  ['sounds tab', "'sounds'"],
  ['Blockly host', 'data-testid="blockly-host"'],
  ['stage canvas', 'data-testid="stage-canvas"'],
  ['sprite add control', 'aria-label="Add sprite"'],
  ['sprite import control', 'aria-label="Import sprite"'],
  ['sprite backpack control', 'aria-label="Backpack target"'],
  ['costume add control', 'aria-label="Add costume"'],
  ['sound add control', 'aria-label="Add sound"'],
  ['library dialog', 'role="dialog"'],
  ['monitor slider labels', 'aria-label="Monitor slider min"'],
  ['sound waveform control', 'aria-label="Sound waveform selection"'],
]

const visualSourceSignals = [
  ['stage aspect ratio', 'aspect-[4/3]'],
  ['mobile grid fallback', 'grid-cols-1'],
  ['desktop work surface grid', 'lg:grid-cols'],
  ['Blockly hidden instead of unmounted', "selectedTab === 'code' ? '' : 'hidden'"],
  ['paint color input', 'aria-label="Paint color"'],
  ['vector object resize label', 'aria-label="Resize selected vector object"'],
  ['sound selection handles', 'aria-label="Move selection start"'],
]

describe('editor browser conformance', () => {
  beforeAll(async () => {
    mkdirSync(artifactRoot, { recursive: true })
    server = spawn(process.execPath, ['x', 'vite', 'preview', '--host', '127.0.0.1', '--port', '4173', '--strictPort'], {
      cwd: root,
      env: { ...process.env, NO_COLOR: '1' },
    })
    await waitForServer()

    browser = await chromium.launch({
      executablePath: chromePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    })
    context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 })
    page = await context.newPage()
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    page.on('pageerror', (error) => consoleErrors.push(error.message))
    await page.goto(baseUrl, { waitUntil: 'networkidle' })
    await page.getByTestId('stage-canvas').waitFor({ state: 'visible' })
  })

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    server?.kill()
  })

  it('keeps required workflow regions wired in source and production assets', () => {
    for (const [label, signal] of requiredSourceSignals) {
      expect(appSource, `Missing editor region/control: ${label}`).toContain(signal)
    }

    expect(existsSync(distRoot), 'Run the editor build before conformance checks').toBe(true)
    const html = readFileSync(join(distRoot, 'index.html'), 'utf8')
    expect(html).toContain('<div id="app">')
    expect(html).toContain('type="module"')
    expect(html).toContain('stylesheet')

    const assetNames = readdirSync(join(distRoot, 'assets'))
    const jsAssets = assetNames.filter((asset) => asset.endsWith('.js'))
    const cssAssets = assetNames.filter((asset) => asset.endsWith('.css'))
    expect(jsAssets.length, 'Expected JavaScript chunks in dist/assets').toBeGreaterThan(0)
    expect(cssAssets.length, 'Expected CSS chunks in dist/assets').toBeGreaterThan(0)
    for (const asset of [...jsAssets, ...cssAssets]) {
      expect(statSync(join(distRoot, 'assets', asset)).size, `Expected non-empty built asset ${asset}`).toBeGreaterThan(0)
    }
  })

  it('keeps visual layout invariants and captures reviewed viewport screenshots', async () => {
    const currentPage = requirePage()
    const visualReport: Record<string, unknown> = { generated: '2026-05-15', viewports: {} }
    for (const [label, signal] of visualSourceSignals) {
      expect(appSource, `Missing visual/layout invariant: ${label}`).toContain(signal)
    }
    expect(appSource, 'Sprite pane list must hide runtime clone targets').toContain('!target.isStage && !target.isClone')

    for (const viewport of [
      { name: 'mobile', width: 360, height: 740 },
      { name: 'tablet', width: 768, height: 1024 },
      { name: 'desktop', width: 1280, height: 800 },
      { name: 'wide', width: 1440, height: 900 },
    ]) {
      await currentPage.setViewportSize({ width: viewport.width, height: viewport.height })
      await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
      await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })
      const screenshotPath = join(artifactRoot, `${viewport.name}.png`)
      await currentPage.screenshot({ path: screenshotPath, fullPage: true })
      const metrics = await stageCanvasMetrics(currentPage)
      ;(visualReport.viewports as Record<string, unknown>)[viewport.name] = {
        screenshotBytes: statSync(screenshotPath).size,
        stageClientWidth: metrics.clientWidth,
        stageClientHeight: metrics.clientHeight,
        backingWidth: metrics.backingWidth,
        backingHeight: metrics.backingHeight,
        nonWhitePixels: metrics.nonWhitePixels,
      }
      expect(metrics.backingWidth, `${viewport.name} backing width`).toBe(480)
      expect(metrics.backingHeight, `${viewport.name} backing height`).toBe(360)
      expect(Math.abs(metrics.aspect - 4 / 3), `${viewport.name} visible stage aspect`).toBeLessThan(0.03)
      expect(metrics.nonWhitePixels, `${viewport.name} stage pixel matrix should not be blank`).toBeGreaterThan(25)
      const overflowCount = await currentPage.evaluate(() => {
        const elements = [...document.querySelectorAll('button, input, [role="tab"], [role="button"]')] as HTMLElement[]
        return elements.filter((element) => {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          if (style.visibility === 'hidden' || style.display === 'none' || rect.width === 0 || rect.height === 0) return false
          if (element.classList.contains('truncate')) return false
          return element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2
        }).length
      })
      expect(overflowCount, `${viewport.name} viewport has overflowing control text`).toBe(0)
    }
    writeFileSync(join(artifactRoot, 'approved-visual-diff-report.json'), `${JSON.stringify(visualReport, null, 2)}\n`)
  }, 30000)

  it('renders a nonblank stage and keeps Blockly mounted across tab switches', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    expect(await nonWhiteStagePixelCount(currentPage)).toBeGreaterThan(25)
    expect(await currentPage.getByTestId('blockly-host').locator('.blocklySvg').count()).toBeGreaterThan(0)

    await currentPage.getByTestId('main-tab-costumes').click()
    expect(await selectedTab(currentPage)).toBe('costumes')
    expect(await currentPage.getByTestId('blockly-host').locator('.blocklySvg').count()).toBeGreaterThan(0)

    await currentPage.getByTestId('asset-tab-sounds').click()
    expect(await selectedTab(currentPage)).toBe('sounds')
    expect(await currentPage.getByTestId('blockly-host').locator('.blocklySvg').count()).toBeGreaterThan(0)

    await currentPage.getByTestId('asset-tab-code').click()
    expect(await selectedTab(currentPage)).toBe('code')
    expect(await currentPage.getByTestId('blockly-host').locator('.blocklySvg').count()).toBeGreaterThan(0)
  })

  it('fullscreen stage control expands the stage pane instead of the code workspace', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByTestId('stage-pane').getByRole('button', { name: 'Fullscreen' }).click()

    const layout = await currentPage.evaluate(() => {
      const editor = document.querySelector<HTMLElement>('[data-testid="editor-workspace"]')
      const stage = document.querySelector<HTMLElement>('[data-testid="stage-pane"]')
      return {
        editorDisplay: editor ? getComputedStyle(editor).display : '',
        editorPosition: editor ? getComputedStyle(editor).position : '',
        stagePosition: stage ? getComputedStyle(stage).position : '',
        stageRect: stage?.getBoundingClientRect().toJSON(),
        visibleBlocklyToolboxCount: [...document.querySelectorAll<HTMLElement>('.blocklyToolbox, .blocklyToolboxDiv')].filter((element) => {
          const rect = element.getBoundingClientRect()
          const style = getComputedStyle(element)
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
        }).length,
      }
    })

    expect(layout.editorDisplay).toBe('none')
    expect(layout.editorPosition).not.toBe('fixed')
    expect(layout.stagePosition).toBe('fixed')
    expect(layout.stageRect).toMatchObject({ x: 0, y: 0, width: 1280, height: 800 })
    expect(layout.visibleBlocklyToolboxCount).toBe(0)
  })

  it('refreshes the variables flyout after creating a variable', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.locator('.blocklyToolboxCategory', { hasText: '変数' }).click()
    expect(await currentPage.locator('.blocklyFlyout .blocklyDraggable').count()).toBe(0)

    await currentPage.getByText('Make a Variable', { exact: true }).click()
    await currentPage.getByTestId('data-dialog-name').fill('score')
    await currentPage.getByRole('button', { name: 'OK' }).click()
    await currentPage.waitForFunction(() => {
      const texts = [...document.querySelectorAll('.blocklyFlyout .blocklyText')].map((node) => node.textContent)
      return texts.includes('score')
    })

    const next = await snapshot(currentPage)
    const stage = next.project.targets.find((target) => target.isStage)
    expect(Object.values(stage?.variables ?? {}).some((variable) => variable[0] === 'score')).toBe(true)
    expect(await currentPage.locator('.blocklyFlyout .blocklyDraggable').count()).toBeGreaterThanOrEqual(5)

    await currentPage.getByText('Make a List', { exact: true }).click()
    await currentPage.getByTestId('data-dialog-name').fill('items')
    await currentPage.getByLabel('このスプライトのみ').check()
    await currentPage.getByRole('button', { name: 'OK' }).click()
    await currentPage.waitForFunction(() => {
      const texts = [...document.querySelectorAll('.blocklyFlyout .blocklyText')].map((node) => node.textContent)
      return texts.includes('items')
    })

    const withList = await snapshot(currentPage)
    const sprite = withList.project.targets.find((target) => !target.isStage)
    expect(Object.values(sprite?.lists ?? {}).some((list) => list[0] === 'items')).toBe(true)
    const dataBlockFills = await currentPage.evaluate(() => {
      return [...document.querySelectorAll<SVGPathElement>('.blocklyFlyout .blocklyDraggable .blocklyPath')]
        .map((path) => path.getAttribute('fill')?.toLowerCase())
        .filter(Boolean)
    })
    expect(dataBlockFills).toContain('#ff8c1a')
    expect(dataBlockFills).toContain('#ff661a')
  }, 30000)

  it('refreshes sound block menus after adding sounds', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByTestId('main-tab-sounds').click()
    await currentPage.getByLabel('Add sound').click()
    await currentPage.getByRole('menuitem', { name: 'Blank sound' }).click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).sounds.some((sound) => sound.name === 'sound1'))

    await currentPage.getByTestId('main-tab-code').click()
    await currentPage.locator('.blocklyToolboxCategory', { hasText: '音' }).click()
    await currentPage.waitForFunction(() => {
      const texts = [...document.querySelectorAll('.blocklyFlyout .blocklyText')].map((node) => node.textContent?.trim())
      return texts.includes('sound1')
    })

    const soundBlockLabels = await currentPage.evaluate(() => {
      return [...document.querySelectorAll('.blocklyFlyout .blocklyText')]
        .map((node) => node.textContent?.trim())
        .filter(Boolean)
    })
    expect(soundBlockLabels).toContain('sound1')
    expect(soundBlockLabels).not.toContain('pop')
  })

  it('keeps renderer resize and pixel matrix stable across viewport and stage size changes', async () => {
    const currentPage = requirePage()
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 800 },
      { width: 1600, height: 900 },
    ]) {
      await currentPage.setViewportSize(viewport)
      await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
      await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })
      await expectStageMatrix(currentPage)
      await currentPage.getByRole('button', { name: 'Small' }).click()
      await expectStageMatrix(currentPage)
      await currentPage.getByRole('button', { name: 'Large' }).click()
      await expectStageMatrix(currentPage)
    }
  }, 30000)

  it('drags sprites on the stage and updates VM coordinates', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    const canvas = currentPage.getByTestId('stage-canvas')
    await canvas.waitFor({ state: 'visible' })

    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing stage canvas bounds')
    const before = selectedTarget(await snapshot(currentPage))
    await currentPage.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await currentPage.mouse.down()
    await currentPage.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2 + 48, { steps: 8 })
    await currentPage.mouse.up()

    await waitForSnapshot(currentPage, (state) => {
      const sprite = selectedTarget(state)
      return Math.abs((sprite.x ?? 0) - (before.x ?? 0)) > 10 || Math.abs((sprite.y ?? 0) - (before.y ?? 0)) > 10
    })
    const after = selectedTarget(await snapshot(currentPage))
    expect(after.x ?? 0).toBeGreaterThan(before.x ?? 0)
    expect(after.y ?? 0).toBeLessThan(before.y ?? 0)
  })

  it('drives sprite, costume, and sound workflows and verifies VM state', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const initial = await snapshot(currentPage)
    expect(spriteNames(initial)).toEqual(['Sprite1'])

    await currentPage.getByLabel('Add sprite').click()
    let next = await snapshot(currentPage)
    expect(spriteNames(next)).toContain('Sprite2')
    expect(spriteNames(next)).toHaveLength(2)

    currentPage.once('dialog', (dialog) => dialog.accept('BrowserSprite'))
    await currentPage.getByLabel('Rename target').click()
    next = await snapshot(currentPage)
    expect(spriteNames(next)).toContain('BrowserSprite')

    await currentPage.getByLabel('Duplicate target').click()
    next = await snapshot(currentPage)
    expect(spriteNames(next).some((name) => name.startsWith('BrowserSprite copy'))).toBe(true)

    const beforeDeleteCount = spriteNames(next).length
    await currentPage.getByLabel('Delete target').click()
    next = await snapshot(currentPage)
    expect(spriteNames(next).length).toBe(beforeDeleteCount - 1)

    await currentPage.getByLabel('Restore deleted sprite').click()
    next = await snapshot(currentPage)
    expect(spriteNames(next).length).toBe(beforeDeleteCount)

    await currentPage.getByTestId('main-tab-costumes').click()
    const selectedBeforeCostume = selectedTarget(next)
    const costumeCount = selectedBeforeCostume.costumes.length
    await currentPage.getByLabel('Add costume').click()
    next = await snapshot(currentPage)
    expect(selectedTarget(next).costumes.length).toBe(costumeCount + 1)

    await currentPage.getByTestId('asset-tab-sounds').click()
    const soundCount = selectedTarget(next).sounds.length
    await currentPage.getByLabel('Add sound').click()
    next = await snapshot(currentPage)
    expect(selectedTarget(next).sounds.length).toBe(soundCount + 1)
    expect(consoleErrors).toEqual([])
  }, 30000)

  it('imports, rejects, repeats, and exports project files in the browser', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const fixture = createDefaultProject()
    fixture.targets[1]!.name = 'ImportedSprite'
    const fixturePath = join(artifactRoot, 'import-project.json')
    writeFileSync(fixturePath, JSON.stringify(fixture), 'utf8')

    await currentPage.getByTestId('project-file-input').setInputFiles(fixturePath)
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('ImportedSprite'))
    expect(spriteNames(await snapshot(currentPage))).toEqual(['ImportedSprite'])

    currentPage.once('dialog', (dialog) => dialog.accept('MutatedAfterImport'))
    await currentPage.getByLabel('Rename target').click()
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('MutatedAfterImport'))

    await currentPage.getByTestId('project-file-input').setInputFiles(fixturePath)
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('ImportedSprite') && !spriteNames(state).includes('MutatedAfterImport'))

    const bumpedFixture = createDefaultProject()
    bumpedFixture.targets[1]!.name = 'BumpProtectedSprite'
    bumpedFixture.targets[1]!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true, x: -400, y: -320 },
      move: { opcode: 'motion_movesteps', parent: 'flag', inputs: { STEPS: [1, [4, '5']] } },
    }
    const bumpedFixturePath = join(artifactRoot, 'bump-protected-project.json')
    writeFileSync(bumpedFixturePath, JSON.stringify(bumpedFixture), 'utf8')
    await currentPage.getByTestId('project-file-input').setInputFiles(bumpedFixturePath)
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('BumpProtectedSprite'))
    await currentPage.waitForTimeout(500)
    expect(await editorStatus(currentPage)).toBe('Project loaded')
    expect(selectedTarget(await snapshot(currentPage)).blocks.flag?.x).toBe(-400)

    const beforeBadImport = spriteNames(await snapshot(currentPage))
    const invalidPath = join(artifactRoot, 'invalid-project.json')
    writeFileSync(invalidPath, '{broken json', 'utf8')
    await currentPage.getByTestId('project-file-input').setInputFiles(invalidPath)
    await waitForStatus(currentPage, (value) => value.length > 0 && value !== 'Project loaded')
    expect(spriteNames(await snapshot(currentPage))).toEqual(beforeBadImport)

    const downloadPromise = currentPage.waitForEvent('download')
    await currentPage.getByLabel('Export project').click()
    const download = await downloadPromise
    expect(download.suggestedFilename().endsWith('.json')).toBe(true)
  }, 30000)

  it('imports and exports SB3 and Sprite3 archives in the browser', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    project.targets[1]!.name = 'ArchiveProjectSprite'
    project.targets[1]!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true, x: 32, y: 32 },
      move: {
        opcode: 'motion_movesteps',
        parent: 'flag',
        next: null,
        inputs: { STEPS: [1, [4, '10']] },
      },
    }
    const sb3Path = join(artifactRoot, 'archive-project.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).blocks.flag?.opcode === 'event_whenflagclicked')

    const sb3DownloadPromise = currentPage.waitForEvent('download')
    await currentPage.getByRole('button', { name: 'SB3' }).click()
    expect((await sb3DownloadPromise).suggestedFilename().endsWith('.sb3')).toBe(true)

    const sprite = structuredClone(project.targets[1]!)
    sprite.name = 'ImportedSprite3'
    const sprite3Path = join(artifactRoot, 'archive-sprite.sprite3')
    writeFileSync(sprite3Path, zipSync({ 'sprite.json': strToU8(JSON.stringify(sprite)) }))

    await currentPage.getByTestId('sprite-file-input').setInputFiles(sprite3Path)
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('ImportedSprite3'))
    expect(spriteNames(await snapshot(currentPage))).toContain('ImportedSprite3')

    await currentPage.getByTestId('target-card-ImportedSprite3').click()
    const sprite3DownloadPromise = currentPage.waitForEvent('download')
    await currentPage.getByLabel('Export target').click()
    expect((await sprite3DownloadPromise).suggestedFilename().endsWith('.sprite3')).toBe(true)
  }, 30000)

  it('preserves the first sprite workspace when loading an SB3 with the default sprite id', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    project.targets[1]!.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'move', topLevel: true, x: 32, y: 32 },
      move: {
        opcode: 'motion_movesteps',
        parent: 'flag',
        next: null,
        inputs: { STEPS: [1, [4, '10']] },
      },
    }
    const sb3Path = join(artifactRoot, 'default-id-blocks.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).blocks.flag?.opcode === 'event_whenflagclicked')
    expect(selectedTarget(await snapshot(currentPage)).blocks.move?.opcode).toBe('motion_movesteps')
  }, 30000)

  it('keeps loaded procedure arguments and shadow value blocks through workspace sync', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.total = ['total', 0]
    sprite.blocks = {
      flag: { opcode: 'event_whenflagclicked', next: 'callAdd', topLevel: true, x: 32, y: 32 },
      callAdd: {
        opcode: 'procedures_call',
        parent: 'flag',
        mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]' },
        inputs: { arg1: [1, [4, '5']] },
      },
      definition: { opcode: 'procedures_definition', next: 'changeTotal', topLevel: true, x: 32, y: 160, inputs: { custom_block: [1, 'prototype'] } },
      prototype: {
        opcode: 'procedures_prototype',
        parent: 'definition',
        shadow: true,
        mutation: { proccode: 'add %n', argumentids: '["arg1"]', argumentnames: '["amount"]', argumentdefaults: '["1"]', warp: 'false' },
      },
      changeTotal: { opcode: 'data_changevariableby', parent: 'definition', fields: { VARIABLE: ['total', 'total'] }, inputs: { VALUE: [2, 'amountReporter'] } },
      amountReporter: { opcode: 'argument_reporter_string_number', parent: 'changeTotal', fields: { VALUE: ['amount'] } },
    }
    const sb3Path = join(artifactRoot, 'procedure-argument-roundtrip.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).blocks.callAdd?.opcode === 'procedures_call')
    await currentPage.waitForFunction(() => Boolean(window.__hikkakuEditorTest?.workspaceBlocks().prototype))
    const callText = await currentPage.locator('.blocklyWorkspace .blocklyDraggable[data-id="callAdd"] .blocklyText').allTextContents()
    expect(callText.join(' ')).toContain('add')
    expect(callText.join(' ')).not.toContain('%n')
    const synced = await currentPage.evaluate(() => window.__hikkakuEditorTest!.syncWorkspace())
    const blocks = selectedTarget(synced).blocks
    expect(blocks.callAdd?.mutation?.proccode).toBe('add %n')
    expect(blocks.callAdd?.inputs?.arg1).toEqual([1, [4, '5']])
    expect(blocks.prototype?.shadow).toBe(true)
    expect(blocks.prototype?.mutation?.argumentnames).toBe('["amount"]')
    expect(blocks.amountReporter?.fields?.VALUE).toEqual(['amount'])
  }, 30000)

  it('does not render procedure prototype argument shadows as loose workspace blocks', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      definition: { opcode: 'procedures_definition', topLevel: true, x: 32, y: 160, inputs: { custom_block: [1, 'prototype'] } },
      prototype: {
        opcode: 'procedures_prototype',
        parent: 'definition',
        shadow: true,
        mutation: { proccode: 'draw skyscraper %n %n %n', argumentids: '["input0","input1","input2"]', argumentnames: '["windows?","distance?","style?"]', argumentdefaults: '[1,1,1]', warp: 'true' },
      },
      prototypeArg0: { opcode: 'argument_reporter_string_number', parent: 'prototype', fields: { VALUE: ['windows?', null] }, shadow: true, topLevel: false },
      prototypeArg1: { opcode: 'argument_reporter_string_number', parent: 'prototype', fields: { VALUE: ['distance?', null] }, shadow: true, topLevel: false },
      prototypeArg2: { opcode: 'argument_reporter_string_number', parent: 'prototype', fields: { VALUE: ['style?', null] }, shadow: true, topLevel: false },
    }
    const sb3Path = join(artifactRoot, 'procedure-prototype-argument-shadows.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await currentPage.waitForFunction(() => Boolean(window.__hikkakuEditorTest?.workspaceBlocks().prototype))
    const loosePrototypeArgs = await currentPage.locator('.blocklyWorkspace .blocklyDraggable[data-id^="prototypeArg"]').count()
    expect(loosePrototypeArgs).toBe(0)
    const synced = await currentPage.evaluate(() => window.__hikkakuEditorTest!.syncWorkspace())
    const blocks = selectedTarget(synced).blocks
    expect(blocks.prototypeArg0?.parent).toBe('prototype')
    expect(blocks.prototypeArg1?.fields?.VALUE?.[0]).toBe('distance?')
    expect(blocks.prototypeArg2?.shadow).toBe(true)
  }, 30000)

  it('connects numeric pen colour expressions from imported projects', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.blocks = {
      penColor: { opcode: 'pen_setPenColorToColor', topLevel: true, x: 32, y: 32, inputs: { COLOR: [3, 'rgbSum', [9, '#990000']] } },
      rgbSum: { opcode: 'operator_add', parent: 'penColor', inputs: { NUM1: [3, 'redPart', [4, 10]], NUM2: [3, 'bluePart', [4, 10]] } },
      redPart: { opcode: 'operator_multiply', parent: 'rgbSum', inputs: { NUM1: [1, [4, 150]], NUM2: [1, [4, 65536]] } },
      bluePart: { opcode: 'operator_multiply', parent: 'rgbSum', inputs: { NUM1: [1, [4, 150]], NUM2: [1, [4, 1]] } },
    }
    const sb3Path = join(artifactRoot, 'numeric-pen-colour-expression.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await currentPage.waitForFunction(() => Boolean(window.__hikkakuEditorTest?.workspaceBlocks().rgbSum))
    const looseRgbExpressions = await currentPage.locator('.blocklyWorkspace .blocklyDraggable[data-id="rgbSum"], .blocklyWorkspace .blocklyDraggable[data-id="redPart"], .blocklyWorkspace .blocklyDraggable[data-id="bluePart"]').evaluateAll((nodes) =>
      nodes.filter((node) => !node.closest('[data-id="penColor"]')).length
    )
    expect(looseRgbExpressions).toBe(0)
    const blocks = await currentPage.evaluate(() => window.__hikkakuEditorTest!.workspaceBlocks())
    expect(blocks.penColor?.inputs?.COLOR?.[1]).toBe('rgbSum')
    expect(blocks.rgbSum?.inputs?.NUM1?.[1]).toBe('redPart')
  }, 30000)

  it('rebuilds loaded value inputs as connected Blockly blocks instead of plain fields', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.flipnow = ['flipnow?', 'false']
    sprite.lists.items = ['items', ['a']]
    sprite.blocks = {
      click: { opcode: 'event_whenthisspriteclicked', next: 'if', topLevel: true, x: 32, y: 32 },
      equalsList: { opcode: 'operator_equals', topLevel: true, x: 420, y: 32, inputs: { OPERAND1: [1, [13, 'items', 'items']], OPERAND2: [1, [10, 'a']] } },
      if: { opcode: 'control_if', parent: 'click', inputs: { CONDITION: [2, 'notCostume'], SUBSTACK: [2, 'setPrev'] } },
      notCostume: { opcode: 'operator_not', parent: 'if', inputs: { OPERAND: [2, 'equalsCostume'] } },
      equalsCostume: { opcode: 'operator_equals', parent: 'notCostume', inputs: { OPERAND1: [2, 'costumeMinusOne'], OPERAND2: [1, [4, '1']] } },
      costumeMinusOne: { opcode: 'operator_subtract', parent: 'equalsCostume', inputs: { NUM1: [2, 'costumeNumber'], NUM2: [1, [4, '1']] } },
      costumeNumber: { opcode: 'looks_costumenumbername', parent: 'costumeMinusOne', fields: { NUMBER_NAME: ['number'] } },
      setPrev: { opcode: 'data_setvariableto', parent: 'if', next: 'setFlag', fields: { VARIABLE: ['flip,prev,next', 'flipnow'] }, inputs: { VALUE: [2, 'prevText'] } },
      prevText: { opcode: 'text', parent: 'setPrev', shadow: true, fields: { TEXT: ['prev'] } },
      setFlag: { opcode: 'data_setvariableto', parent: 'setPrev', next: 'switchCostume', fields: { VARIABLE: ['flipnow?', 'flipnow'] }, inputs: { VALUE: [1, [10, 'true']] } },
      switchCostume: { opcode: 'looks_switchcostumeto', parent: 'setFlag', next: 'waitUntil', inputs: { COSTUME: [2, 'costumeMenu'] } },
      costumeMenu: { opcode: 'looks_costume', parent: 'switchCostume', shadow: true, fields: { COSTUME: ['costume1'] } },
      waitUntil: { opcode: 'control_wait_until', parent: 'switchCostume', next: 'broadcast', inputs: { CONDITION: [2, 'notFlag'] } },
      notFlag: { opcode: 'operator_not', parent: 'waitUntil', inputs: { OPERAND: [2, 'equalsFlag'] } },
      equalsFlag: { opcode: 'operator_equals', parent: 'notFlag', inputs: { OPERAND1: [2, 'flagVar'], OPERAND2: [1, [10, 'true']] } },
      flagVar: { opcode: 'data_variable', parent: 'equalsFlag', fields: { VARIABLE: ['flipnow?', 'flipnow'] } },
      broadcast: { opcode: 'event_broadcast', parent: 'waitUntil', inputs: { BROADCAST_INPUT: [2, 'broadcastMenu'] } },
      broadcastMenu: { opcode: 'event_broadcast_menu', parent: 'broadcast', shadow: true, fields: { BROADCAST_OPTION: ['frev', 'frev'] } },
    }
    const sb3Path = join(artifactRoot, 'nested-value-inputs.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await currentPage.waitForFunction(() => window.__hikkakuEditorTest?.workspaceConnections?.().equalsCostume?.OPERAND1 === 'costumeMinusOne')
    const connections = await currentPage.evaluate(() => window.__hikkakuEditorTest!.workspaceConnections())
    expect(connections.equalsCostume?.OPERAND1).toBe('costumeMinusOne')
    expect(connections.costumeMinusOne?.NUM1).toBe('costumeNumber')
    expect(connections.switchCostume?.COSTUME).toBe('costumeMenu')
    expect(connections.broadcast?.BROADCAST_INPUT).toBe('broadcastMenu')
    const blocks = await currentPage.evaluate(() => window.__hikkakuEditorTest!.workspaceBlocks())
    expect(typeof blocks.equalsList?.inputs?.OPERAND1?.[1]).toBe('string')
    const listReporterId = blocks.equalsList?.inputs?.OPERAND1?.[1] as string
    expect(blocks[listReporterId]?.opcode).toBe('data_listcontents')
  }, 30000)

  it('keeps Scratch broadcast literals from imported projects as broadcast menu shadows', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const fixturePath = join(root, '..', '..', '..', 'Scratch Week Comics (FEATURED).sb3')
    expect(existsSync(fixturePath)).toBe(true)
    await currentPage.getByTestId('project-file-input').setInputFiles(fixturePath)
    await currentPage.getByTestId('target-card-Page2').click()
    await currentPage.waitForFunction(() => {
      const blocks = window.__hikkakuEditorTest?.workspaceBlocks?.() ?? {}
      return Object.values(blocks).some((block) => block.opcode === 'event_broadcast' && block.inputs?.BROADCAST_INPUT?.[1]?.[1] === 'npage')
    })
    const broadcast = await currentPage.evaluate(() => {
      const blocks = window.__hikkakuEditorTest!.workspaceBlocks()
      return Object.values(blocks).find((block) => block.opcode === 'event_broadcast' && block.inputs?.BROADCAST_INPUT?.[1]?.[1] === 'npage')
    })
    expect(broadcast?.inputs?.BROADCAST_INPUT).toEqual([1, [11, 'npage', '?JrUh]BTyiuj,KuW6bEF']])
    const variableCompare = await currentPage.evaluate(() => {
      const blocks = window.__hikkakuEditorTest!.workspaceBlocks()
      return Object.values(blocks).find((block) => {
        const input = block.inputs?.OPERAND1
        if (input?.[1]?.[1] === 'flipnow?') return true
        const childId = typeof input?.[1] === 'string' ? input[1] : undefined
        return childId ? blocks[childId]?.opcode === 'data_variable' && blocks[childId]?.fields?.VARIABLE?.[0] === 'flipnow?' : false
      })
    })
    expect(variableCompare).toBeTruthy()
    const variableFieldClasses = await currentPage.evaluate(() => {
      return [...document.querySelectorAll('g.operator_equals text')]
        .filter((node) => node.textContent?.trim() === 'flipnow?')
        .map((node) => node.parentElement?.getAttribute('class') ?? '')
    })
    expect(variableFieldClasses).toContain('blocklyLabelField')
    expect(variableFieldClasses.some((className) => className.includes('blocklyTextInputField'))).toBe(false)
  }, 30000)

  it('does not leave duplicate literal reporter blocks floating after importing nested inputs', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const fixturePath = join(root, '..', '..', '..', 'Utah Teapot by Codex.sb3')
    expect(existsSync(fixturePath)).toBe(true)
    await currentPage.getByTestId('project-file-input').setInputFiles(fixturePath)
    await currentPage.getByTestId('target-card-renderer').click()
    await currentPage.waitForFunction(() => {
      const blocks = window.__hikkakuEditorTest?.workspaceBlocks?.() ?? {}
      return Object.values(blocks).some((block) => block.opcode === 'control_for_each')
    })

    const looseReporters = await currentPage.evaluate(() => {
      const blocks = window.__hikkakuEditorTest!.workspaceBlocks()
      return Object.values(blocks)
        .filter((block) => block.topLevel && (block.opcode === 'data_variable' || block.opcode === 'data_listcontents'))
        .map((block) => block.fields?.VARIABLE?.[0] ?? block.fields?.LIST?.[0] ?? block.opcode)
    })
    expect(looseReporters).toEqual([])
    const penColorState = await currentPage.evaluate(() => {
      const blocks = window.__hikkakuEditorTest!.workspaceBlocks()
      const penColorBlock = Object.values(blocks).find((block) => block.opcode === 'pen_setPenColorToColor')
      const looseColorLiterals = Object.values(blocks)
        .filter((block) => block.topLevel && (block.opcode === 'text' || block.opcode === 'colour_picker'))
        .map((block) => block.fields?.TEXT?.[0] ?? block.fields?.COLOUR?.[0] ?? block.opcode)
      return { input: penColorBlock?.inputs?.COLOR, looseColorLiterals }
    })
    expect(penColorState.input).toEqual([1, [9, '#f97316']])
    expect(penColorState.looseColorLiterals).not.toContain('#f97316')
  }, 30000)

  it('loads a large Rubik project workspace without timing out', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const fixturePath = join(root, '..', '..', '..', 'ルービックキューブ.sb3')
    expect(existsSync(fixturePath)).toBe(true)
    await currentPage.getByTestId('project-file-input').setInputFiles(fixturePath)
    await currentPage.getByTestId('target-card-renderer').click()
    await currentPage.waitForFunction(() => {
      const blocks = window.__hikkakuEditorTest?.workspaceBlocks?.() ?? {}
      return Object.keys(blocks).length >= 1000
    }, null, { timeout: 15000 })
    const { blockCount, penTransparency } = await currentPage.evaluate(() => {
      const blocks = window.__hikkakuEditorTest!.workspaceBlocks()
      const penTransparency = Object.values(blocks).find((block) => block.opcode === 'pen_setPenColorParamTo' && block.inputs?.VALUE?.[1]?.[1] === 'edgeTransparency')
      return { blockCount: Object.keys(blocks).length, penTransparency }
    })
    expect(blockCount).toBeGreaterThanOrEqual(1000)
    expect(penTransparency).toBeTruthy()
  }, 30000)

  it('roundtrips Scratch-compatible value shadows and keeps direct dropdowns as fields', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.variables.score = ['score', 0]
    sprite.lists.items = ['items', []]
    sprite.blocks = {
      move: { opcode: 'motion_movesteps', topLevel: true, x: 32, y: 32, inputs: { STEPS: [1, [4, '10']] } },
      say: { opcode: 'looks_sayforsecs', topLevel: true, x: 32, y: 96, inputs: { MESSAGE: [1, [10, 'Hello!']], SECS: [1, [4, '2']] } },
      touchColor: { opcode: 'sensing_touchingcolor', topLevel: true, x: 32, y: 168, inputs: { COLOR: [1, [9, '#4c97ff']] } },
      equals: { opcode: 'operator_equals', topLevel: true, x: 32, y: 240, inputs: { OPERAND1: [1, [10, '']], OPERAND2: [1, [10, '50']] } },
      waitUntil: { opcode: 'control_wait_until', topLevel: true, x: 32, y: 312, inputs: {} },
      setScore: { opcode: 'data_setvariableto', topLevel: true, x: 300, y: 32, fields: { VARIABLE: ['score', 'score'] }, inputs: { VALUE: [1, [10, '0']] } },
      addItem: { opcode: 'data_addtolist', topLevel: true, x: 300, y: 96, fields: { LIST: ['items', 'items'] }, inputs: { ITEM: [1, [10, 'thing']] } },
      rotation: { opcode: 'motion_setrotationstyle', topLevel: true, x: 300, y: 168, fields: { STYLE: ['left-right'] } },
      glide: { opcode: 'motion_glideto', topLevel: true, x: 560, y: 32, inputs: { SECS: [1, [4, '1']], TO: [1, 'glideMenu'] } },
      glideMenu: { opcode: 'motion_glideto_menu', parent: 'glide', shadow: true, fields: { TO: ['_random_'] } },
      distance: { opcode: 'sensing_distanceto', topLevel: true, x: 560, y: 96, inputs: { DISTANCETOMENU: [1, 'distanceMenu'] } },
      distanceMenu: { opcode: 'sensing_distancetomenu', parent: 'distance', shadow: true, fields: { DISTANCETOMENU: ['_mouse_'] } },
      key: { opcode: 'sensing_keypressed', topLevel: true, x: 560, y: 168, inputs: { KEY_OPTION: [1, 'keyMenu'] } },
      keyMenu: { opcode: 'sensing_keyoptions', parent: 'key', shadow: true, fields: { KEY_OPTION: ['space'] } },
    }
    const sb3Path = join(artifactRoot, 'scratch-value-shadow-roundtrip.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await currentPage.waitForFunction(() => window.__hikkakuEditorTest?.workspaceBlocks?.().move?.opcode === 'motion_movesteps')
    const blocks = await currentPage.evaluate(() => window.__hikkakuEditorTest!.workspaceBlocks())
    expect(blocks.move?.inputs?.STEPS).toEqual([1, [4, '10']])
    expect(blocks.say?.inputs?.MESSAGE).toEqual([1, [10, 'Hello!']])
    expect(blocks.say?.inputs?.SECS).toEqual([1, [4, '2']])
    expect(blocks.touchColor?.inputs?.COLOR).toEqual([1, [9, '#4c97ff']])
    expect(blocks.equals?.inputs?.OPERAND1).toEqual([1, [10, '']])
    expect(blocks.waitUntil?.inputs?.CONDITION).toBeUndefined()
    expect(blocks.setScore?.inputs?.VALUE).toEqual([1, [10, '0']])
    expect(blocks.addItem?.inputs?.ITEM).toEqual([1, [10, 'thing']])
    expect(blocks.rotation?.fields?.STYLE).toEqual(['left-right'])
    expect(blocks.rotation?.inputs?.STYLE).toBeUndefined()
    expect(blocks.glide?.inputs?.TO).toEqual([1, 'glideMenu'])
    expect(blocks.glideMenu?.opcode).toBe('motion_glideto_menu')
    expect(blocks.distance?.inputs?.DISTANCETOMENU).toEqual([1, 'distanceMenu'])
    expect(blocks.distanceMenu?.opcode).toBe('sensing_distancetomenu')
    expect(blocks.key?.inputs?.KEY_OPTION).toEqual([1, 'keyMenu'])
    expect(blocks.keyMenu?.opcode).toBe('sensing_keyoptions')
  }, 30000)

  it('runs a stack when a workspace block is clicked with the worker runtime attached', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.x = 0
    sprite.y = 0
    sprite.blocks = {
      move: { opcode: 'motion_movesteps', topLevel: true, x: 96, y: 96, inputs: { STEPS: [1, [4, '10']] } },
    }
    const sb3Path = join(artifactRoot, 'workspace-block-click-runs.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    await currentPage.waitForFunction(() => window.__hikkakuEditorTest?.workspaceBlocks?.().move?.opcode === 'motion_movesteps')
    await currentPage.locator('.blocklyWorkspace .blocklyDraggable[data-id="move"] .blocklyPath').first().click({ position: { x: 12, y: 12 } })
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).x === 10)
  }, 30000)

  it('starts when-this-sprite-clicked hats from a stage click', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    const project = createDefaultProject()
    const sprite = project.targets[1]!
    sprite.costumes = [{ name: 'fallback', dataFormat: 'svg', rotationCenterX: 48, rotationCenterY: 48 }]
    sprite.variables.hit = ['hit', 0]
    sprite.blocks = {
      clickHat: { opcode: 'event_whenthisspriteclicked', next: 'setHit', topLevel: true, x: 32, y: 32 },
      setHit: { opcode: 'data_setvariableto', parent: 'clickHat', fields: { VARIABLE: ['hit', 'hit'] }, inputs: { VALUE: [1, [4, '1']] } },
    }
    const sb3Path = join(artifactRoot, 'sprite-click-hat.sb3')
    writeFileSync(sb3Path, zipSync({ 'project.json': strToU8(JSON.stringify(project)) }))

    await currentPage.getByTestId('project-file-input').setInputFiles(sb3Path)
    const stage = currentPage.getByTestId('stage-canvas')
    await stage.click({ position: { x: 280, y: 140 } })
    expect(selectedTarget(await snapshot(currentPage)).variables.hit?.[1]).toBe(0)
    await stage.click({ position: { x: 240, y: 180 } })
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).variables.hit?.[1] === '1')
  }, 30000)

  it('reorders sprites, costumes, and sounds through browser drag and drop', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByLabel('Add sprite').click()
    await waitForSnapshot(currentPage, (state) => spriteNames(state).includes('Sprite2'))
    await dragTestId(currentPage, 'target-card-Sprite2', 'target-card-Sprite1')
    await waitForSnapshot(currentPage, (state) => spriteNames(state)[0] === 'Sprite2')

    await currentPage.getByTestId('target-card-Sprite1').click()
    await currentPage.getByTestId('main-tab-costumes').click()
    await currentPage.getByLabel('Add costume').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).costumes.length >= 2)
    await dragTestId(currentPage, 'costume-card-1', 'costume-card-0')
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).costumes[0]?.name === 'costume2')

    await currentPage.getByTestId('asset-tab-sounds').click()
    await currentPage.getByLabel('Add sound').click()
    await currentPage.getByLabel('Add sound').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).sounds.length >= 2)
    await dragTestId(currentPage, 'sound-card-1', 'sound-card-0')
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).sounds[0]?.name === 'sound2')
  }, 30000)

  it('exercises deep paint and sound operations in the browser', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByTestId('main-tab-costumes').click()
    await currentPage.getByTestId('vector-shape-rect').click()
    await currentPage.getByTestId('save-vector-costume').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).costumes[0]?.dataFormat === 'svg')
    const vectorCostume = selectedTarget(await snapshot(currentPage)).costumes[0]
    expect(vectorCostume.md5ext?.endsWith('.svg')).toBe(true)

    await currentPage.getByTestId('bitmap-tool-brush').click()
    const canvas = currentPage.getByTestId('bitmap-editor-canvas')
    const box = await canvas.boundingBox()
    if (!box) throw new Error('Missing bitmap editor canvas bounds')
    await currentPage.mouse.move(box.x + 32, box.y + 32)
    await currentPage.mouse.down()
    await currentPage.mouse.move(box.x + 150, box.y + 96, { steps: 8 })
    await currentPage.mouse.up()
    await currentPage.getByTestId('save-bitmap-costume').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).costumes[0]?.dataFormat === 'png')
    const bitmapCostume = selectedTarget(await snapshot(currentPage)).costumes[0]
    expect(bitmapCostume.md5ext?.endsWith('.png')).toBe(true)

    await currentPage.getByTestId('asset-tab-sounds').click()
    await currentPage.getByTestId('generate-tone').click()
    await waitForSnapshot(currentPage, (state) => (selectedTarget(state).sounds[0]?.sampleCount ?? 0) > 0)
    const toneSamples = selectedTarget(await snapshot(currentPage)).sounds[0]?.sampleCount ?? 0
    await currentPage.getByTestId('sound-effect-reverse').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).sounds[0]?.sampleCount === toneSamples)
    await currentPage.getByTestId('sound-effect-louder').click()
    await waitForSnapshot(currentPage, (state) => selectedTarget(state).sounds[0]?.sampleCount === toneSamples)
    await currentPage.getByTestId('sound-effect-faster').click()
    await waitForSnapshot(currentPage, (state) => (selectedTarget(state).sounds[0]?.sampleCount ?? toneSamples) < toneSamples)
  }, 30000)

  it('closes library modals with escape and browser back', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByTestId('open-sprite-library').click()
    await expectVisibleDialog(currentPage, 'sprite library')
    await currentPage.keyboard.press('Escape')
    await waitForNoDialogs(currentPage)

    await currentPage.getByTestId('open-sprite-library').click()
    await expectVisibleDialog(currentPage, 'sprite library')
    await currentPage.goBack({ waitUntil: 'networkidle' })
    await waitForNoDialogs(currentPage)

    await currentPage.getByTestId('open-sprite-library').click()
    await expectVisibleDialog(currentPage, 'sprite library')
    await currentPage.getByLabel('Search library').fill('Robot')
    await currentPage.getByTestId('library-item-Robot').click()
    await waitForSnapshot(currentPage, (state) => spriteNames(state).some((name) => name.includes('Robot')))
  }, 30000)

  it('shows the requested library category instead of stale costume items', async () => {
    const currentPage = requirePage()
    await currentPage.setViewportSize({ width: 1280, height: 800 })
    await currentPage.goto(baseUrl, { waitUntil: 'networkidle' })
    await currentPage.getByTestId('stage-canvas').waitFor({ state: 'visible' })

    await currentPage.getByTestId('main-tab-sounds').click()
    await currentPage.getByTestId('open-sound-library').click()
    await expectVisibleDialog(currentPage, 'sound library')
    await currentPage.getByTestId('library-item-A Bass').waitFor({ state: 'visible' })
    expect(await currentPage.getByTestId('library-item-Abby-a').count()).toBe(0)
    await currentPage.keyboard.press('Escape')
    await waitForNoDialogs(currentPage)

    await currentPage.getByTestId('main-tab-code').click()
    await currentPage.getByTestId('open-extension-library').click()
    await expectVisibleDialog(currentPage, 'extension library')
    await currentPage.getByTestId('library-item-Pen').waitFor({ state: 'visible' })
    expect(await currentPage.getByTestId('library-item-Abby-a').count()).toBe(0)
    await currentPage.keyboard.press('Escape')
    await waitForNoDialogs(currentPage)
  }, 30000)
})

const requirePage = (): Page => {
  if (!page) throw new Error('Browser page was not initialized')
  return page
}

const waitForServer = async (): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 15000) {
    try {
      const response = await fetch(baseUrl)
      if (response.ok) return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('Timed out waiting for Vite preview server')
}

const snapshot = async (targetPage: Page): Promise<EditorSnapshot> =>
  targetPage.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { snapshot: () => EditorSnapshot } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    return api.snapshot()
  })

const selectedTab = async (targetPage: Page): Promise<string> =>
  targetPage.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { selectedTab: () => string } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    return api.selectedTab()
  })

const editorStatus = async (targetPage: Page): Promise<string> =>
  targetPage.evaluate(() => {
    const api = (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest
    if (!api) throw new Error('Missing __hikkakuEditorTest API')
    return api.status()
  })

const waitForSnapshot = async (targetPage: Page, predicate: (state: EditorSnapshot) => boolean): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (predicate(await snapshot(targetPage))) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out waiting for editor snapshot. Last state: ${JSON.stringify(await snapshot(targetPage))}`)
}

const waitForStatus = async (targetPage: Page, predicate: (status: string) => boolean): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    const value = await targetPage.evaluate(() => {
      const api = (window as unknown as { __hikkakuEditorTest?: { status: () => string } }).__hikkakuEditorTest
      if (!api) throw new Error('Missing __hikkakuEditorTest API')
      return api.status()
    })
    if (predicate(value)) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for editor status')
}

const expectVisibleDialog = async (targetPage: Page, name: string): Promise<void> => {
  const dialog = targetPage.getByRole('dialog', { name })
  await dialog.waitFor({ state: 'visible' })
  expect(await dialog.count()).toBe(1)
}

const waitForNoDialogs = async (targetPage: Page): Promise<void> => {
  const started = Date.now()
  while (Date.now() - started < 5000) {
    if (await pageDialogCount(targetPage) === 0) return
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for dialogs to close')
}

const pageDialogCount = (targetPage: Page): Promise<number> => targetPage.getByRole('dialog').count()

const nonWhiteStagePixelCount = async (targetPage: Page): Promise<number> =>
  targetPage.getByTestId('stage-canvas').evaluate((canvas) => {
    const stage = canvas as HTMLCanvasElement
    const readWebglPixels = (contextId: 'webgl' | 'webgl2'): Uint8Array | undefined => {
      const gl = stage.getContext(contextId, { preserveDrawingBuffer: true }) as WebGLRenderingContext | WebGL2RenderingContext | null
      if (!gl) return undefined
      const pixels = new Uint8Array(stage.width * stage.height * 4)
      gl.readPixels(0, 0, stage.width, stage.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      return pixels
    }
    const context = stage.getContext('2d')
    const data =
      context?.getImageData(0, 0, stage.width, stage.height).data
      ?? readWebglPixels('webgl2')
      ?? readWebglPixels('webgl')
    if (!data) return 0
    let count = 0
    for (let index = 0; index < data.length; index += 4) {
      const alpha = data[index + 3] ?? 0
      const red = data[index] ?? 255
      const green = data[index + 1] ?? 255
      const blue = data[index + 2] ?? 255
      if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) count += 1
    }
    return count
  })

const stageCanvasMetrics = async (targetPage: Page): Promise<StageCanvasMetrics> =>
  targetPage.getByTestId('stage-canvas').evaluate((canvas) => {
    const stage = canvas as HTMLCanvasElement
    const rect = stage.getBoundingClientRect()
    const readWebglPixels = (contextId: 'webgl' | 'webgl2'): Uint8Array | undefined => {
      const gl = stage.getContext(contextId, { preserveDrawingBuffer: true }) as WebGLRenderingContext | WebGL2RenderingContext | null
      if (!gl) return undefined
      const pixels = new Uint8Array(stage.width * stage.height * 4)
      gl.readPixels(0, 0, stage.width, stage.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
      return pixels
    }
    const context = stage.getContext('2d')
    const data =
      context?.getImageData(0, 0, stage.width, stage.height).data
      ?? readWebglPixels('webgl2')
      ?? readWebglPixels('webgl')
    let nonWhitePixels = 0
    if (data) {
      for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3] ?? 0
        const red = data[index] ?? 255
        const green = data[index + 1] ?? 255
        const blue = data[index + 2] ?? 255
        if (alpha > 0 && (red < 245 || green < 245 || blue < 245)) nonWhitePixels += 1
      }
    }
    return {
      backingWidth: stage.width,
      backingHeight: stage.height,
      clientWidth: rect.width,
      clientHeight: rect.height,
      aspect: rect.width / Math.max(1, rect.height),
      nonWhitePixels,
    }
  })

const expectStageMatrix = async (targetPage: Page): Promise<void> => {
  const metrics = await stageCanvasMetrics(targetPage)
  expect(metrics.backingWidth).toBe(480)
  expect(metrics.backingHeight).toBe(360)
  expect(Math.abs(metrics.aspect - 4 / 3)).toBeLessThan(0.03)
  expect(metrics.nonWhitePixels).toBeGreaterThan(25)
}

const dragTestId = async (targetPage: Page, fromTestId: string, toTestId: string): Promise<void> => {
  await targetPage.evaluate(({ fromTestId, toTestId }) => {
    const find = (testId: string): HTMLElement => {
      const element = document.querySelector(`[data-testid="${CSS.escape(testId)}"]`)
      if (!(element instanceof HTMLElement)) throw new Error(`Missing drag element ${testId}`)
      return element
    }
    const dataTransfer = new DataTransfer()
    const from = find(fromTestId)
    const to = find(toTestId)
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }))
    to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }))
    to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer }))
  }, { fromTestId, toTestId })
}

const spriteNames = (state: EditorSnapshot): string[] =>
  state.project.targets.filter((target) => !target.isStage && !target.isClone).map((target) => target.name)

const selectedTarget = (state: EditorSnapshot): EditorTarget => {
  const target = state.project.targets.find((candidate) => candidate.id === state.selectedTargetId || candidate.name === state.selectedTargetId)
  if (!target) throw new Error(`Missing selected target ${state.selectedTargetId}`)
  return target
}

interface EditorSnapshot {
  selectedTargetId: string
  project: {
    targets: EditorTarget[]
  }
}

interface EditorTarget {
  id?: string
  name: string
  isStage: boolean
  isClone?: boolean
  x?: number
  y?: number
  variables: Record<string, [string, unknown]>
  blocks: Record<string, EditorBlock>
  costumes: EditorCostume[]
  sounds: EditorSound[]
}

interface EditorBlock {
  opcode: string
  inputs?: Record<string, unknown>
  fields?: Record<string, unknown>
}

interface EditorCostume {
  name: string
  md5ext?: string
  dataFormat?: string
}

interface EditorSound {
  name: string
  md5ext?: string
  dataFormat?: string
  sampleCount?: number
}

interface StageCanvasMetrics {
  backingWidth: number
  backingHeight: number
  clientWidth: number
  clientHeight: number
  aspect: number
  nonWhitePixels: number
}
