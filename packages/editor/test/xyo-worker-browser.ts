import { XyoWorkerClient } from '../src/lib/xyo-worker-client'

function client() {
  return new XyoWorkerClient(
    () =>
      new Worker(new URL('../src/lib/xyo-worker-entry.ts', import.meta.url), { type: 'module' }),
  )
}

export async function exercise(bytes: number[]) {
  const vm = client()
  try {
    await vm.loadSb3(new Uint8Array(bytes))
    await vm.greenFlag()
    await vm.step()
    await vm.key('ArrowLeft', true, 37)
    await vm.mouse(120, 90, 480, 360, true, 0, false)
    await vm.wheel(2, -3)
    await vm.answer('はい😀')
    const snapshot = await vm.snapshot()
    const stats = await vm.stats()
    await vm.stop()
    await vm.dispose()
    const killed = client()
    const pending = killed.loadSb3(new Uint8Array(bytes)).then(
      () => 'resolved',
      (error: Error) => error.message,
    )
    killed.terminate()
    return { snapshot, stats, terminated: await pending }
  } catch (error) {
    vm.terminate()
    throw error
  }
}
