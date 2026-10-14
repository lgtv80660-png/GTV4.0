const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript');
const root=require('node:path').resolve(__dirname,'../lib')+'/';
let checks=0;function check(v){assert.ok(v);checks++;}
async function main(){
 const fixture=JSON.parse(fs.readFileSync("C:/Users/Playe/Documents/Codex/2026-10-14/referenced-chatgpt-conversation-this-is-an-12/work/panel-scenario.json",'utf8'));
 const store=new Map(),timers=[],instances=[];let serial=0,requests=[],mode='primary',playing=true;
 const owner='A'.repeat(43),panel='a'.repeat(64),base='https://panel.example';
 const href=(g,r='root')=>base+'/live_source_media.php?s='+panel+'&g='+g+'&r='+r;
 const ctx=vm.createContext({Buffer,URL,Response,Headers,Request,Uint8Array,Date,console,process:{env:{GTV_SESSION_NAMESPACE:'test',GTV_PANEL_HLS:'1'}},AbortController,setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}});
 async function synth(values){const m=new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context:ctx});await m.link(()=>{});await m.evaluate();return m;}
 const st=await synth({digest:s=>'digest:'+s,opaque:()=>String(++serial).padStart(43,'A'),seal:(v,k)=>JSON.stringify({v,k}),unseal:(raw,k)=>{const a=JSON.parse(raw);assert.equal(a.k,k);return a.v;},readSession:async s=>{if(s!==owner&&s!=='B'.repeat(43))throw Error('auth');},command:async(cmd,k,val)=>{if(cmd==='SET'){store.set(k,val);return 'OK';}return store.get(k);}});
 const media=await synth({mediaFetch:async(url,_base,req)=>{
   requests.push(url);
   if(url.includes('/live/'))return {url,response:new Response('#EXTM3U',{headers:{'X-Panel-Root':href(0)}})};
   const u=new URL(url),g=Number(u.searchParams.get('g')),r=u.searchParams.get('r');
   if(mode==='bad')return {url,response:new Response('fail',{status:502,headers:{'X-Panel-Reopen':'https://evil.example/'+panel}})};
   const actual=x=>({url,response:new Response(x.body,{status:x.status,headers:{'Content-Type':x.type||'video/mp2t',...(x.reopen?{'X-Panel-Reopen':x.reopen,'Retry-After':'3'}:{})}})});
   if(mode==='failed'&&g===0)return actual(fixture.failed);
   if(mode==='cooldown')return actual(fixture.cooldown);
   if(mode==='exhausted')return {url,response:new Response('end',{status:409,headers:{'X-Panel-Reopen':href(g)}})};
   return actual(r==='root'?(g===1?fixture.backup:fixture.root):(g===1?fixture.resumed:fixture.segment));
 }});
 const stream=await synth({sessionStream:b=>b});
 const modules={};async function load(name){if(modules[name])return modules[name];const code=ts.transpileModule(fs.readFileSync(root+name+'.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;const m=new vm.SourceTextModule(code,{context:ctx});modules[name]=m;await m.link(s=>s==='./session-store'?st:s==='./media-relay'?media:s==='./session-stream'?stream:load(s.slice(2)));await m.evaluate();return m;}
 const contract=(await load('panel-contract')).namespace,b=(await load('panel-bridge')).namespace,p=(await load('panel-player')).namespace;
 for(const bad of ['https://evil.example/live_source_media.php?s='+panel+'&g=0&r=root',href(0)+'&url=x',href(0).replace(panel,'e'.repeat(64)),href(0).replace('g=0','g=-1'),href(0)+'#x']){assert.throws(()=>contract.panelTarget(bad,base,panel));checks++;}
 check(contract.retrySeconds('999')===30);check(contract.retrySeconds(null)===3);
 await assert.rejects(()=>contract.panelPlaylist('#EXTM3U\n#EXT-X-KEY:URI="https://evil.example/key"',base,panel,async u=>u));checks++;
 await assert.rejects(()=>contract.panelPlaylist('not a manifest',base,panel,async u=>u));checks++;
 await assert.rejects(()=>contract.panelPlaylist('#EXTM3U\n#EXT-X-KEY:URI=https://evil.example/key',base,panel,async u=>u));checks++;
 check(b.panelEnabled());ctx.process.env.GTV_PANEL_HLS='0';check(!b.panelEnabled());ctx.process.env.GTV_PANEL_HLS='1';
 const req=new Request('https://gtv.example/api/panel-hls?id=100');
 const open=await b.openPanel(base+'/live/user/pass/100.m3u8',owner,base,req),data=await open.json();check(/^\/api\/panel-hls\?t=/.test(data.url));
 const token=u=>new URL(u,'https://gtv.example').searchParams.get('t');
 let r=await b.servePanel(token(data.url),owner,req),body=await r.text();check(body.includes('URI="/api/panel-hls?t='));check(!body.includes(panel)&&!body.includes(base));check(r.headers.get('cache-control')==='no-store');
 await assert.rejects(()=>b.servePanel(token(data.url),'B'.repeat(43),req));checks++;
 const seg=body.split('\n').find(x=>x.startsWith('/api/'));r=await b.servePanel(token(seg),owner,req);check(await r.text()==='PRIMARY');
 mode='failed';r=await b.servePanel(token(seg),owner,req);check(r.status===502);const resume=r.headers.get('X-GTV-Reopen');check(r.headers.get('X-GTV-Generation')==='1');check(r.headers.get('Retry-After')==='3');
 mode='cooldown';r=await b.servePanel(token(resume),owner,req);check(r.status===503);const after=r.headers.get('X-GTV-Reopen');
 mode='backup';r=await b.servePanel(token(after),owner,req);body=await r.text();const backup=body.split('\n').find(x=>x.startsWith('/api/'));r=await b.servePanel(token(backup),owner,req);check(await r.text()==='BACKUP');check(requests.filter(x=>x.includes('/live/')).length===1);
 mode='exhausted';r=await b.servePanel(token(after),owner,req);check(r.status===409&&r.headers.get('X-GTV-Exhausted')==='1'&&!r.headers.get('X-GTV-Reopen'));
 mode='bad';await assert.rejects(()=>b.servePanel(token(data.url),owner,req));checks++;
 const video={pause(){playing=false;},removeAttribute(){},load(){}};
 class FakeHls{static isSupported(){return true;}static Events={ERROR:'error'};constructor(opts){this.opts=opts;instances.push(this);}on(_e,fn){this.error=fn;}loadSource(u){this.url=u;}attachMedia(){}stopLoad(){this.stopped=true;}destroy(){this.destroyed=true;}}
 const handle=await p.attachPanelPlayer(video,'100',FakeHls,async()=>Response.json(data));check(instances[0].url===data.url);
 const fire=(instance,status,headers)=>{let fn;instance.opts.xhrSetup({status,readyState:4,addEventListener(_e,f){fn=f;},getResponseHeader:k=>headers[k]||null});fn();};
 fire(instances[0],502,{'X-GTV-Reopen':resume,'Retry-After':'3'});check(instances[0].destroyed&&instances[0].stopped&&!playing);check(timers[0].ms===3000);timers[0].fn();check(instances[1].url===resume);
 fire(instances[1],409,{'X-GTV-Exhausted':'1'});check(instances[1].destroyed);handle.destroy();
 console.log(checks+' checks passed; simulated PRIMARY -> 502 -> cooldown 503 -> BACKUP; decoder destroyed before reopening.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
