import { XyoWorkerClient } from '../src/lib/xyo-worker-client'

/** Isolated E2E helper: use the real worker port and its copied pen batch. */
export async function runPenWorker(bytes: number[], maxSteps: number) {
  const client = new XyoWorkerClient(
    () => new Worker(new URL('./xyo-pen-worker.ts', import.meta.url), { type: 'module' }),
  )
  try {
    await client.loadSb3(new Uint8Array(bytes))
    await client.greenFlag()
    const frames: unknown[] = [await client.snapshot()]
    for (let i = 0; i < maxSteps; i++) {
      await client.step()
      frames.push(await client.snapshot())
    }
    return { frames, error: null }
  } catch (error) {
    return { frames: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    client.terminate()
  }
}
