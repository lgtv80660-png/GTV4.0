import {mediaFetch} from './media-relay';
import {readSession} from './session-store';
import {spawnMedia} from './media-processes';
import {createHash} from 'node:crypto';
import {privateMediaInput} from './private-media-input';
import {trackMedia,mediaEnvironment} from './media-processes';
type Media={duration:number;startTime:number;container:string;byteRanges:boolean;video:{codec:string;profile:string;level:number;pixelFormat:string;hdr:boolean;width:number;height:number;frameRate:string};audio:{codec:string;channels:number;profile:string;ordinal:number;default:boolean}[];subtitles:{codec:string;language:string}[]};
const state=globalThis as typeof globalThis & {gtvProbeCache?:Map<string,{expires:number;promise:Promise<Media>}>};
const cache=state.gtvProbeCache??=new Map();
export function cachedMedia(source:string,owner:string){
 const entry=cache.get(createHash('sha256').update(owner+'\n'+source).digest('hex'));
 return entry&&entry.expires>Date.now()?entry.promise:undefined;
}
export async function probeMedia(source:string,owner:string):Promise<Media>{
 const key=createHash('sha256').update(owner+'\n'+source).digest('hex'),old=cache.get(key);
 if(old&&old.expires>Date.now())return old.promise;
 const promise=(async()=>{
  const credentials=await readSession(owner);
  // Resolve and validate redirects before starting a probe process.
  const preflight=await mediaFetch(source,credentials.serverUrl,new Request('http://127.0.0.1/',{headers:{Range:'bytes=0-0'},signal:AbortSignal.timeout(20000)}));
  await preflight.response.body?.cancel();
  if(!preflight.response.ok)throw new Error('MEDIA_PROBE_UPSTREAM',{cause:{upstreamStatus:preflight.response.status}});
  // Accept-Ranges alone is not proof: require the requested partial response.
  const range=/^bytes 0-0\/(\d+)$/.exec(preflight.response.headers.get('content-range')||'');
  const byteRanges=preflight.response.status===206&&!!range&&Number(range[1])>1&&preflight.response.headers.get('content-length')==='1';
  const relay=await privateMediaInput(source,owner);
  try{return await new Promise<Media>((resolve,reject)=>{
   const child=spawnMedia('probe',process.env.FFPROBE_PATH||'ffprobe',['-v','error','-threads','1','-probesize','10000000','-analyzeduration','10000000','-rw_timeout','10000000','-show_streams','-show_format','-of','json',relay.url],{windowsHide:true,env:mediaEnvironment(),stdio:['ignore','pipe','pipe']});
   trackMedia(child,owner,'',()=>relay.close());let text='',errorKind='unknown';
   child.stderr.on('data',b=>{const text=b.toString();for(const [pattern,label]of [[/403|Forbidden/,'http-forbidden'],[/404|Not Found/,'http-not-found'],[/Connection refused/,'connection-refused'],[/Option .*not found|Unrecognized option/,'unsupported-option'],[/Invalid data/,'invalid-media'],[/End of file/,'end-of-file']] as const)if(pattern.test(text))errorKind=label;});
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('MEDIA_PROBE_TIMEOUT'));},15000);timer.unref();
   child.stdout.on('data',b=>{text+=b.toString();if(text.length>2_000_000){child.kill('SIGKILL');reject(Error('MEDIA_PROBE_INVALID'));}});
   child.once('error',()=>{clearTimeout(timer);reject(Error('MEDIA_PROBE_UNAVAILABLE'));});
   child.once('close',code=>{clearTimeout(timer);try{
    if(code!==0)throw Error();const data=JSON.parse(text),streams=data.streams||[],v=streams.find((s:any)=>s.codec_type==='video')||{};
    const duration=Number(data.format?.duration);if(!Number.isFinite(duration)||duration<=0)throw Error();
    resolve({duration,startTime:Number(data.format?.start_time)||0,container:data.format?.format_name||'',byteRanges,video:{codec:v.codec_name||'',profile:v.profile||'',level:v.level||0,pixelFormat:v.pix_fmt||'',hdr:['smpte2084','arib-std-b67'].includes(v.color_transfer),width:v.width||0,height:v.height||0,frameRate:v.avg_frame_rate||''},audio:streams.filter((s:any)=>s.codec_type==='audio').map((s:any,ordinal:number)=>({codec:s.codec_name,channels:s.channels||0,profile:s.profile||'',ordinal,default:s.disposition?.default===1})),subtitles:streams.filter((s:any)=>s.codec_type==='subtitle').map((s:any)=>({codec:s.codec_name,language:s.tags?.language||'und'}))});
   }catch{reject(new Error('MEDIA_PROBE_INVALID',{cause:{exitCode:code,upstreamStatus:relay.status(),kind:relay.reason()||errorKind,blockedOrigin:relay.blockedOrigin()}}));}});
  });}finally{relay.close();}
 })();
 cache.set(key,{expires:Date.now()+300000,promise});promise.catch(()=>{if(cache.get(key)?.promise===promise)cache.delete(key);});
 while(cache.size>128){const first=cache.keys().next().value;if(first===undefined)break;cache.delete(first);}
 return promise;
}

const seekCache=new Map<string,Promise<number>>();
export async function probeSeekStart(source:string,owner:string,offset:number){
 if(!Number.isFinite(offset)||offset<0||offset>864000)throw Error('MEDIA_SEEK_INVALID');
 if(offset===0)return 0;
 const metadata=await probeMedia(source,owner);
 const key=createHash('sha256').update(owner+'\n'+source+'\n'+offset).digest('hex');
 const old=seekCache.get(key);if(old)return old;
 const promise=(async()=>{const relay=await privateMediaInput(source,owner);try{return await new Promise<number>((resolve,reject)=>{
  const child=spawnMedia('probe',process.env.FFPROBE_PATH||'ffprobe',['-v','error','-threads','1','-rw_timeout','10000000','-select_streams','v:0','-read_intervals',String(offset+metadata.startTime)+'%+#1','-show_packets','-show_entries','packet=pts_time,dts_time','-of','json',relay.url],{windowsHide:true,env:mediaEnvironment(),stdio:['ignore','pipe','ignore']});
  trackMedia(child,owner,'',()=>relay.close());let text='',settled=false;
  const finish=(value?:number)=>{if(settled)return;settled=true;clearTimeout(timer);value===undefined?reject(Error('MEDIA_SEEK_UNAVAILABLE')):resolve(value);};
  const timer=setTimeout(()=>{child.kill('SIGKILL');finish();},15000);timer.unref();
  child.stdout.on('data',b=>{text+=b.toString();if(text.length>100000){child.kill('SIGKILL');finish();}});
  child.once('error',()=>finish());child.once('close',code=>{try{if(code!==0)throw Error();const data=JSON.parse(text),packet=data.packets?.[0],at=Number(packet?.dts_time??packet?.pts_time)-metadata.startTime;if(!Number.isFinite(at)||at<0||at>offset+0.1)throw Error();finish(at);}catch{finish();}});
 });}finally{relay.close();}})();
 seekCache.set(key,promise);promise.catch(()=>seekCache.delete(key));while(seekCache.size>64)seekCache.delete(seekCache.keys().next().value!);
 return promise;
}
