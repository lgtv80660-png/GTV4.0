import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { mediaFetch } from './media-relay';
import { readSession } from './session-store';
import { sessionStream } from './session-stream';

type Entry={source:string;owner:string;requests:Set<AbortController>;status?:number;reason?:string;blockedOrigin?:string};
type State={server?:Server;ready?:Promise<number>;entries:Map<string,Entry>};
const g=globalThis as typeof globalThis & {gtvPrivateMediaInput?:State};
const state:State=g.gtvPrivateMediaInput??={entries:new Map()};
async function listen(){
 if(!state.ready)state.ready=new Promise<number>((resolve,reject)=>{
  const server=createServer(async(req,res)=>{
   const match=/^\/input\/([A-Za-z0-9_-]{43})$/.exec(req.url||'');
   const entry=match&&state.entries.get(match[1]);
   if(!entry||!['GET','HEAD'].includes(req.method||'')||req.headers.cookie||req.headers.authorization){res.writeHead(403);res.end();return;}
   const abort=new AbortController();entry.requests.add(abort);res.once('close',()=>abort.abort());
   try{
    const credentials=await readSession(entry.owner);
    const headers=new Headers();for(const k of ['range','if-range']){const v=req.headers[k];if(typeof v==='string')headers.set(k,v);}
    const {response}=await mediaFetch(entry.source,credentials.serverUrl,new Request('http://127.0.0.1/',{method:req.method,headers,signal:abort.signal}));
    entry.status=response.status;
    const out:Record<string,string>={'Cache-Control':'no-store'};
    for(const k of ['content-type','content-range','accept-ranges','content-length']){const v=response.headers.get(k);if(v&&(k!=='content-length'||!response.headers.get('content-encoding')||response.headers.get('content-encoding')==='identity'))out[k]=v;}
    res.writeHead(response.status,out);
    if(req.method==='HEAD'||!response.body){await response.body?.cancel();res.end();}
    else await pipeline(Readable.fromWeb(sessionStream(response.body,entry.owner) as Parameters<typeof Readable.fromWeb>[0]),res,{signal:abort.signal});
   }catch(e){entry.status=0;const blocked=(e instanceof Error?e.cause:undefined) as {blockedOrigin?:string}|undefined;entry.blockedOrigin=blocked?.blockedOrigin;entry.reason=e instanceof Error&&typeof (e.cause as {reason?:string})?.reason==='string'?(e.cause as {reason:string}).reason:e instanceof Error&&['MEDIA_INVALID','SESSION_INVALID','SESSION_UNAVAILABLE'].includes(e.message)?e.message:'NETWORK_UNAVAILABLE';if(!res.headersSent)res.writeHead(502);res.destroy();}
   finally{entry.requests.delete(abort);}
  });
  state.server=server;server.unref();server.once('error',()=>{state.ready=undefined;reject(Error('MEDIA_INPUT_UNAVAILABLE'));});
  server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){reject(Error('MEDIA_INPUT_UNAVAILABLE'));return;}resolve(address.port);});
 });
 return state.ready;
}
/** FFmpeg/FFprobe get only a bounded loopback capability, never the provider URL or session cookie. */
export async function privateMediaInput(source:string,owner:string){
 await readSession(owner);
 const port=await listen(),id=randomBytes(32).toString('base64url');
 const entry:Entry={source,owner,requests:new Set()};state.entries.set(id,entry);
 let closed=false;
 return {url:`http://127.0.0.1:${port}/input/${id}`,status:()=>entry.status??-1,reason:()=>entry.reason,blockedOrigin:()=>entry.blockedOrigin,close(){if(closed)return;closed=true;state.entries.delete(id);for(const request of entry.requests)request.abort();}};
}
