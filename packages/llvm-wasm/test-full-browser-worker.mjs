// Real Brave worker, separately instantiated Wasm llc and LLD, both using MEMFS.
import http from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.work/', import.meta.url));
const worker = `import createLLC from '/llc-browser.mjs';
import createLLD from '/lld-browser.mjs';
try {
  const logs=[];
  const opts={noInitialRun:true,print:s=>logs.push(s),printErr:s=>logs.push(s)};
  const compiler=await createLLC(opts);
  compiler.FS.writeFile('/add.ll', 'target triple = "wasm32-unknown-unknown"\\ndefine i32 @add(i32 %a, i32 %b) {\\n %s = add i32 %a, %b\\n ret i32 %s\\n}\\n');
  const cc=compiler.callMain(['-mtriple=wasm32-unknown-unknown','-filetype=obj','/add.ll','-o','/add.o']);
  if(cc!==0) throw Error('llc exit '+cc+': '+logs.join('\\n'));
  const object=compiler.FS.readFile('/add.o');
  const linker=await createLLD(opts);
  linker.FS.writeFile('/add.o',object);
  const ld=linker.callMain(['-flavor','wasm','--no-entry','--export=add','/add.o','-o','/result.wasm']);
  if(ld!==0) throw Error('lld exit '+ld+': '+logs.join('\\n'));
  const binary=linker.FS.readFile('/result.wasm');
  const {instance}=await WebAssembly.instantiate(binary);
  const result=instance.exports.add(20,22);
  if(result!==42) throw Error('add returned '+result);
  postMessage({ok:true,objectBytes:object.length,wasmBytes:binary.length,result,logs});
} catch(e) {postMessage({ok:false,error:String(e),stack:e.stack});}`;
const page=`<!doctype html><script type="module">const w=new Worker('/worker.mjs',{type:'module'});w.onmessage=({data})=>fetch('/result',{method:'POST',body:JSON.stringify(data)});w.onerror=e=>fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:e.message})});</script>`;
let finish;
const done=new Promise(r=>finish=r);
const files={ '/llc-browser.mjs':'llvm19-browser-proof/llc-browser.mjs', '/llc-browser.wasm':'llvm19-browser-proof/llc-browser.wasm', '/lld-browser.mjs':'llvm19-lld-browser-proof/lld-browser.mjs', '/lld-browser.wasm':'llvm19-lld-browser-proof/lld-browser.wasm' };
const server=http.createServer(async(req,res)=>{try{
  if(req.method==='POST'&&req.url==='/result'){const c=[];for await(const x of req)c.push(x);finish(JSON.parse(Buffer.concat(c)));res.end('ok');return;}
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(req.url==='/worker.mjs'){res.setHeader('Content-Type','text/javascript');res.end(worker);return;}
  if(files[req.url]){res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(path.join(dir,files[req.url])));return;}
  res.writeHead(404).end();
}catch(e){res.writeHead(500).end(String(e));finish({ok:false,error:String(e)});}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile = await mkdtemp(path.join(dir, 'llvm19-lld-browser-proof/profile-'));
const browser=spawn(process.env.BROWSER||'brave',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{detached:true,stdio:['ignore','ignore','pipe']});
let stderr='';browser.stderr.on('data',s=>{stderr+=s;});
const timeout=setTimeout(()=>finish({ok:false,error:'timeout'}),180000);
browser.on('error',e=>finish({ok:false,error:String(e)}));browser.on('exit',(code,signal)=>finish({ok:false,error:`browser exited ${code} ${signal}`}));
const result=await done;clearTimeout(timeout);try { process.kill(-browser.pid, 'SIGTERM'); } catch {} browser.stderr.destroy();browser.unref();server.closeAllConnections();server.close();
console.log(JSON.stringify(result));if(!result.ok){console.error(stderr.slice(-4000));process.exitCode=1;}
