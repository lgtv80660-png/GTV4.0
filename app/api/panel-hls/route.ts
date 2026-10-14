import {requireSession,sessionToken} from '@/lib/session';
import {buildStreamUrl} from '@/lib/xtream/urls';
import {panelEnabled,openPanel,servePanel} from '@/lib/panel-bridge';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request) {
  if(!panelEnabled())return new Response('Disabled',{status:404});
  let c,s;try{c=await requireSession();s=await sessionToken();}catch{return new Response('Non authentifié',{status:401});}
  try {
    const u=new URL(req.url), token=u.searchParams.get('t'), id=u.searchParams.get('id');
    if(token && !id)return await servePanel(token,s,req);
    if(id && /^\d+$/.test(id) && !token)return await openPanel(buildStreamUrl(c,'live',id,'m3u8'),s,c.serverUrl,req);
    return new Response('Paramètres invalides',{status:400});
  } catch {return new Response('Relais indisponible',{status:502,headers:{'Cache-Control':'no-store'}});}
}
