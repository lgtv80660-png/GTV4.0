import {probeMedia,cachedMedia} from '@/lib/media-probe';
import {mediaFetch} from '@/lib/media-relay';
import {buildStreamUrl} from '@/lib/xtream/urls';
import {privateMediaInput} from '@/lib/private-media-input';
import {trackMedia,playbackId,mediaEnvironment,spawnMedia} from '@/lib/media-processes';
import {sessionStream} from '@/lib/session-stream';
// app/api/stream-vod/route.ts

import {
  spawn,
} from "node:child_process";

import {
  requireSession,
  sessionToken,
} from "@/lib/session";

export const runtime =
  "nodejs";

export const dynamic =
  "force-dynamic";

const UA =
  "VLC/3.0.20 LibVLC/3.0.20";

const FFMPEG =
  process.env
    .FFMPEG_PATH ||
  "ffmpeg";

const RAILWAY_URL =
  (
    process.env
      .RAILWAY_PUBLIC_URL ||
    "https://gtv-30-production.up.railway.app"
  ).replace(
    /\/+$/,
    ""
  );

const NO_CACHE_HEADERS = {
  "Cache-Control":
    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",

  Pragma:
    "no-cache",

  Expires:
    "0",

  "Access-Control-Allow-Origin":
    "*",

  "X-Accel-Buffering":
    "no",
};

/* =========================================================
   HELPERS
========================================================= */

function cleanHost(
  value: string
) {
  return String(
    value ||
      ""
  ).replace(
    /\/+$/,
    ""
  );
}

function safeKill(
  process: ReturnType<
    typeof spawn
  >
) {
  try {
    if (
      !process.killed
    ) {
      process.kill(
        "SIGKILL"
      );
    }
  } catch {}
}

async function checkUrl(
  url: string, base: string
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(),
      3000
    );

  try {
    const {response}=await mediaFetch(url,base,new Request('http://127.0.0.1/',{headers:{Range:'bytes=0-0'},signal:controller.signal}));
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(
      timer
    );
  }
}

/* =========================================================
   INPUT URL
========================================================= */

async function resolveInputUrl({
  host,
  username,
  password,
  type,
  id,
  ext,
}: {
  host: string;
  username: string;
  password: string;
  type: string;
  id: string;
  ext: string;
}) {
  const clean =
    cleanHost(
      host
    );

  const folder =
    type ===
    "series"
      ? "series"
      : "movie";

  const build = (
    extension: string
  ) =>
    `${clean}/${folder}/${encodeURIComponent(
      username
    )}/${encodeURIComponent(
      password
    )}/${encodeURIComponent(
      id
    )}.${extension}`;

  const primary =
    build(
      ext
    );

  /*
    On teste d'abord l'extension connue.
  */

  const primaryOk =
    await checkUrl(
      primary, clean
    );

  if (
    primaryOk
  ) {
    return primary;
  }

  const fallbackExtensions =
    [
      "mkv",
      "mp4",
      "ts",
      "avi",
    ].filter(
      (
        extension
      ) =>
        extension !==
        ext
    );

  for (
    const extension of
    fallbackExtensions
  ) {
    const candidate =
      build(
        extension
      );

    const ok =
      await checkUrl(
        candidate, clean
      );

    if (ok) {
      return candidate;
    }
  }

  /*
    Certains hosts refusent HEAD
    mais acceptent FFmpeg GET.

    On laisse donc quand même FFmpeg
    tenter l'URL principale.
  */

  return primary;
}

/* =========================================================
   GET
========================================================= */

export async function GET(
  req: Request
) {
  const requestStarted=performance.now();
  try {
    const url =
      new URL(
        req.url
      );

    const {
      searchParams,
    } =
      url;

    const rawType =
      searchParams.get(
        "type"
      ) ||
      "movie";

    const type =
      rawType ===
      "series"
        ? "series"
        : "movie";

    const id =
      searchParams.get(
        "id"
      );

    const originalExt =
      (
        searchParams.get(
          "ext"
        ) ||
        "mkv"
      )
        .toLowerCase()
        .replace(
          /[^a-z0-9]/g,
          ""
        ) ||
      "mkv";

    const rawSeek =
      Number(
        searchParams.get(
          "t"
        ) ||
          0
      );

    const t =
      Number.isFinite(
        rawSeek
      )
        ? Math.max(
            0,
            Math.floor(
              rawSeek
            )
          )
        : 0;

    if (!id || !/^\d+$/.test(id)) {
      return new Response(
        "ID manquant",
        {
          status:
            400,

          headers:
            NO_CACHE_HEADERS,
        }
      );
    }

    /* =====================================================
       CREDENTIALS DIRECTES RAILWAY
    ===================================================== */

    if (['_h','_u','_p'].some(k=>searchParams.has(k)))return new Response('Credentials URL refusés',{status:400});
    const secureCredentials=await requireSession();
    const rawHost=cleanHost(secureCredentials.serverUrl),username=secureCredentials.username,password=secureCredentials.password;

    const owner=await sessionToken();
    const primary=buildStreamUrl(secureCredentials,type,id,originalExt);
    // The plan already validated and probed this source. Do not repeat an
    // upstream availability request on every fallback startup and seek.
    const inputUrl = cachedMedia(primary,owner) ? primary :
      await resolveInputUrl({
        host:
          rawHost,

        username,

        password,

        type,

        id,

        ext:
          originalExt,
      });

    /* =====================================================
       FFMPEG

       VIDEO :
       COPY uniquement.

       AUDIO :
       AAC stéréo.

       AUDIO ASYNC :
       corrige trous / petites dérives
       de timestamps AC3 / EAC3 / DTS.

       SEEK :
       -ss AVANT -i.
    ===================================================== */

    const metadata=await probeMedia(inputUrl,owner);
    if(req.signal.aborted)return new Response(null,{status:499});
    const audio=metadata.audio.find(a=>a.default)||metadata.audio[0];
    const copyAudio=!audio||(audio.codec==='aac'&&audio.profile==='LC'&&audio.channels<=2);
    const playback=playbackId(searchParams.get('p'));
    const diagnose=process.env.GTV_LOCAL_RUNTIME==='1';
    const traceId=diagnose?Math.random().toString(36).slice(2,10):'';
    const trace=(event:string,details:Record<string,unknown>={})=>{if(diagnose)console.info('[stream-vod]',JSON.stringify({traceId,event,ms:Math.round(performance.now()-requestStarted),t,...details}));};
    const relay=await privateMediaInput(inputUrl,owner);
    const args = [
      "-hide_banner",

      "-loglevel",
      "error",

      "-nostdin",
      ...(diagnose?["-progress","pipe:2","-nostats"]:[]),

      "-user_agent",
      UA,

      /*
        Génère des timestamps si la source MKV
        en a de mauvais ou certains manquent.
      */
      "-noaccurate_seek",
      "-fflags",
      "+genpts",

      /*
        Réduit les blocages réseau
        sur certaines sources.
      */
      "-rw_timeout",
      "15000000",
      // This provider truncates open-ended reads. Keep every FFmpeg read bounded
      // when the probe has established real byte-range support.
      ...(metadata.byteRanges?["-request_size","2097152","-initial_request_size","2097152"]:[]),

      /*
        Seek serveur rapide.
      */
      ...(t >
      0
        ? [
            "-ss",
            String(
              t
            ),
          ]
        : []),

      "-threads", "2",
      "-i",
      relay.url,

      /*
        Première vidéo.
      */
      "-map",
      "0:v:0",

      /*
        Première piste audio si disponible.
      */
      "-map",
      `0:a:${audio?.ordinal??0}?`,

      /*
        VIDEO = ZERO TRANSCODAGE.
      */
      "-c:v",
      "copy",

      "-threads:a", "1",
      "-c:a",copyAudio?"copy":"aac",
      ...(copyAudio?[]:["-profile:a","aac_low","-ac","2","-ar","48000","-b:a","192k"]),

      /*
        Évite timestamps négatifs
        après input seek.
      */
      "-avoid_negative_ts",
      "make_zero",

      /*
        Laisse le muxeur attendre suffisamment
        audio + vidéo sans créer de trous.
      */
      "-max_interleave_delta",
      "0",

      /*
        MP4 fragmenté lisible immédiatement.
      */
      "-movflags",
      "frag_keyframe+delay_moov+default_base_moof",

      /*
        Sortie streaming.
      */
      "-f",
      "mp4",

      "pipe:1",
    ];

    void 0;

    let ff:ReturnType<typeof spawnMedia>;
    try{ff =
      spawnMedia(
        "ffmpeg",
        /* turbopackIgnore: true */
        FFMPEG,
        args,
        {
          windowsHide:true,env:mediaEnvironment(),
      stdio: [
            "ignore",
            "pipe",
            "pipe",
          ],
        }
      );

    }catch(e){relay.close();throw e;}
    trackMedia(ff,owner,playback,()=>relay.close(),req.signal);
    let producedBytes=0,lastDataMs=0,mediaUs=0;
    trace('ffmpeg-start',{pid:ff.pid});
    const diagnostics=diagnose?setInterval(()=>trace('progress',{producedBytes,lastDataMs,paused:ff.stdout.isPaused(),mediaUs,upstreamStatus:relay.status(),upstreamReason:relay.reason()}),5000):undefined;
    diagnostics?.unref();
    ff.once('close',(code,signal)=>{if(diagnostics)clearInterval(diagnostics);const errors=stderr.split(/\r?\n/).filter(line=>line&&!/^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/.test(line)).join('\n').replace(/https?:\/\/[^\s'"\]]+/g,'[private-input]');let redacted=errors;for(const value of [rawHost,username,password])if(value)redacted=redacted.split(value).join('[masked]');trace('ffmpeg-close',{code,signal,producedBytes,mediaUs,upstreamStatus:relay.status(),upstreamReason:relay.reason(),errors:redacted.slice(-2000)});});
    let stderr =
      "";

    let streamClosed =
      false;

    ff.stderr.on(
      "data",
      (
        chunk
      ) => {
        stderr +=
          chunk.toString();
        for(const match of chunk.toString().matchAll(/out_time_us=(\d+)/g))mediaUs=Number(match[1]);

        if (
          stderr.length >
          12000
        ) {
          stderr =
            stderr.slice(
              -12000
            );
        }
      }
    );

    ff.on(
      "close",
      (
        code,
        signal
      ) => {
        if (
          code !==
            0 &&
          code !==
            null &&
          signal !==
            "SIGKILL"
        ) {
          void 0;
        }
      }
    );

    ff.on(
      "error",
      (
        error
      ) => {
        void 0;
      }
    );

    /* =====================================================
       STREAM AVEC BACKPRESSURE

       Important pour éviter :
       - RAM qui monte
       - pipe qui sature
       - à-coups inutiles
    ===================================================== */

    const stream =
      new ReadableStream<
        Uint8Array
      >({
        start(
          controller
        ) {
          ff.stdout.on(
            "data",
            (
              chunk:
                Buffer
            ) => {
              producedBytes+=chunk.length;lastDataMs=Math.round(performance.now()-requestStarted);
              if (
                streamClosed
              ) {
                return;
              }

              try {
                controller.enqueue(
                  new Uint8Array(
                    chunk
                  )
                );

                /*
                  Si le navigateur ne consomme
                  plus assez vite, on pause stdout.

                  pull() le relancera.
                */
                if (
                  controller.desiredSize !==
                    null &&
                  controller.desiredSize <=
                    0
                ) {
                  ff.stdout.pause();
                }
              } catch {
                streamClosed =
                  true;

                safeKill(
                  ff
                );
              }
            }
          );

          ff.stdout.on(
            "end",
            () => {
              trace('stdout-end',{producedBytes});
            }
          );

          // FFmpeg can exit 0 after an input read error. Do not turn a truncated
          // movie into a successful short MP4 merely because stdout reached EOF.
          ff.once(
            "close",
            (code) => {
              if (
                streamClosed
              ) {
                return;
              }

              streamClosed =
                true;

              try {
                if(code!==0||/Read error|Error during demuxing|Stream ends prematurely|I\/O error/i.test(stderr))controller.error(new Error('Media unavailable'));
                else controller.close();
              } catch {}
            }
          );

          ff.stdout.on(
            "error",
            (
              error
            ) => {
              if (
                streamClosed
              ) {
                return;
              }

              streamClosed =
                true;

              try {
                controller.error(new Error('Media unavailable'));
              } catch {}

              safeKill(
                ff
              );
            }
          );

          ff.on(
            "error",
            (
              error
            ) => {
              if (
                streamClosed
              ) {
                return;
              }

              streamClosed =
                true;

              try {
                controller.error(new Error('Media unavailable'));
              } catch {}
            }
          );
        },

        pull() {
          try {
            if (
              ff.stdout
                .isPaused()
            ) {
              ff.stdout.resume();
            }
          } catch {}
        },

        cancel() {
          trace('response-cancel',{producedBytes});
          streamClosed =
            true;

          safeKill(
            ff
          );
        },
      });

    /* =====================================================
       CLIENT ABORT
    ===================================================== */

    const abortHandler =
      () => {
        trace('request-abort',{producedBytes});
        streamClosed =
          true;

        safeKill(
          ff
        );
      };

    if (
      req.signal
        .aborted
    ) {
      abortHandler();
    } else {
      req.signal.addEventListener(
        "abort",
        abortHandler,
        {
          once:
            true,
        }
      );
    }

    /* =====================================================
       RESPONSE
    ===================================================== */

    return new Response(sessionStream(stream,await sessionToken()),
      {
        status:
          200,

        headers: {
          ...NO_CACHE_HEADERS,

          "Content-Type":
            "video/mp4",

          "Content-Disposition":
            "inline",

          "Accept-Ranges":
            "none",

          "X-GTV-Mode":
            "video-copy-audio-aac",

          "X-GTV-Seek":
            String(
              t
            ),
        },
      }
    );
  } catch (
    error:
      any
  ) {
    void 0;

    return new Response(
      "Média indisponible",
      {
        status:
          500,

        headers:
          NO_CACHE_HEADERS,
      }
    );
  }
}
