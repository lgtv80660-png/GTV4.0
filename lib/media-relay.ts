import { sessionStream } from './session-stream';
import { saveResource } from './session-store';
import {lookup} from 'node:dns/promises';
import {request as httpRequest} from 'node:http';
import {request as httpsRequest} from 'node:https';
import type {IncomingMessage} from 'node:http';
function upstreamBody(source:IncomingMessage){
 let finished=false,cleanup=()=>{};
 return new ReadableStream<Uint8Array>({
  start(controller){
   const data=(chunk:Buffer)=>{if(finished)return;controller.enqueue(new Uint8Array(chunk));if((controller.desiredSize??1)<=0)source.pause();};
   const end=()=>{if(finished)return;finished=true;cleanup();controller.close();};
   const error=()=>{if(finished)return;finished=true;cleanup();controller.error(Error('MEDIA_NETWORK_UNAVAILABLE'));};
   const close=()=>{if(!source.complete)error();};
   cleanup=()=>{source.off('data',data);source.off('end',end);source.off('error',error);source.off('close',close);};
   source.on('data',data);source.once('end',end);source.once('error',error);source.once('close',close);
  },
  pull(){if(!finished)source.resume();},
  cancel(){finished=true;cleanup();source.destroy();}
 });
}
import {allowedMedia,publicAddress,mediaDenied} from './media-policy';
export {allowedMedia} from './media-policy';

async function resolvedAddresses(host:string,signal:AbortSignal){
 const limit=AbortSignal.any([signal,AbortSignal.timeout(5000)]);
 let abort:()=>void=()=>{};
 try{return await Promise.race([lookup(host,{all:true,verbatim:true}),new Promise<never>((_resolve,reject)=>{abort=()=>reject(Error('MEDIA_DNS_UNAVAILABLE'));limit.addEventListener('abort',abort,{once:true});if(limit.aborted)abort();})]);}
 catch{return mediaDenied('MEDIA_DNS_UNAVAILABLE');}finally{limit.removeEventListener('abort',abort);}
}
async function readPlaylist(response:Response){
 const reader=response.body!.getReader(),parts:Uint8Array[]=[];let length=0;
 try{for(;;){const next=await reader.read();if(next.done)break;length+=next.value.length;if(length>1_000_000){await reader.cancel();return mediaDenied('MEDIA_PLAYLIST_TOO_LARGE');}parts.push(next.value);}return Buffer.concat(parts).toString('utf8');}finally{reader.releaseLock();}
}
async function pinnedFetch(url:URL,req:Request):Promise<Response>{
 const host=url.hostname.replace(/^\[|\]$/g,'');
 const answers=await resolvedAddresses(host,req.signal);
 if(!answers.length||answers.some(a=>!publicAddress(a.address)))return mediaDenied('MEDIA_ADDRESS_BLOCKED');
 const address=answers[0];
 const headers:Record<string,string>={'User-Agent':'VLC/3.0.20 LibVLC/3.0.20',Accept:'*/*','Accept-Encoding':'identity'};
 for(const key of ['range','if-range']){const value=req.headers.get(key);if(value)headers[key]=value;}
 return new Promise((resolve,reject)=>{
  const transport=url.protocol==='https:'?httpsRequest:httpRequest;
  // Pin the checked DNS address while retaining the original Host and TLS SNI.
  const upstream=transport(url,{method:req.method==='HEAD'?'HEAD':'GET',headers,signal:req.signal,family:address.family,lookup:(_host,_options,done)=>done(null,address.address,address.family)},response=>{
   clearTimeout(timer);const out=new Headers();
   for(let i=0;i<response.rawHeaders.length;i+=2)out.append(response.rawHeaders[i],response.rawHeaders[i+1]);
   const status=response.statusCode||502;
   const empty=req.method==='HEAD'||[204,205,304].includes(status);
   if(empty)response.resume();
   resolve(new Response(empty?null:upstreamBody(response),{status,headers:out}));
  });
  const timer=setTimeout(()=>upstream.destroy(Error('MEDIA_TIMEOUT')),20000);timer.unref();
  upstream.once('error',()=>{clearTimeout(timer);reject(Error('MEDIA_NETWORK_UNAVAILABLE'));});upstream.end();
 });
}
export async function mediaFetch(source:string,base:string,req:Request,trustedResource=false){
 let url=allowedMedia(source,base,trustedResource);const visited=new Set<string>();
 for(let hop=0;hop<5;hop++){
  if(req.signal.aborted)throw Error('MEDIA_CANCELLED');
  if(visited.has(url.href))return mediaDenied('MEDIA_REDIRECT_LOOP');visited.add(url.href);
  const response=await pinnedFetch(url,req);
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');await response.body?.cancel();
   if(!location)return mediaDenied('MEDIA_REDIRECT_INVALID');
   const target=new URL(location,url);
   if(process.env.GTV_LOCAL_RUNTIME==='1')console.warn(JSON.stringify({event:'media_redirect',hop:hop+1,status:response.status,fromOrigin:url.origin,toOrigin:target.origin}));
   url=allowedMedia(target.href,base,true);continue;
  }
  return {response,url:url.href};
 }
 return mediaDenied('MEDIA_REDIRECT_LIMIT');
}
export async function rewritePlaylist(text: string, base: string, session: string, upstreamBase: string) {
    if (text.length > 1000000 || !text.trimStart().startsWith('#EXTM3U'))
        throw Error('MEDIA_INVALID');
    const rewrite = async (value: string) => { const target = allowedMedia(new URL(value, base).href, upstreamBase, true); return '/api/hlsseg?t=' + await saveResource(session, target.href); };
    const lines = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
            lines.push(line);
            continue;
        }
        if (!line.startsWith('#')) {
            lines.push(await rewrite(line.trim()));
            continue;
        }
        // Rewrite keys, initialization maps, alternate tracks and nested playlists.
        let changed = line;
        const matches = [...line.matchAll(/URI="([^"]+)"/g)];
        for (const m of matches)
            changed = changed.replace(m[0], 'URI="' + await rewrite(m[1]) + '"');
        // Unknown tags containing unwrapped upstream URLs fail closed.
        if (/https?:\/\//i.test(changed))
            throw Error('MEDIA_INVALID');
        lines.push(changed);
    }
    return lines.join('\n');
}
export async function relayMedia(source: string, session: string, base: string, req: Request, trustedResource = false) {
    try {
        const { response: r, url } = await mediaFetch(source, base, req, trustedResource);
        if (!r.ok && r.status !== 416 || !r.body && req.method !== 'HEAD' && r.status !== 416) {
            await r.body?.cancel();
            return new Response('Média indisponible', { status: 502 });
        }
        if(r.status===416){await r.body?.cancel();return new Response(null,{status:416,headers:{'Cache-Control':'no-store',...(r.headers.get('content-range')?{'Content-Range':r.headers.get('content-range')!}:{})}});}
        if(r.headers.get('content-encoding')&&!/^identity$/i.test(r.headers.get('content-encoding')!)){await r.body?.cancel();return new Response('Média indisponible',{status:502,headers:{'Cache-Control':'no-store'}});}
        const type = r.headers.get('content-type') || 'application/octet-stream';
        const playlist = /mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(url);
        const h = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
        if(req.method==='HEAD'){await r.body?.cancel();for(const key of ['content-type','content-length','content-range','accept-ranges']){const value=r.headers.get(key);if(value)h.set(key,value);}return new Response(null,{status:r.status,headers:h});}
        if (playlist) {
            h.set('Content-Type', 'application/vnd.apple.mpegurl');
            return new Response(await rewritePlaylist(await readPlaylist(r), url, session, base), { headers: h });
        }
        h.set('Content-Type', type);
        for (const k of ['content-range', 'accept-ranges', 'content-length']) {
            const v = r.headers.get(k);
            if (v && (k !== 'content-length' || !r.headers.get('content-encoding') || r.headers.get('content-encoding') === 'identity'))
                h.set(k, v);
        }
        return new Response(sessionStream(r.body!, session), { status: r.status, headers: h });
    }
    catch {
        return new Response('Média indisponible', { status: 502, headers: { 'Cache-Control': 'no-store' } });
    }
}
