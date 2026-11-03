// Real Brave headless + dedicated module worker; no external HTTP service or dependencies.
import http from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = fileURLToPath(new URL('.work/llvm19-browser-proof/', import.meta.url));
const ir = `target triple = "wasm32-unknown-unknown"\ndeclare i32 @external_fn(i32)\ndefine i32 @entry(i32 %x) {\n %y = call i32 @external_fn(i32 %x)\n ret i32 %y\n}\n`;
const worker = `import createLLC from '/llc-browser.mjs';
try {
 const versionOut=[], versionErr=[];
 const version=await createLLC({noInitialRun:true, print:s=>versionOut.push(s), printErr:s=>versionErr.push(s)});
 const versionStatus=version.callMain(['--version']);
 const badOut=[], badErr=[];
 const bad=await createLLC({noInitialRun:true, print:s=>badOut.push(s), printErr:s=>badErr.push(s)});
 const badStatus=bad.callMain(['--definitely-invalid-proof-option']);
 if(versionStatus!==0 || !versionOut.some(s=>s.includes('LLVM version 19.1.7'))) throw Error('Unexpected version status/stdout: '+versionStatus+' '+versionOut.join(' '));
 if(badStatus!==1 || !badErr.some(s=>s.includes('Unknown command line argument'))) throw Error('Unexpected invalid argument status/stderr: '+badStatus+' '+badErr.join(' '));
 const log=[];
 const m=await createLLC({noInitialRun:true, print:s=>log.push(s), printErr:s=>log.push(s)});
 m.FS.writeFile('/input.ll', ${JSON.stringify(ir)});
 const status=m.callMain(['-mtriple=wasm32-unknown-unknown','-filetype=obj','/input.ll','-o','/output.o']);
 if(status!==0) throw Error('llc exit '+status+' '+log.join('\\n'));
 const data=m.FS.readFile('/output.o');
 const m2=await createLLC({noInitialRun:true, print:s=>log.push(s), printErr:s=>log.push(s)});
 m2.FS.writeFile('/second.ll', 'target triple = "wasm32-unknown-unknown"\\ndefine i32 @add(i32 %a, i32 %b) {\\n %s = add i32 %a, %b\\n ret i32 %s\\n}\\n');
 const secondStatus=m2.callMain(['-mtriple=wasm32-unknown-unknown','-filetype=obj','/second.ll','-o','/second.o']);
 if(secondStatus!==0) throw Error('second llc exit '+secondStatus);
 const data2=m2.FS.readFile('/second.o');
 postMessage({ok:true, bytes:data.buffer, bytes2:data2.buffer, log, versionOut, versionErr, versionStatus, badOut, badErr, badStatus}, [data.buffer,data2.buffer]);
} catch(e) { postMessage({ok:false,error:String(e),stack:e.stack}); }`;
const page = `<!doctype html><script type="module">
const w=new Worker('/worker.mjs',{type:'module'});
w.onmessage=async ({data})=>{if(data.ok){await fetch('/object',{method:'POST',body:data.bytes}); await fetch('/object2',{method:'POST',body:data.bytes2}); await fetch('/result',{method:'POST',body:JSON.stringify({...data,bytes:undefined,bytes2:undefined})});}else await fetch('/result',{method:'POST',body:JSON.stringify(data)});};
w.onerror=async e=>{await fetch('/result',{method:'POST',body:JSON.stringify({ok:false,error:e.message})});};
</script>`;
let finish;
const done = new Promise(resolve => finish = resolve);
const server = http.createServer(async (req,res) => {
 try {
  if(req.method==='POST') { const chunks=[]; for await(const c of req) chunks.push(c); const b=Buffer.concat(chunks); if(req.url==='/object' || req.url==='/object2') await writeFile(path.join(dir,req.url==='/object'?'browser-output.o':'browser-output2.o'),b); else if(req.url==='/result') finish(JSON.parse(b)); res.end('ok'); return; }
  if(req.url==='/') {res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(req.url==='/worker.mjs') {res.setHeader('Content-Type','text/javascript');res.end(worker);return;}
  if(req.url==='/llc-browser.mjs' || req.url==='/llc-browser.wasm') {res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(path.join(dir,req.url.slice(1))));return;}
  res.writeHead(404).end();
 } catch(e) {res.writeHead(500).end(String(e)); finish({ok:false,error:String(e)});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/`;
const profile=await mkdtemp(path.join(dir,'brave-proof-profile-'));
const browser=spawn(process.env.BROWSER || 'brave',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking',`--user-data-dir=${profile}`,url],{detached:true,stdio:['ignore','ignore','pipe']});
let stderr=''; browser.stderr.on('data',s=>{stderr+=s;});
const timeout=setTimeout(()=>finish({ok:false,error:'browser test timed out'}),180000);
browser.on('error',e=>finish({ok:false,error:String(e)})); browser.on('exit',(code,signal)=>finish({ok:false,error:`browser exited ${code} ${signal}`}));
const result=await done; clearTimeout(timeout); try { process.kill(-browser.pid, 'SIGTERM'); } catch {} browser.stderr.destroy(); browser.unref(); server.closeAllConnections(); server.close();
console.log(JSON.stringify(result));
if(result.ok) {
 const first=await readFile(path.join(dir,'browser-output.o')), second=await readFile(path.join(dir,'browser-output2.o'));
 if(first.equals(second) || first.subarray(0,4).toString('hex')!=='0061736d' || second.subarray(0,4).toString('hex')!=='0061736d') {console.error('objects identical or invalid');process.exitCode=1;}
 console.log(`Two distinct wasm objects: ${first.length} and ${second.length} bytes`);
 const readobj=fileURLToPath(new URL('../xyo-cpp-wasm/.work/emsdk/upstream/bin/llvm-readobj',import.meta.url));
 const inspect=spawnSync(readobj,['--relocations','--symbols',path.join(dir,'browser-output.o')],{encoding:'utf8'});
 console.log(inspect.stdout);
 if(inspect.status!==0 || !inspect.stdout.includes('R_WASM_FUNCTION_INDEX_LEB') || !inspect.stdout.includes('external_fn')) {console.error(inspect.stderr || 'missing expected function relocation');process.exitCode=1;}
} else {console.error(stderr.slice(-6000));process.exitCode=1;}
