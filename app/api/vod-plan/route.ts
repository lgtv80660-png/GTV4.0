import {requireSession,sessionToken} from '@/lib/session';
import {buildStreamUrl} from '@/lib/xtream/urls';
import {probeMedia,probeSeekStart} from '@/lib/media-probe';
import {privateHeaders} from '@/lib/security';
import {mediaFetch} from '@/lib/media-relay';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function GET(req:Request){try{
 const c=await requireSession(),u=new URL(req.url),type=u.searchParams.get('type')||'movie',id=u.searchParams.get('id')||'',ext=u.searchParams.get('ext')||'mp4';
 if(!['movie','series'].includes(type))throw Error();
 const source=buildStreamUrl(c,type,id,ext),owner=await sessionToken(),offset=Number(u.searchParams.get('t')||0);
 if(!Number.isFinite(offset)||offset<0||offset>864000)throw Error('MEDIA_SEEK_INVALID');
 let media;
 try{media=await probeMedia(source,owner);}catch(e){
  const cause=e instanceof Error?e.cause as {upstreamStatus?:number;reason?:string;blockedOrigin?:string}|undefined:undefined;
  // Some providers reject the probe's one-byte Range request. In local VOD,
  // permit a native attempt only after an ordinary GET passes the same pinned
  // DNS/redirect policy and the provider accepts the session's Xtream URL.
  if(process.env.GTV_LOCAL_RUNTIME!=='1'||offset!==0||!['mp4','m4v','webm'].includes(ext.toLowerCase())||!(e instanceof Error)||e.message!=='MEDIA_PROBE_UPSTREAM'||cause?.upstreamStatus!==502||cause.reason||cause.blockedOrigin)throw e;
  const direct=await mediaFetch(source,c.serverUrl,new Request('http://127.0.0.1/',{signal:AbortSignal.any([req.signal,AbortSignal.timeout(20000)])}));
  await direct.response.body?.cancel();
  if(!direct.response.ok)throw e;
  return Response.json({media:null,seekStart:0,preferred:'direct',fallback:null},{headers:privateHeaders});
 }
 if(req.signal.aborted)return new Response(null,{status:499});
 const seekStart=await probeSeekStart(source,owner,offset);
 return Response.json({media,seekStart,preferred:'direct',fallback:'copy-video-auto-audio'},{headers:privateHeaders});
}catch(e){if(e instanceof Error&&e.message==='SESSION_INVALID')return Response.json({error:'Non authentifié'},{status:401,headers:privateHeaders});const cause=e instanceof Error?e.cause as {exitCode?:number;upstreamStatus?:number;kind?:string;reason?:string;blockedOrigin?:string}|undefined:undefined;const rawCode=cause?.reason||(e instanceof Error?e.message:'');const code=/^MEDIA_[A-Z_]+$/.test(rawCode)?rawCode:'MEDIA_UNAVAILABLE';return Response.json({error:'Media unavailable',code,diagnostic:cause?{exitCode:cause.exitCode,upstreamStatus:cause.upstreamStatus,kind:cause.kind||cause.reason,blockedOrigin:cause.blockedOrigin}:undefined},{status:503,headers:privateHeaders});}}
