// Real LLVM llc + LLD via the production pipeline and worker client in Brave.
// Requires the separately built LLVM 19 browser proof artifacts and bun.
import http from 'node:http';
import { readFile, mkdtemp } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const pkg=fileURLToPath(new URL('.',import.meta.url));
const llc=path.join(pkg,'.work/llvm19-browser-proof');
const lld=path.join(pkg,'.work/llvm19-lld-browser-proof');
// Same fixture + IR compiler as prototype/run-smoke.sh, with a private output
// directory; no prototype or LLVM build-tree file is rewritten.
const fixture=await mkdtemp(path.join(llc,'pipeline-sb3-fixture-'));
const python=spawnSync('python3',[path.join(pkg,'prototype/smoke-fixture.py'),fixture],{encoding:'utf8'});
if(python.status!==0) throw Error(`SB3 fixtures: ${python.stderr || python.stdout}`);
const node=path.join(pkg,'../xyo-cpp-wasm/.work/emsdk/node/24.19.0_64bit/bin/node');
const smoke=spawnSync(node,[path.join(pkg,'prototype/smoke.cjs'),path.join(pkg,'.work/prototype-build/xyo_browser_ir.cjs'),fixture],{encoding:'utf8',env:{...process.env,XYO_IR_OUT:path.join(fixture,'valid.ll')}});
if(smoke.status!==0) throw Error(`SB3 to IR: ${smoke.stderr || smoke.stdout}`);
for(const name of ['index','worker']) {
 const b=spawnSync('bun',['build',path.join(pkg,`src/${name}.ts`),'--target=browser','--outfile',path.join(llc,`pipeline-integration-${name}.mjs`)],{encoding:'utf8'});
 if(b.status!==0) throw Error(`bundle ${name}: ${b.stderr || b.stdout}`);
}
const page=`<!doctype html><script type="module">
import {createLLVMWorkerClient,LLVMPipeline,PipelineError} from '/pipeline-integration-index.mjs';
const assert=(v,m)=>{if(!v) throw Error(m)};
const client=createLLVMWorkerClient('/pipeline-integration-worker.mjs','/llc-browser.mjs','/lld-browser.mjs');
const pipeline=new LLVMPipeline(client);
const post=async value=>{await fetch('/result',{method:'POST',body:JSON.stringify(value)});};
const ir=op=>'target triple = "wasm32-unknown-unknown"\\ndefine i32 @add(i32 %a, i32 %b) {\\n %v = '+op+' i32 %a, %b\\n ret i32 %v\\n}\\n';
try {
 const first=await pipeline.compile({ir:ir('add'),exports:['add']});
 assert(WebAssembly.validate(first.binary),'invalid add module');
 const a=await WebAssembly.instantiate(first.binary);
 const add=a.instance.exports.add(20,22);
 assert(add===42,'add result '+add);
 assert(first.diagnostics.llc && first.diagnostics.linker,'missing stage diagnostics');
 const second=await pipeline.compile({ir:ir('sub'),exports:['add']});
 const b=await WebAssembly.instantiate(second.binary);
 const subtract=b.instance.exports.add(20,22);
 assert(subtract===-2,'subtract result '+subtract);
 assert(first.binary.length!==second.binary.length || first.binary.some((v,i)=>v!==second.binary[i]),'different IR gave identical module');
 let badIR;try{await pipeline.compile({ir:'invalid llvm ir',exports:['add']});}catch(e){badIR=e;}
 assert(badIR instanceof PipelineError && badIR.stage==='llc' && badIR.diagnostics.llc.stderr.length>0,'invalid IR did not report llc stderr');
 const unresolved='target triple = "wasm32-unknown-unknown"\\ndeclare i32 @external_fn(i32)\\ndefine i32 @entry(i32 %x) {\\n %y = call i32 @external_fn(i32 %x)\\n ret i32 %y\\n}\\n';
 let badLink;try{await pipeline.compile({ir:unresolved,exports:['entry']});}catch(e){badLink=e;}
 assert(badLink instanceof PipelineError && badLink.stage==='linker' && badLink.diagnostics.linker.stderr.includes('external_fn'),'missing linker diagnostic: '+String(badLink));
 const sb3ir=await (await fetch('/valid.ll')).text();
 const imports=[{module:'GOT.mem',name:'xyo_aot_slot_0',kind:'global'},{module:'GOT.mem',name:'xyo_aot_slot_1',kind:'global'},{module:'env',name:'__memory_base',kind:'global'},{module:'env',name:'__table_base',kind:'global'},{module:'env',name:'memory',kind:'memory'},{module:'env',name:'xyo_varslot_init',kind:'function'}];
 const side=await pipeline.compile({ir:sb3ir,exports:['xyo_browser_script'],sideModule:{imports}});
 let missing;try{await pipeline.compile({ir:sb3ir,exports:['xyo_browser_script'],sideModule:{imports:imports.slice(1)}});}catch(e){missing=e;}
 assert(missing instanceof PipelineError && missing.stage==='validation','missing import was not rejected');
 let extra;try{await pipeline.compile({ir:sb3ir,exports:['xyo_browser_script'],sideModule:{imports:[...imports,{module:'env',name:'unexpected',kind:'function'}]}});}catch(e){extra=e;}
 assert(extra instanceof PipelineError && extra.stage==='validation','extra allowlist entry was not rejected');
 // Synthetic host only: controlled memory/slots, not an Emscripten or product loader.
 const memory=new WebAssembly.Memory({initial:2}); const view=new DataView(memory.buffer);
 view.setUint32(4096+68,5000,true);view.setUint32(5000,6000,true);
 let initCalls=0;
 const host={env:{memory,__memory_base:1024,__table_base:0,xyo_varslot_init:()=>{initCalls++;}},'GOT.mem':{xyo_aot_slot_0:new WebAssembly.Global({value:'i32',mutable:true},2048),xyo_aot_slot_1:new WebAssembly.Global({value:'i32',mutable:true},2052)}};
 const instance=await WebAssembly.instantiate(side.binary,host);
 instance.instance.exports.xyo_browser_script(4096);
 assert(initCalls===1,'synthetic host callback not called');
 const csp=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CSP frame timed out')),15000);addEventListener('message',e=>{if(e.origin===location.origin && e.data?.test==='csp'){clearTimeout(timer);resolve(e.data);}},{once:true});const frame=document.createElement('iframe');frame.src='/csp';document.body.append(frame);});
 assert(csp.ok,'CSP/no-fallback test failed: '+JSON.stringify(csp));
 pipeline.stop();
 await post({ok:true,add,subtract,addBytes:first.binary.length,subtractBytes:second.binary.length,diagnostics:first.diagnostics,badIR:badIR.diagnostics.llc.stderr,badLink:badLink.diagnostics.linker.stderr,sideBytes:side.binary.length,sideImports:imports,syntheticInitCalls:initCalls,missingRejected:true,extraRejected:true,csp});
}catch(e){pipeline.stop();await post({ok:false,error:String(e),stack:e.stack,stage:e.stage,diagnostics:e.diagnostics});}
</script>`;
const cspScript=`import {LLVMPipeline} from '/pipeline-integration-index.mjs';
const bytes=new Uint8Array([0,97,115,109,1,0,0,0]);
let calls=0;const fake={stop(){},restart(){},async run(r){calls++;return {files:[{path:r.tool==='llc'?'output.o':'output.wasm',data:r.tool==='llc'?new Uint8Array([1]):bytes}],stdout:'',stderr:''};}};
let blocked=false;try{await WebAssembly.compile(bytes)}catch{blocked=true}
let error;try{await new LLVMPipeline(fake).compile({ir:'',exports:[],sideModule:{imports:[]}})}catch(e){error=e}
parent.postMessage({test:'csp',ok:blocked && error?.stage==='validation' && calls===2,blocked,stage:error?.stage,calls},location.origin);`;
let finish;const done=new Promise(r=>finish=r);
const routes={'/valid.ll':path.join(fixture,'valid.ll'),'/pipeline-integration-index.mjs':path.join(llc,'pipeline-integration-index.mjs'),'/pipeline-integration-worker.mjs':path.join(llc,'pipeline-integration-worker.mjs'),'/llc-browser.mjs':path.join(llc,'llc-browser.mjs'),'/llc-browser.wasm':path.join(llc,'llc-browser.wasm'),'/lld-browser.mjs':path.join(lld,'lld-browser.mjs'),'/lld-browser.wasm':path.join(lld,'lld-browser.wasm')};
const server=http.createServer(async(req,res)=>{try{const p=new URL(req.url,'http://localhost').pathname;if(req.method==='POST'&&p==='/result'){const chunks=[];for await(const c of req)chunks.push(c);finish(JSON.parse(Buffer.concat(chunks)));res.end('ok');return;}if(p==='/'){res.setHeader('Content-Type','text/html');res.end(page);return;}if(p==='/csp'){res.setHeader('Content-Security-Policy',"script-src 'self'");res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/csp.mjs"></script>');return;}if(p==='/csp.mjs'){res.setHeader('Content-Type','text/javascript');res.end(cspScript);return;}if(routes[p]){res.setHeader('Content-Type',p.endsWith('.wasm')?'application/wasm':'text/javascript');res.end(await readFile(routes[p]));return;}res.writeHead(404).end();}catch(e){res.writeHead(500).end(String(e));finish({ok:false,error:String(e)});}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=await mkdtemp(path.join(llc,'brave-pipeline-profile-'));
const browser=spawn(process.env.BROWSER||'brave',['--headless','--no-sandbox','--disable-gpu','--disable-background-networking',`--user-data-dir=${profile}`,`http://127.0.0.1:${server.address().port}/`],{detached:true,stdio:['ignore','ignore','pipe']});
let stderr='';browser.stderr.on('data',s=>stderr+=s);
const timeout=setTimeout(()=>finish({ok:false,error:'browser test timed out'}),180000);
browser.on('error',e=>finish({ok:false,error:String(e)}));browser.on('exit',(code,signal)=>finish({ok:false,error:`browser exited ${code} ${signal}`}));
const result=await done;clearTimeout(timeout);try{process.kill(-browser.pid,'SIGTERM');}catch{}browser.stderr.destroy();browser.unref();server.closeAllConnections();server.close();
console.log(JSON.stringify(result));if(!result.ok){console.error(stderr.slice(-6000));process.exitCode=1;}
