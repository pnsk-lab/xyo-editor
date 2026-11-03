import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { strToU8, zipSync } from 'fflate'
import { chromium } from 'playwright-core'
import { launchBrowser } from './browser-launcher'

// Opt in: this downloads executable code from the pinned public CDN and requires
// Chromium with a working WebGL context. It is not an offline/unit test.
const networkTest = process.env.TURBOWARP_CDN_TEST === '1' ? it : it.skip
const src = join(import.meta.dir, '../src/lib')

describe('official TurboWarp Scaffolding browser integration', () => {
  networkTest(
    'loads a minimal SB3, runs green flag and converts the live snapshot',
    async () => {
      const build = await Bun.build({
        entrypoints: [
          'turbowarp-loader',
          'turbowarp-adapter',
          'turbowarp-snapshot',
          'turbowarp-engine',
        ].map((name) => join(src, `${name}.ts`)),
        target: 'browser',
        splitting: false,
      })
      if (!build.success) throw new Error(`Browser fixture build failed: ${build.logs.join('\n')}`)
      const bundles = new Map(
        await Promise.all(
          build.outputs.map(
            async (output) => [output.path.split('/').pop()!, await output.text()] as const,
          ),
        ),
      )
      const server = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch(request) {
          const name = new URL(request.url).pathname.slice(1)
          if (!name)
            return new Response(
              '<!doctype html><html><head></head><body><div id="stage"></div></body></html>',
              { headers: { 'content-type': 'text/html' } },
            )
          const bundle = bundles.get(name)
          return bundle
            ? new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
            : new Response('Not found', { status: 404 })
        },
      })
      let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
      try {
        browser = await launchBrowser({
          args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader'],
        })
        const page = await browser.newPage()
        await page.goto(`http://127.0.0.1:${server.port}/`)
        const webgl = await page.evaluate(
          () => !!document.createElement('canvas').getContext('webgl'),
        )
        if (!webgl)
          throw new Error(
            'WebGL is unavailable in this Chromium environment; the official renderer requires WebGL',
          )
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
        const costume = {
          name: 'costume',
          assetId: '12345678901234567890123456789012',
          md5ext: '12345678901234567890123456789012.svg',
          dataFormat: 'svg',
          rotationCenterX: 5,
          rotationCenterY: 5,
        }
        const project = {
          targets: [
            {
              isStage: true,
              name: 'Stage',
              variables: {},
              lists: {},
              broadcasts: {},
              blocks: {},
              comments: {},
              currentCostume: 0,
              costumes: [costume],
              sounds: [],
              volume: 100,
              layerOrder: 0,
              tempo: 60,
              videoTransparency: 50,
              videoState: 'on',
            },
            {
              isStage: false,
              name: 'Sprite1',
              variables: {},
              lists: {},
              broadcasts: {},
              blocks: {
                flag: {
                  opcode: 'event_whenflagclicked',
                  next: 'move',
                  parent: null,
                  inputs: {},
                  fields: {},
                  shadow: false,
                  topLevel: true,
                  x: 0,
                  y: 0,
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
              },
              comments: {},
              currentCostume: 0,
              costumes: [costume],
              sounds: [],
              volume: 100,
              layerOrder: 1,
              visible: true,
              x: 0,
              y: 0,
              size: 100,
              direction: 90,
              draggable: false,
              rotationStyle: 'all around',
            },
          ],
          monitors: [],
          extensions: [],
          meta: { semver: '3.0.0', vm: '0.2.0', agent: 'test' },
        }
        const sb3 = zipSync({
          'project.json': strToU8(JSON.stringify(project)),
          [costume.md5ext]: strToU8(svg),
        })
        const result = await page.evaluate(async (bytes) => {
          const { loadTurboWarpScaffolding, TURBOWARP_SCAFFOLDING_URL } =
            await import('/turbowarp-loader.js')
          const { TurboWarpAdapter } = await import('/turbowarp-adapter.js')
          const { turboWarpSnapshot } = await import('/turbowarp-snapshot.js')
          const namespace = await loadTurboWarpScaffolding()
          const adapter = new TurboWarpAdapter(namespace, document.querySelector('#stage')!)
          await adapter.loadProject(new Uint8Array(bytes))
          const before = turboWarpSnapshot(adapter.vm).project.targets.find(
            (t: any) => t.name === 'Sprite1',
          )
          adapter.greenFlag()
          const deadline = Date.now() + 10000
          let after
          do {
            await new Promise((resolve) => setTimeout(resolve, 50))
            after = turboWarpSnapshot(adapter.vm).project.targets.find(
              (t: any) => t.name === 'Sprite1',
            )
          } while (after?.x !== 25 && Date.now() < deadline)
          adapter.stopAll()
          const { createTurboWarpEngine } = await import('/turbowarp-engine.js')
          const canvas = document.createElement('canvas')
          document.body.appendChild(canvas)
          const engine = createTurboWarpEngine(namespace, canvas)
          const sameCanvas = engine.renderer.canvas === canvas
          await engine.vm.loadProject(new Uint8Array(bytes))
          const engineBefore = turboWarpSnapshot(engine.vm).project.targets.find(
            (t: any) => t.name === 'Sprite1',
          )?.x
          engine.vm.start()
          engine.vm.greenFlag()
          const engineDeadline = Date.now() + 10000
          let engineAfter
          do {
            await new Promise((resolve) => setTimeout(resolve, 50))
            engineAfter = turboWarpSnapshot(engine.vm).project.targets.find(
              (t: any) => t.name === 'Sprite1',
            )?.x
          } while (engineAfter !== 25 && Date.now() < engineDeadline)
          const gl = (engine.renderer as any).gl as WebGLRenderingContext
          await engine.dispose()
          await engine.dispose()
          return {
            url: TURBOWARP_SCAFFOLDING_URL,
            before,
            after,
            canvas: !!document.querySelector('#stage canvas'),
            renderer: !!adapter.renderer,
            sameCanvas,
            engineBefore,
            engineAfter,
            contextLost: gl.isContextLost(),
            audioState: engine.audioEngine?.audioContext.state,
          }
        }, Array.from(sb3))
        expect(result.url).toBe(
          'https://cdn.jsdelivr.net/npm/@turbowarp/packager@3.14.0/dist/scaffolding/scaffolding-full.js',
        )
        expect(result.canvas && result.renderer).toBe(true)
        expect(result.before?.x).toBe(0)
        expect(result.after?.x).toBe(25)
        expect(result.after?.y).toBe(0)
        expect(result.after?.blocks.flag.opcode).toBe('event_whenflagclicked')
        expect(result.after?.blocks.move.opcode).toBe('motion_changexby')
        expect(result.sameCanvas).toBe(true)
        expect(result.engineBefore).toBe(0)
        expect(result.engineAfter).toBe(25)
        expect(result.contextLost).toBe(true)
        if (result.audioState !== undefined) expect(result.audioState).toBe('closed')
      } finally {
        await browser?.close()
        server.stop(true)
      }
    },
    60_000,
  )
})
