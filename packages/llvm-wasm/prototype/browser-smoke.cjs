// Standalone, loopback-only browser/Worker integration test; never runs IR.
const {createRequire} = require('node:module');
const {createServer} = require('node:http');
const {readFile} = require('node:fs/promises');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const editorRequire = createRequire(path.join(root, 'packages/editor/package.json'));
const {chromium} = editorRequire('playwright-core');
const prototype = path.join(root, 'packages/llvm-wasm/prototype');
const work = path.join(root, 'packages/llvm-wasm/.work');
const files = new Map([
  ['/packages/llvm-wasm/prototype/browser-smoke.html', [path.join(prototype, 'browser-smoke.html'), 'text/html']],
  ['/packages/llvm-wasm/prototype/browser-worker.js', [path.join(prototype, 'browser-worker.js'), 'text/javascript']],
  ['/packages/llvm-wasm/.work/prototype-build/xyo_browser_ir.js', [path.join(work, 'prototype-build/xyo_browser_ir.js'), 'text/javascript']],
  ['/packages/llvm-wasm/.work/prototype-build/xyo_browser_ir.wasm', [path.join(work, 'prototype-build/xyo_browser_ir.wasm'), 'application/wasm']],
  ...['valid', 'wait', 'two-hats'].map(name => [`/packages/llvm-wasm/.work/smoke-fixtures/${name}.sb3`, [path.join(work, `smoke-fixtures/${name}.sb3`), 'application/octet-stream']]),
]);
(async () => {
  const fixtures = spawnSync('python3', [path.join(prototype, 'smoke-fixture.py'), path.join(work, 'smoke-fixtures')], {stdio: 'inherit'});
  if (fixtures.error) throw fixtures.error;
  if (fixtures.status !== 0) throw Error(`fixture generation failed: ${fixtures.status}`);
  const server = createServer(async (req, res) => {
    const file = req.method === 'GET' ? files.get(new URL(req.url, 'http://127.0.0.1').pathname) : null;
    if (!file) { res.writeHead(404).end(); return; }
    try { const bytes = await readFile(file[0]); res.writeHead(200, {'Content-Type': file[1]}); res.end(bytes); }
    catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  let browser;
  try {
    const executablePath = process.env.BROWSER || process.env.CHROME_BIN || chromium.executablePath();
    browser = await chromium.launch({executablePath, headless: true});
    const page = await browser.newPage();
    page.on('pageerror', e => console.error('pageerror:', e));
    await page.goto(`http://127.0.0.1:${server.address().port}/packages/llvm-wasm/prototype/browser-smoke.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => document.querySelector('#result').textContent !== 'RUNNING', null, {timeout: 60000});
    const result = JSON.parse(await page.locator('#result').textContent());
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); }
    finally { await new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
