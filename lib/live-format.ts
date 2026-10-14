// Inspect a bounded prefix without losing bytes or waiting for Live EOF.
export async function inspectLive(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader(), chunks: Uint8Array[] = [];
  const prefix = new Uint8Array(564); let length = 0;
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => { void reader.cancel().catch(()=>{}); rejectAbort(Error('Live cancelled')); };
  const timer = setTimeout(abort, 5000);
  signal.addEventListener('abort', abort, {once:true});
  try {
    if (signal.aborted) abort();
    while (length < prefix.length) {
      const next = await Promise.race([reader.read(), cancelled]);
      if (next.done) break;
      chunks.push(next.value);
      const part = next.value.subarray(0, prefix.length-length);
      prefix.set(part,length); length += part.length;
      if (new TextDecoder().decode(prefix.subarray(0,length)).replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U')) break;
    }
    const hls = new TextDecoder().decode(prefix.subarray(0,length)).replace(/^\uFEFF/, '').trimStart().startsWith('#EXTM3U');
    const ts = length >= 377 && prefix[0] === 0x47 && prefix[188] === 0x47 && prefix[376] === 0x47;
    if (!hls && !ts) throw Error('Invalid Live format');
    const replay = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try { if (chunks.length) { controller.enqueue(chunks.shift()!); return; }
          const next = await reader.read(); if (next.done) {reader.releaseLock();controller.close();} else controller.enqueue(next.value);
        } catch (error) {controller.error(error);}
      },
      async cancel(reason) {try {await reader.cancel(reason);} finally {reader.releaseLock();}}
    });
    return {playlist:hls, body:replay};
  } catch (error) {await reader.cancel().catch(()=>{});reader.releaseLock();throw error;}
  finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

export async function readDesktopPlaylist(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader(); const parts: Uint8Array[] = []; let length = 0;
  let rejectAbort: (reason: Error) => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {rejectAbort = reject;});
  const abort = () => {void reader.cancel().catch(()=>{});rejectAbort(Error('Playlist cancelled'));};
  const timer = setTimeout(abort, 5000); signal.addEventListener('abort',abort,{once:true});
  try {
    if(signal.aborted) abort();
    for(;;) {const next=await Promise.race([reader.read(),cancelled]);if(next.done)break;
      length+=next.value.length;if(length>1_000_000)throw Error('Playlist too large');parts.push(next.value);}
    const text=Buffer.concat(parts).toString('utf8').replace(/^\uFEFF/, '').trimStart();
    if(!text.startsWith('#EXTM3U'))throw Error('Invalid playlist');return text;
  } finally {clearTimeout(timer);signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
