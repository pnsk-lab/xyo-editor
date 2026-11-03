// Isolated loopback server and browser worker; no product GUI is modified.
const {createServer}=require('node:http'), {readFile}=require('node:fs/promises'), path=require('node:path');
const {createRequire}=require('node:module');
const root=path.resolve(__dirname,'../../..'), pkg=path.join(root,'packages/llvm-wasm'), work=path.join(pkg,'.work'), build=path.join(__dirname,'build');
const {chromium}=createRequire(path.join(root,'packages/editor/package.json'))('playwright-core');
const routes=new Map(Object.entries({
 '/browser-worker.js':path.join(__dirname,'browser-worker.js'), '/real_host.js':path.join(build,'real_host.js'), '/real_host.wasm':path.join(build,'real_host.wasm'),
 '/fixture.sb3':path.join(build,'fixtures/valid.sb3'), '/fixture.sha256':path.join(build,'fixture.sha256'), '/reference.wasm':path.join(build,'reference.wasm'),
 '/compiler.js':path.join(build,'metadata_compiler.cjs'), '/compiler.wasm':path.join(build,'metadata_compiler.wasm'),
 '/pipeline-index.mjs':path.join(build,'pipeline-index.mjs'), '/pipeline-worker.mjs':path.join(build,'pipeline-worker.mjs'),
 '/llc-browser.mjs':path.join(work,'llvm19-browser-proof/llc-browser.mjs'), '/llc-browser.wasm':path.join(work,'llvm19-browser-proof/llc-browser.wasm'),
 '/lld-browser.mjs':path.join(work,'llvm19-lld-browser-proof/lld-browser.mjs'), '/lld-browser.wasm':path.join(work,'llvm19-lld-browser-proof/lld-browser.wasm')
}));
(async()=>{
 let finish;const done=new Promise(r=>finish=r);
 const server=createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;
  if(p==='/result'&&req.method==='POST'){let s='';for await(const c of req)s+=c;finish(JSON.parse(s));res.end('ok');return;}
  if(p==='/'){res.setHeader('Content-Type','text/html');res.end(`<script>const w=new Worker('/browser-worker.js');w.onmessage=e=>fetch('/result',{method:'POST',body:JSON.stringify(e.data)});w.onerror=e=>fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:e.message})});w.postMessage(0);</script>`);return;}
  const file=routes.get(p);if(!file){res.writeHead(404).end();return;}res.setHeader('Content-Type',p.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(file));
 }catch(e){finish({ok:false,error:String(e)});res.writeHead(500).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser,timer;
 try {browser=await chromium.launch({headless:true,executablePath:process.env.BROWSER||process.env.CHROME_BIN||chromium.executablePath()});const page=await browser.newPage();
  page.on('pageerror',e=>finish({ok:false,error:String(e)}));await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const value=await Promise.race([done,new Promise(r=>timer=setTimeout(()=>r({ok:false,error:'timeout'}),180000))]);console.log(JSON.stringify(value));if(!value.ok)process.exitCode=1;
 }finally{clearTimeout(timer);if(browser)await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
