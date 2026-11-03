// Integration smoke test of the real TS client + worker + runtime with LLVM's browser llc.
// Prerequisites: bun, Brave, and output of relink-llvm19-browser-proof.py.
import http from 'node:http';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageDir = fileURLToPath(new URL('.', import.meta.url));
const dir = path.join(packageDir, '.work/llvm19-browser-proof');
for (const name of ['client', 'worker']) {
  const build = spawnSync('bun', ['build', path.join(packageDir, `src/${name}.ts`), '--target=browser', '--outfile', path.join(dir, `integration-${name}.mjs`)], { encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`bun build ${name}: ${build.stderr || build.stdout}`);
}
const page = `<!doctype html><script type="module">
import { createLLVMWorkerClient, WorkerToolError } from '/integration-client.mjs';
const post = async (url,body) => { const r=await fetch(url,{method:'POST',body}); if(!r.ok) throw Error('POST '+url+' failed'); };
const assert = (v,msg) => { if(!v) throw Error(msg); };
const c=createLLVMWorkerClient('/integration-worker.mjs','/llc-browser.mjs','/llc-browser.mjs');
const ir = new TextEncoder().encode('target triple = "wasm32-unknown-unknown"\\ndeclare i32 @external_fn(i32)\\ndefine i32 @entry(i32 %x) {\\n %y = call i32 @external_fn(i32 %x)\\n ret i32 %y\\n}\\n');
const request={tool:'llc',args:['-mtriple=wasm32-unknown-unknown','-filetype=obj','source/input.ll','-o','out/result.o'],inputs:[{path:'source/input.ll',data:ir}],outputs:['out/result.o']};
try {
 const version=await c.run({tool:'llc',args:['--version'],inputs:[],outputs:[]});
 assert(version.stdout.includes('LLVM version 19.1.7'),'missing llc version stdout: '+version.stdout);
 let bad;
 try { await c.run({tool:'llc',args:['--definitely-invalid-proof-option'],inputs:[],outputs:[]}); } catch(e) { bad=e; }
 assert(bad instanceof WorkerToolError && bad.message.includes('status 1') && bad.stderr.includes('Unknown command line argument'),'missing llc stderr/error: '+String(bad));
 const first=await c.run(request);
 assert(first.files.length===1 && first.files[0].data.length>8,'missing first object');
 await post('/object1',first.files[0].data);
 // Stop while a request is pending; it must reject, and stopped clients cannot run.
 const pending=c.run(request).then(()=>{throw Error('pending request unexpectedly succeeded');},e=>{assert(e instanceof WorkerToolError && e.message==='Worker stopped','unexpected pending error '+e);return e.message;});
 c.stop();
 const stopMessage=await pending;
 let stopped; try { await c.run(request); } catch(e) {stopped=e;}
 assert(stopped instanceof WorkerToolError && stopped.message==='Worker is stopped','stopped client accepted work');
 c.restart();
 const after=await c.run(request);
 assert(after.files.length===1 && after.files[0].data.length>8,'missing restarted object');
 await post('/object2',after.files[0].data);
 c.stop();
 await post('/result',JSON.stringify({ok:true,version:version.stdout,badMessage:bad.message,badStderr:bad.stderr,stopMessage,restartBytes:after.files[0].data.length}));
} catch(e) { c.stop(); await post('/result',JSON.stringify({ok:false,error:String(e),stack:e.stack})); }
</script>`;
let finish;
const done = new Promise(resolve => {finish=resolve;});
const server=http.createServer(async (req,res)=>{
 req.url = new URL(req.url, 'http://localhost').pathname;
 try {
  if(req.method==='POST') {const parts=[]; for await (const chunk of req) parts.push(chunk); const body=Buffer.concat(parts);
   if(req.url==='/object1' || req.url==='/object2') await writeFile(path.join(dir,`integration-${req.url.slice(1)}.o`),body);
   else if(req.url==='/result') finish(JSON.parse(body));
   res.end('ok'); return; }
  if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}
  if(['/integration-client.mjs','/integration-worker.mjs','/llc-browser.mjs','/llc-browser.wasm'].includes(req.url)){
   res.setHeader('Content-Type',req.url.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(path.join(dir,req.url.slice(1))));return;}
  res.writeHead(404).end();
 } catch(e){res.writeHead(500).end(String(e));finish({ok:false,error:String(e)});}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const profile = await mkdtemp(path.join(dir,'brave-integration-profile-'));
const browser=spawn(process.env.BROWSER || 'brave',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{detached:true,stdio:['ignore','ignore','pipe']});
let stderr=''; browser.stderr.on('data',s=>{stderr+=s;});
const timeout=setTimeout(()=>finish({ok:false,error:'browser test timed out'}),180000);
browser.on('error',e=>finish({ok:false,error:String(e)})); browser.on('exit',(code,signal)=>finish({ok:false,error:`browser exited ${code} ${signal}`}));
const result=await done; clearTimeout(timeout); try { process.kill(-browser.pid, 'SIGTERM'); } catch {} browser.stderr.destroy(); browser.unref(); server.closeAllConnections(); server.close();
console.log(JSON.stringify(result));
if(!result.ok) {console.error(stderr.slice(-6000));process.exitCode=1;} else {
 const first=await readFile(path.join(dir,'integration-object1.o')), second=await readFile(path.join(dir,'integration-object2.o'));
 if(!first.equals(second) || first.subarray(0,4).toString('hex')!=='0061736d') {console.error('Restart output mismatch or invalid Wasm');process.exitCode=1;}
 const readobj=fileURLToPath(new URL('../xyo-cpp-wasm/.work/emsdk/upstream/bin/llvm-readobj',import.meta.url));
 const inspect=spawnSync(readobj,['--relocations','--symbols',path.join(dir,'integration-object2.o')],{encoding:'utf8'});
 console.log(inspect.stdout);
 if(inspect.status!==0 || !inspect.stdout.includes('R_WASM_FUNCTION_INDEX_LEB') || !inspect.stdout.includes('external_fn')) {console.error(inspect.stderr || 'missing expected relocation');process.exitCode=1;}
}
