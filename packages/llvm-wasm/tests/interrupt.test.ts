import { expect, test } from 'bun:test';
import { LLVMWorkerClient, type WorkerLike } from '../src/client';
import { LLVMPipeline } from '../src/pipeline';
import type { WorkerRequest, WorkerResponse } from '../src/protocol';

// Fake transport only: does not execute real LLVM.
const wasm = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
class ControlledWorker implements WorkerLike {
  terminated = false;
  messages: WorkerRequest[] = [];
  listeners: Record<string, ((event: any) => void)[]> = {};
  postMessage(message: unknown) { this.messages.push(message as WorkerRequest); }
  terminate() { this.terminated = true; }
  addEventListener(type: string, listener: (event: any) => void) { (this.listeners[type] ??= []).push(listener); }
  reply(response: WorkerResponse) { for (const fn of this.listeners.message ?? []) fn({ data: response }); }
  succeed(index: number) {
    const message = this.messages[index]!;
    const path = message.request.tool === 'llc' ? 'output.o' : 'output.wasm';
    this.reply({ id: message.id, ok: true, result: { files: [{ path, data: path === 'output.o' ? new Uint8Array([1]) : wasm }], stdout: '', stderr: '' } });
  }
}
const options = { ir: '; fake', exports: ['main'] };
test('second compile terminates occupied worker and uses a new worker', async () => {
  const workers: ControlledWorker[] = [];
  const client = new LLVMWorkerClient(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
  const pipeline = new LLVMPipeline(client);
  const old = pipeline.compile(options);
  const latest = pipeline.compile(options);
  expect(workers[0]!.terminated).toBe(true);
  expect(workers).toHaveLength(2);
  await expect(old).rejects.toMatchObject({ stage: 'cancelled' });
  workers[0]!.succeed(0); // Late transport event cannot affect the new worker.
  workers[1]!.succeed(0);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  expect(workers[1]!.messages).toHaveLength(2);
  workers[1]!.succeed(1);
  await expect(latest).resolves.toMatchObject({ binary: wasm });
  pipeline.stop();
});
test('stop then restart stays safe against old completion and worker errors', async () => {
  const workers: ControlledWorker[] = [];
  const client = new LLVMWorkerClient(() => { const worker = new ControlledWorker(); workers.push(worker); return worker; });
  const pipeline = new LLVMPipeline(client);
  const old = pipeline.compile(options);
  pipeline.stop();
  expect(workers[0]!.terminated).toBe(true);
  client.restart();
  const current = pipeline.compile(options);
  await expect(old).rejects.toMatchObject({ stage: 'cancelled' });
  workers[0]!.succeed(0);
  const req = workers[1]!.messages[0]!;
  workers[1]!.reply({ id: req.id, ok: false, error: { message: 'compiler failed', stdout: '', stderr: 'details' } });
  await expect(current).rejects.toMatchObject({ stage: 'llc', diagnostics: { llc: { stderr: 'details' } } });
  expect(workers).toHaveLength(2); // finished error must not spuriously restart on the next request
  const next = pipeline.compile(options);
  expect(workers).toHaveLength(2);
  pipeline.stop();
  await expect(next).rejects.toMatchObject({ stage: 'cancelled' });
});
test('restart failure cancels old work and does not leave a phantom active compilation', async () => {
  let calls = 0;
  const worker = new ControlledWorker();
  const client = new LLVMWorkerClient(() => { if (calls++ > 0) throw Error('factory failed'); return worker; });
  const pipeline = new LLVMPipeline(client);
  const old = pipeline.compile(options);
  const replacement = pipeline.compile(options);
  const replacementCheck = expect(replacement).rejects.toMatchObject({ stage: 'llc', message: expect.stringContaining('restart failed') });
  expect(worker.terminated).toBe(true);
  await expect(old).rejects.toMatchObject({ stage: 'cancelled' });
  await replacementCheck;
  await expect(pipeline.compile(options)).rejects.toMatchObject({ stage: 'llc', message: 'Worker is stopped' });
  expect(calls).toBe(2);
});
