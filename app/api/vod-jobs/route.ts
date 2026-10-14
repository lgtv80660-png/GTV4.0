import {requireSession,sessionToken} from '@/lib/session';
import {csrfAllowed,privateHeaders} from '@/lib/security';
import {playbackId,stopPlayback,activeMedia} from '@/lib/media-processes';
import {stopVodPlayback,touchVodPlayback} from '@/lib/vod-hls';
export const runtime='nodejs';export const dynamic='force-dynamic';
export async function POST(req:Request){
 if(!csrfAllowed(req))return Response.json({error:'Denied'},{status:403,headers:privateHeaders});
 try{await requireSession();const owner=await sessionToken(),body=await req.json(),p=playbackId(body.p);if(!p||!['stop','touch'].includes(body.action))throw Error();if(body.action==='stop'){stopPlayback(owner,p);await stopVodPlayback(owner,p);}else touchVodPlayback(owner,p);return Response.json({ok:true},{headers:privateHeaders});}
 catch{return Response.json({error:'Denied'},{status:401,headers:privateHeaders});}
}
export async function GET(){try{await requireSession();return Response.json({jobs:activeMedia(await sessionToken())},{headers:privateHeaders});}catch{return Response.json({error:'Denied'},{status:401,headers:privateHeaders});}}
