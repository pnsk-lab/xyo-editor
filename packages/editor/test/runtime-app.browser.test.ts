import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { spawn, type ChildProcess } from 'node:child_process'
import { type Browser, type BrowserContext, type Page } from 'playwright-core'
import { launchBrowser } from './browser-launcher'
import { strToU8, zipSync } from 'fflate'

const root = import.meta.dir.replace(/\/test$/, '')
const url = 'http://127.0.0.1:4178/test/runtime-app-fixture.html'
const key = 'hikkaku.runtime-backend'
let server: ChildProcess | undefined
let browser: Browser | undefined
let context: BrowserContext | undefined
let page: Page

describe('App runtime selection in the browser (offline fake backend)', () => {
  beforeAll(async () => {
    server = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4178', '--strictPort'], {
      cwd: root,
      stdio: 'ignore',
    })
    for (let attempt = 0; ; attempt++) {
      if (server.exitCode !== null) throw new Error(`Vite exited: ${server.exitCode}`)
      try {
        if ((await fetch(url)).ok) break
      } catch {
        /* waiting for Vite */
      }
      if (attempt === 100) throw new Error('Vite did not start')
      await Bun.sleep(100)
    }
    browser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    context = await browser.newContext()
    // Never access external services, even if the editor tries to load one.
    await context.route('**/*', (route) =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    )
    page = await context.newPage()
  }, 30_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    server?.kill()
  })

  it('explains and persists selection without reload, then applies it on the next load', async () => {
    await page.goto(url)
    await page.getByTestId('stage-canvas').waitFor()
    await page.evaluate(() => {
      ;(window as any).__sameDocument = 'still here'
    })
    await page.getByRole('button', { name: '設定', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '設定' })
    expect(
      await dialog
        .getByText(
          '変更は次回起動時に適用されます。現在の作業は続けられます。適用するにはプロジェクトを保存してから再読み込みしてください。',
        )
        .isVisible(),
    ).toBe(true)
    const select = dialog.getByLabel('ランタイムの選択')
    expect(await select.locator('option').allTextContents()).toEqual([
      '現行 VM（次回起動時）',
      'Fake VM（次回起動時）',
    ])
    expect(await select.inputValue()).toBe('scratch')
    let alertText = ''
    page.once('dialog', async (message) => {
      alertText = message.message()
      await message.accept()
    })
    await select.selectOption('fake')
    expect(alertText).toContain('次回起動時に適用します')
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe('fake')
    expect(await page.evaluate(() => (window as any).__sameDocument)).toBe('still here')
    expect(await page.evaluate(() => sessionStorage.getItem('fake-load-count'))).toBeNull()
    expect(await select.inputValue()).toBe('fake')
    await page.reload()
    await page.getByTestId('stage-canvas').waitFor()
    expect(await page.evaluate(() => sessionStorage.getItem('fake-load-count'))).toBe('1')
    await page.getByRole('button', { name: '設定', exact: true }).click()
    expect(
      await page.getByRole('dialog', { name: '設定' }).getByLabel('ランタイムの選択').inputValue(),
    ).toBe('fake')
  }, 30_000)

  it('falls back to the current VM when the saved runtime fails to load', async () => {
    await page.evaluate(() => sessionStorage.setItem('fake-load-fails', 'yes'))
    await page.reload()
    expect(await page.getByRole('alert').textContent()).toContain(
      '保存された実行環境を読み込めなかったため、現行 VM を使用します。',
    )
    await page.getByTestId('stage-canvas').waitFor()
    expect(await page.evaluate(() => sessionStorage.getItem('fake-load-count'))).toBe('2')
    expect(await page.evaluate((storageKey) => localStorage.getItem(storageKey), key)).toBe('fake')
    await page.getByRole('button', { name: '設定', exact: true }).click()
    expect(
      await page.getByRole('dialog', { name: '設定' }).getByLabel('ランタイムの選択').inputValue(),
    ).toBe('fake')
  }, 30_000)
})

const wasmSuite = process.env.XYO_CPP_WASM_BROWSER_TEST === '1' ? describe : describe.skip
wasmSuite('editor ask and wait (built-in VM; legacy xyo case skipped)', () => {
  let vite: ChildProcess | undefined
  let realBrowser: Browser | undefined
  const realUrl = 'http://127.0.0.1:4179/'
  beforeAll(async () => {
    vite = spawn('bun', ['x', 'vite', '--host', '127.0.0.1', '--port', '4179', '--strictPort'], {
      cwd: root,
      stdio: 'ignore',
    })
    for (let attempt = 0; ; attempt++) {
      if (vite.exitCode !== null) throw new Error(`Vite exited: ${vite.exitCode}`)
      try {
        if ((await fetch(realUrl)).ok) break
      } catch {
        /* waiting for Vite */
      }
      if (attempt === 100) throw new Error('Vite did not start')
      await Bun.sleep(100)
    }
    realBrowser = await launchBrowser({ args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  }, 30_000)
  afterAll(async () => {
    await realBrowser?.close()
    vite?.kill()
  })

  // The xyo-cpp selection now falls back to scratch; do not report that as
  // xyo coverage. Preserve the old case only as a skipped legacy reference.
  for (const backend of ['xyo-cpp', 'scratch'])
    (backend === 'xyo-cpp' ? it.skip : it)(
      `${backend}: question input resumes and stop closes`,
      async () => {
        const blocks = {
          hat: {
            opcode: 'event_whenflagclicked',
            next: 'ask',
            parent: null,
            inputs: {},
            fields: {},
            topLevel: true,
            x: 0,
            y: 0,
          },
          ask: {
            opcode: 'sensing_askandwait',
            next: 'set',
            parent: 'hat',
            inputs: { QUESTION: [1, [10, 'Your name?']] },
            fields: {},
          },
          set: {
            opcode: 'data_setvariableto',
            next: null,
            parent: 'ask',
            inputs: { VALUE: [2, 'answer'] },
            fields: { VARIABLE: ['result', 'v'] },
          },
          answer: { opcode: 'sensing_answer', next: null, parent: 'set', inputs: {}, fields: {} },
        }
        const project = {
          targets: [
            {
              isStage: true,
              name: 'Stage',
              variables: { v: ['result', 'waiting'] },
              lists: {},
              broadcasts: {},
              blocks,
              costumes: [],
              sounds: [],
              currentCostume: 0,
              volume: 100,
              layerOrder: 0,
            },
          ],
          monitors: [],
          extensions: [],
          meta: { semver: '3.0.0' },
        }
        const archive = zipSync({ 'project.json': strToU8(JSON.stringify(project)) })
        const context = await realBrowser!.newContext()
        try {
          await context.addInitScript((backend) => {
            localStorage.setItem('hikkaku.runtime-backend', backend)
            const post = Worker.prototype.postMessage
            ;(window as any).__keyMessages = []
            Worker.prototype.postMessage = function (message: any, ...rest: any[]) {
              if (message?.operation?.type === 'key')
                (window as any).__keyMessages.push(message.operation)
              if (message?.type === 'postKeyboard')
                (window as any).__keyMessages.push({
                  key: message.data.key,
                  down: message.data.isDown,
                })
              return (post as any).call(this, message, ...rest)
            } as typeof Worker.prototype.postMessage
          }, backend)
          await context.route('**/*', (route) =>
            new URL(route.request().url()).hostname === '127.0.0.1'
              ? route.continue()
              : route.abort(),
          )
          const p = await context.newPage()
          await p.goto(realUrl)
          await p.getByTestId('stage-canvas').waitFor()
          await p.getByTestId('project-file-input').setInputFiles({
            name: 'ask.sb3',
            mimeType: 'application/octet-stream',
            buffer: Buffer.from(archive),
          })
          await p.waitForFunction(() =>
            (window as any).__hikkakuEditorTest
              ?.snapshot()
              .project.targets.some((t: any) => t.variables.v?.[0] === 'result'),
          )
          await p.getByRole('button', { name: 'Green flag' }).click()
          const form = p.getByRole('form', { name: 'Question' })
          await form.getByText('Your name?').waitFor({ timeout: 30000 })
          expect(
            await form.getByLabel('Answer').evaluate((el) => el === document.activeElement),
          ).toBe(true)
          await p.keyboard.type('Alice')
          await p.keyboard.press('Enter')
          await p.waitForFunction(
            () =>
              (window as any).__hikkakuEditorTest
                .snapshot()
                .project.targets.some((t: any) => t.variables.v?.[1] === 'Alice'),
            null,
            { timeout: 30000 },
          )
          expect(await form.isVisible()).toBe(false)
          expect(await p.evaluate(() => (window as any).__keyMessages)).toEqual([])
          await p.getByTestId('stage-canvas').click()
          await p.keyboard.press('q')
          await p.waitForFunction(() => (window as any).__keyMessages.length >= 2)
          expect(
            await p.evaluate(() => (window as any).__keyMessages.map((m: any) => [m.key, m.down])),
          ).toEqual([
            ['q', true],
            ['q', false],
          ])
          await p.getByRole('button', { name: 'Green flag' }).click()
          await form.getByText('Your name?').waitFor({ timeout: 30000 })
          await p.getByRole('button', { name: 'Stop all' }).click()
          await form.waitFor({ state: 'hidden' })
        } finally {
          await context.close()
        }
      },
      60_000,
    )
})
