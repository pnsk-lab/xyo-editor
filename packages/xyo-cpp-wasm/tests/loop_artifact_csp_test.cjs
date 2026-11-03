// Browser CSP verification against isolated build.sh artifacts.
// Usage: node loop_artifact_csp_test.cjs <isolated-package> <loop.sb3>
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {createRequire} = require('node:module');
const {chromium} = createRequire(path.resolve('packages/editor/package.json'))('playwright-core');
const pkg = path.resolve(process.argv[2]);
const data = fs.readFileSync(process.argv[3]).toString('base64');
const html = `<!doctype html><script src="/xyo-browser.js"></script><body><script>
(async () => { try {
 const m = await createXyoBrowser();
 const deny = location.search === '?deny';
 if (deny) { const c = document.createElement('meta'); c.httpEquiv = 'Content-Security-Policy'; c.content = "default-src 'self'; script-src 'self' 'unsafe-inline'"; document.head.appendChild(c); }
 if (typeof m._xyo_safe_jit_loop_experiment !== 'function') throw Error('missing opt-in export');
 m._xyo_safe_jit_loop_experiment(1);
 const b = Uint8Array.from(atob('${data}'), x => x.charCodeAt(0));
 const h = m._xyo_browser_create(), p = m._malloc(b.length); m.HEAPU8.set(b,p);
 if (!m._xyo_browser_load_sb3(h,p,b.length)) throw Error('load'); m._free(p);
 m._xyo_browser_set_compiled(h,1);
 const c = m._xyo_browser_compile_successes(), r = m._xyo_browser_compiled_executions();
 if (!m._xyo_browser_green_flag(h)) throw Error('flag');
 if (m._xyo_browser_compile_successes() !== c + (deny ? 0 : 1)) throw Error('CSP compile count');
 if (!m._xyo_browser_step(h)) throw Error('step');
 if (m._xyo_browser_compiled_executions() !== r + (deny ? 0 : 1)) throw Error('CSP execution count');
 m._xyo_browser_destroy(h); if (m._xyo_browser_compiled_live_modules()) throw Error('module leak');
 document.body.dataset.result = 'PASS';
 } catch(e) { console.error(e); document.body.dataset.result = 'FAIL'; } })();
</script></body>`;
(async () => {
 const server = http.createServer((req,res) => {
  if (req.url === '/' || req.url.startsWith('/?')) { res.setHeader('Content-Type','text/html'); return res.end(html); }
  if (req.url === '/favicon.ico') { res.statusCode=204; return res.end(); }
  if (!['/xyo-browser.js','/xyo-browser.wasm'].includes(req.url)) {res.statusCode=404; return res.end();}
  const file = path.join(pkg,'.work/build-wasm',path.basename(req.url));
  res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
  fs.createReadStream(file).on('error', () => {res.statusCode=404; res.end();}).pipe(res);
 });
 await new Promise(r => server.listen(0,'127.0.0.1',r));
 const executablePath = process.env.LOOP_BROWSER || chromium.executablePath();
 if (!fs.existsSync(executablePath)) throw Error(`Chromium not found: ${executablePath}; set LOOP_BROWSER`);
 const browser = await chromium.launch({executablePath, args:['--no-sandbox','--disable-dev-shm-usage']});
 try {
  for (const mode of ['allow','deny']) {
   const page = await browser.newPage(), logs=[];
   page.on('console', x => logs.push(x.type()+': '+x.text())); page.on('pageerror', x => logs.push('pageerror: '+x));
   await page.goto(`http://127.0.0.1:${server.address().port}/?${mode}`);
   await page.waitForFunction(() => document.body.dataset.result, null, {timeout:30000});
   const result = await page.locator('body').getAttribute('data-result');
   console.log('artifact', mode, result, logs.join('\n'));
   if (result !== 'PASS') throw Error(mode+' failed');
   await page.close();
  }
 } finally { await browser.close(); server.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
