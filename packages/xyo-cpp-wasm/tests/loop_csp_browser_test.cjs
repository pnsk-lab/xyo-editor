// Test production-code wasm in real Chromium. The host wasm is instantiated
// before the deny CSP is installed; the policy then applies to generated wasm.
// Usage: node loop_csp_browser_test.cjs <directory-containing-browser-loop.js>
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {chromium} = createRequire(path.resolve('packages/editor/package.json'))('playwright-core');
const dir = path.resolve(process.argv[2]);
const html = `<!doctype html><meta charset="utf-8"><script src="/browser-loop.js"></script><script>
(async () => {
 try {
  const m = await createLoopTest({print: s => console.log(s), printErr: s => console.error(s)});
  const deny = location.search === '?deny';
  if (deny) {
   const c = document.createElement('meta'); c.httpEquiv = 'Content-Security-Policy';
   c.content = "default-src 'self'; script-src 'self' 'unsafe-inline'"; document.head.appendChild(c);
  }
  m.callMain([deny ? 'deny' : 'allow']);
  document.body.dataset.result = 'PASS';
 } catch(e) { console.error(e); document.body.dataset.result = 'FAIL'; }
})();</script><body></body>`;
(async () => {
 const server = http.createServer((req,res) => {
  if (req.url.startsWith('/?') || req.url === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
  if (req.url === '/favicon.ico') { res.statusCode = 204; return res.end(); }
  const file = path.join(dir, path.basename(req.url));
  if (!path.basename(file).startsWith('browser-loop.')) { res.statusCode = 404; return res.end(); }
  res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  fs.createReadStream(file).on('error', () => { res.statusCode=404; res.end(); }).pipe(res);
 });
 await new Promise(r => server.listen(0,'127.0.0.1',r));
 const executablePath = process.env.LOOP_BROWSER || chromium.executablePath();
 if (!fs.existsSync(executablePath)) throw Error(`Chromium not found: ${executablePath}; set LOOP_BROWSER`);
 const browser = await chromium.launch({executablePath, args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  for (const mode of ['allow','deny']) {
   const page = await browser.newPage();
   const messages = [];
   page.on('console', m => messages.push(m.type()+': '+m.text()));
   page.on('pageerror', e => messages.push('pageerror: '+e));
   await page.goto(`http://127.0.0.1:${server.address().port}/?${mode}`);
   await page.waitForFunction(() => document.body && document.body.dataset.result, null, {timeout:30000});
   const result = await page.locator('body').getAttribute('data-result');
   console.log(mode, result, messages.join('\n'));
   if (result !== 'PASS') throw Error(mode+' failed');
   await page.close();
  }
 } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });
