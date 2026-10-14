// Optional browser adapter. Existing stable player is untouched.
// Call only after an explicit product opt-in. Safari native HLS is not enabled.
export async function attachPanelPlayer(video: HTMLVideoElement, id: string, Hls: any, fetcher: typeof fetch = fetch) {
  if(!/^\d+$/.test(id)||!Hls.isSupported())throw Error('PANEL_PLAYER_UNSUPPORTED');
  let destroyed=false, hls:any, timer:ReturnType<typeof setTimeout>|undefined;
  let pending=false, hops=0;
  const abort=new AbortController();
  const clear=()=>{hls?.destroy();hls=undefined;video.pause();video.removeAttribute('src');video.load();};
  const stop=()=>{destroyed=true;abort.abort();if(timer)clearTimeout(timer);clear();};
  const local=(url:string)=>/^\/api\/panel-hls\?t=[A-Za-z0-9_-]{43}$/.test(url);
  const start=(url:string)=>{
    if(destroyed)return;
    if(!local(url))throw Error('PANEL_PLAYER_URL_INVALID');
    clear();pending=false;
    hls=new Hls({enableWorker:true,lowLatencyMode:false,
      xhrSetup:(xhr:XMLHttpRequest)=>{
        xhr.addEventListener('readystatechange',()=>{
          if(xhr.readyState!==4||destroyed||pending)return;
          const reopen=xhr.getResponseHeader('X-GTV-Reopen');
          if(xhr.getResponseHeader('X-GTV-Exhausted')==='1'){stop();return;}
          if(![409,502,503].includes(xhr.status)||!reopen)return;
          if(!local(reopen)||++hops>8){stop();return;}
          pending=true;hls?.stopLoad();
          const raw=xhr.getResponseHeader('Retry-After');
          const seconds=raw&&/^\d+$/.test(raw)?Math.max(1,Math.min(30,Number(raw))):3;
          // Destroy and clear the old decoder immediately; never mix generations.
          clear();timer=setTimeout(()=>start(reopen),seconds*1000);
        });
      }});
    hls.on(Hls.Events.ERROR,(_event:unknown,data:any)=>{
      if(!data.fatal||pending||destroyed)return;
      // Unsignalled errors do not open the public channel again.
      stop();
    });
    hls.loadSource(url);hls.attachMedia(video);
  };
  try {
    const r=await fetcher('/api/panel-hls?id='+encodeURIComponent(id),{cache:'no-store',signal:abort.signal});
    if(!r.ok)throw Error('PANEL_OPEN_FAILED');
    const data=await r.json();start(data.url);
  }catch(e){stop();throw e;}
  return {kind:'hls' as const,destroy:stop};
}
