// Isolated end-to-end browser fixture. Executes only on a strict synthetic host, never a real xyo runtime.
const {createRequire} = require('node:module');
const {createServer} = require('node:http');
const {readFile, mkdir} = require('node:fs/promises');
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const editorRequire = createRequire(path.join(root, 'packages/editor/package.json'));
const {chromium} = editorRequire('playwright-core');
const pkg = path.join(root, 'packages/llvm-wasm'), work = path.join(pkg,'.work');
const tmp = path.join(work,'e2e-browser-fixture');
const fixture = path.join(work,'smoke-fixtures');
(async () => {
  await mkdir(tmp,{recursive:true});
  const run = (cmd,args) => { const p = spawnSync(cmd,args,{cwd:root,encoding:'utf8'}); if(p.error || p.status !== 0) throw Error(`${cmd}: ${p.error || p.stderr || p.stdout}`); };
  run('python3',[path.join(pkg,'prototype/smoke-fixture.py'),fixture]);
  for (const name of ['index','worker']) run('bun',['build',path.join(pkg,`src/${name}.ts`),'--target=browser','--outfile',path.join(tmp,`pipeline-${name}.mjs`)]);
  const file = (p,mime='text/javascript') => [p,mime];
  const routes = new Map([
    ['/',file(path.join(pkg,'prototype/e2e.html'),'text/html')],
    ['/e2e.js',file(path.join(pkg,'prototype/e2e.js'))],
    ['/e2e-ir-worker.js',file(path.join(pkg,'prototype/e2e-ir-worker.js'))],
    ['/fixture.sb3',file(path.join(fixture,'valid.sb3'),'application/octet-stream')],
    ['/compiler/xyo_browser_ir.js',file(path.join(work,'prototype-build/xyo_browser_ir.js'))],
    ['/compiler/xyo_browser_ir.wasm',file(path.join(work,'prototype-build/xyo_browser_ir.wasm'),'application/wasm')],
    ['/pipeline-index.mjs',file(path.join(tmp,'pipeline-index.mjs'))],
    ['/pipeline-worker.mjs',file(path.join(tmp,'pipeline-worker.mjs'))],
    ['/llc-browser.mjs',file(path.join(work,'llvm19-browser-proof/llc-browser.mjs'))],
    ['/llc-browser.wasm',file(path.join(work,'llvm19-browser-proof/llc-browser.wasm'),'application/wasm')],
    ['/lld-browser.mjs',file(path.join(work,'llvm19-lld-browser-proof/lld-browser.mjs'))],
    ['/lld-browser.wasm',file(path.join(work,'llvm19-lld-browser-proof/lld-browser.wasm'),'application/wasm')],
  ]);
  const server=createServer(async(req,res) => { const route=req.method==='GET' && routes.get(new URL(req.url,'http://localhost').pathname); if(!route){res.writeHead(404).end();return;} try{const b=await readFile(route[0]);res.writeHead(200,{'Content-Type':route[1]});res.end(b);}catch(e){res.writeHead(500).end(String(e));} });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  let browser;
  try {
    browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER||process.env.CHROME_BIN||chromium.executablePath()});
    const page=await browser.newPage();
    page.on('pageerror',e=>console.error('pageerror:',e));
    await page.goto(`http://127.0.0.1:${server.address().port}/`,{waitUntil:'load'});
    await page.waitForFunction(()=>document.querySelector('#result').textContent!=='RUNNING',null,{timeout:180000});
    const result=JSON.parse(await page.locator('#result').textContent());
    console.log(JSON.stringify(result)); if(!result.ok) process.exitCode=1;
  } finally { try{if(browser) await browser.close();} finally{await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));} }
})().catch(e=>{console.error(e);process.exitCode=1;});
