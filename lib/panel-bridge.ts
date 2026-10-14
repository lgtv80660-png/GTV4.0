import {command, digest, opaque, seal, unseal, readSession} from './session-store';
import {mediaFetch} from './media-relay';
import {sessionStream} from './session-stream';
import {panelTarget, panelPlaylist, retrySeconds} from './panel-contract';

const headers = {'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer'};
export const panelEnabled = () => process.env.GTV_PANEL_HLS === '1';
function key(token: string) {
  const ns = process.env.GTV_SESSION_NAMESPACE;
  if (!ns || !/^[a-zA-Z0-9_-]{1,64}$/.test(ns) || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw Error('PANEL_CAPABILITY_INVALID');
  return 'gtv:'+ns+':panel:'+digest(token);
}
async function save(session: string, url: string, base: string, expires: number) {
  await readSession(session);
  const token = opaque(), k = key(token);
  const remaining = Math.floor((expires-Date.now())/1000);
  const ttl = panelTarget(url,base).resource === 'root' ? remaining : Math.min(180,remaining);
  if (ttl < 1 || await command('SET', k, seal({owner:digest(session),url,base,expires},k),'EX',ttl,'NX') !== 'OK') throw Error('PANEL_EXPIRED');
  return '/api/panel-hls?t='+token;
}
async function read(session: string, token: string) {
  await readSession(session);
  const k=key(token), raw=await command('GET',k);
  if(typeof raw !== 'string')throw Error('PANEL_EXPIRED');
  const v=unseal(raw,k);
  if(v.owner!==digest(session)||!Number.isSafeInteger(v.expires)||v.expires<=Date.now())throw Error('PANEL_EXPIRED');
  panelTarget(v.url,v.base);
  return v as {url:string;base:string;expires:number};
}
export async function openPanel(source:string, session:string, base:string, req:Request) {
  const {response:r,url}=await mediaFetch(source,base,req);
  // The header is mandatory: a normal provider redirect must never enable this mode.
  const root=r.headers.get('X-Panel-Root');
  await r.body?.cancel();
  if(!root)throw Error('PANEL_CONTRACT_MISSING');
  const target=panelTarget(root,base);
  if(target.resource!=='root'||new URL(url).origin!==new URL(base).origin)throw Error('PANEL_CONTRACT_INVALID');
  return Response.json({url:await save(session,target.url,base,Date.now()+1700*1000),generation:target.generation},{headers});
}
export async function servePanel(token:string, session:string, req:Request) {
  const v=await read(session,token), old=panelTarget(v.url,v.base);
  const {response:r,url}=await mediaFetch(v.url,v.base,req);
  panelTarget(url,v.base,old.session);
  const reopen=r.headers.get('X-Panel-Reopen');
  if(reopen && [409,502,503].includes(r.status)) {
    const next=panelTarget(reopen,v.base,old.session);
    if(next.resource!=='root'||next.generation<old.generation)throw Error('PANEL_REOPEN_INVALID');
    await r.body?.cancel();
    const exhausted=r.status===409&&next.generation===old.generation;
    return new Response('Reprise Live',{status:r.status,headers:{...headers,
      'X-GTV-Reopen':exhausted?'':await save(session,next.url,v.base,v.expires),
      'X-GTV-Generation':String(next.generation),'X-GTV-Exhausted':exhausted?'1':'0',
      'Retry-After':String(retrySeconds(r.headers.get('Retry-After')))}});
  }
  if(!r.ok||!r.body){await r.body?.cancel();return new Response('Live indisponible',{status:r.status>=400?r.status:502,headers});}
  const out=new Headers(headers), type=r.headers.get('content-type')||'application/octet-stream';
  out.set('Content-Type',type);
  out.set('X-GTV-Generation',String(old.generation));
  if(/mpegurl/i.test(type)) {
    const reader=r.body.getReader();let size=0;const chunks:Uint8Array[]=[];
    try {for(;;){const x=await reader.read();if(x.done)break;size+=x.value.length;if(size>1000000){await reader.cancel();throw Error('PANEL_TOO_LARGE');}chunks.push(x.value);}}finally{reader.releaseLock();}
    const text=await panelPlaylist(Buffer.concat(chunks).toString('utf8'),v.base,old.session,u=>save(session,u,v.base,v.expires));
    return new Response(text,{headers:out});
  }
  for(const h of ['content-range','accept-ranges']){const value=r.headers.get(h);if(value)out.set(h,value);}
  return new Response(sessionStream(r.body,session),{status:r.status,headers:out});
}
