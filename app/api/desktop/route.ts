import {sessionStream} from '@/lib/session-stream';
import {inspectLive, readDesktopPlaylist} from '@/lib/live-format';
import { mediaFetch, allowedMedia } from '@/lib/media-relay';
import { secureJson } from '@/lib/security-json';
import { readSession } from '@/lib/session-store';
import { csrfAllowed } from '@/lib/security';
import { requireSession, sessionToken } from '@/lib/session';
import { buildStreamUrl } from '@/lib/xtream/urls';
import { grants, opaque, fingerprint, sweep } from '@/lib/desktop-grants';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const noStore = { 'Cache-Control':'no-store', 'Referrer-Policy':'no-referrer' };
const answer = (body: unknown, status = 200) => secureJson(body,{status,headers:noStore});
const origins = new Set(['https://gtv-3-cloudflare.lgtv80660.workers.dev','http://127.0.0.1:3000','http://localhost:3000']);
export async function POST(req: Request) {
  sweep();
  try {
    const input = await req.json();
    if (input.action === 'redeem') {
      const g = grants.get(input.ticket);
      if (!g || g.redeemed || g.binding !== input.binding) return answer({error:'Denied'},403);
      await readSession(g.session);
      grants.delete(input.ticket); g.redeemed = true; g.expires = Date.now()+30*60_000;
      const lease = opaque(); grants.set(lease,g);
      const base = process.env.GTV_DESKTOP_AUTHORITY_URL;
      if (!base) { grants.delete(lease); return answer({error:'Unavailable'},503); }
      return answer({url:`${base}/api/desktop?lease=${lease}`,expires:g.expires});
    }
    if (!csrfAllowed(req)) return answer({error:'Denied'},403);
    const creds = await requireSession();
    const session = await sessionToken();
    if (input.action === 'revoke') {
      for (const [key,g] of grants) if (g.session === session && g.binding === input.binding) grants.delete(key);
      return answer({ok:true});
    }
    if (input.action !== 'grant' || !/^[0-9a-f]{64}$/.test(input.binding) ||
        !['movie','series','live'].includes(input.type) || !/^\d+$/.test(input.id) ||
        !/^[a-z0-9]{1,8}$/.test(input.ext)) return answer({error:'Invalid'},400);
    if (grants.size >= 128) return answer({error:'Capacity'},429);
    // Only GTV builds the source. No client URL, backup, cookie, or credential can enter the contract.
    const ticket=opaque();
    grants.set(ticket,{source:buildStreamUrl(creds,input.type,input.id,input.type==='live'?'m3u8':input.ext),session,binding:input.binding,expires:Date.now()+30_000,resources:new Map(),redeemed:false});
    return answer({ticket,expires:Date.now()+30_000,protocol:'gtv-media/1'});
  } catch { return answer({error:'Unauthorized or invalid request'},401); }
}
export async function GET(req: Request) {
  sweep(); const u = new URL(req.url); const lease = u.searchParams.get('lease') || '';
  const g = grants.get(lease);
  if (!g?.redeemed) return answer({error:'Denied'},403);
  let sessionCredentials;
  try { sessionCredentials=await readSession(g.session); } catch {grants.delete(lease);return answer({error:'Denied'},403);}
  const resource=u.searchParams.get('resource');
  const source=resource ? g.resources.get(resource) : g.source;
  if (!source) return answer({error:'Denied'},403);
  try {
    const {response:res,url:upstreamFinal}=await mediaFetch(source,sessionCredentials.serverUrl,req,Boolean(resource));
    if(!res.ok) { await res.body?.cancel(); return answer({error:'Media unavailable'},502); }
    let type=res.headers.get('content-type') || 'application/octet-stream';
    let body:ReadableStream<Uint8Array>=res.body!;
    let playlist=/mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(upstreamFinal);
    const live=new URL(g.source).pathname.startsWith('/live/');
    if (!live) playlist=/mpegurl/i.test(type) || /\.m3u8(?:\?|$)/i.test(source);
    if (!resource && live) {
      const detected=await inspectLive(body,req.signal);body=detected.body;playlist=detected.playlist;
      type=playlist?'application/vnd.apple.mpegurl':'video/mp2t';
    }
    if(!playlist && !/^(video\/|audio\/|application\/(octet-stream|mp2t|x-matroska))/i.test(type)){await res.body?.cancel();return answer({error:'Invalid media'},502);}
    const out = new Headers(noStore);
    out.set('Content-Type',playlist?'application/vnd.apple.mpegurl':type);
    if(playlist) {
      const text=live?await readDesktopPlaylist(body,req.signal):await res.text();
      if(text.length>1_000_000 || !text.startsWith('#EXTM3U')) return answer({error:'Invalid playlist'},502);
      const rewrite=(value:string)=>{
        const target=allowedMedia(new URL(value,upstreamFinal).href,sessionCredentials.serverUrl,true);
        if(!['http:','https:'].includes(target.protocol) || target.username || target.password) throw Error('Invalid resource');
        let key=[...g.resources].find(([,v])=>v===target.href)?.[0];
        if(!key){ if(g.resources.size>=2048) throw Error('Capacity'); key=opaque();g.resources.set(key,target.href); }
        const suffix=/\.(m3u8|ts|m4s|mp4|aac|key|vtt)$/i.exec(target.pathname)?.[1]?.toLowerCase() || 'ts';
        // Preserve a safe media suffix for HLS demuxer extension checks; the
        // asset name remains opaque and resolves only inside this lease's map.
        return `${process.env.GTV_DESKTOP_AUTHORITY_URL}/api/desktop/${key}.${suffix}?lease=${lease}&resource=${key}`;
      };
      const rewritten=text.split(/\r?\n/).map(line=>line.startsWith('#')?line.replace(/URI="([^"]+)"/g,(_,v)=>`URI="${rewrite(v)}"`):line.trim()?rewrite(line.trim()):line).join('\n');
      return new Response(rewritten,{headers:out});
    }
    for(const name of ['Content-Range','Accept-Ranges','Content-Length']) { const v=res.headers.get(name); if(v&&(name!=='Content-Length'||!res.headers.get('content-encoding')||res.headers.get('content-encoding')==='identity')) out.set(name,v); }
    // Upstream URL, Location, Set-Cookie, and error text are never forwarded.
    return new Response(sessionStream(body,g.session),{status:res.status,headers:out});
  } catch { return answer({error:'Media unavailable'},502); }
}
