import {privateMediaInput} from './private-media-input';
import {probeMedia} from './media-probe';
import {trackMedia,stopChild,mediaEnvironment,spawnMedia} from './media-processes';
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const SEGMENT = 4;

const ROOT = path.join(tmpdir(), "gtv-an8-vod-hls");
const IDLE_TTL = 90 * 1000;
const UA = "VLC/3.0.20 LibVLC/3.0.20";

const MAX_ENCODERS = 1;
// Nombre de segments d'avance qu'on accepte d'attendre sans relancer FFmpeg
const LOOKAHEAD = 3;
const SEGMENT_TIMEOUT = 60000;
// Tolérance sur la précision des mtime (certains FS ont une granularité grossière)
const MTIME_TOLERANCE = 1000;

type Session = {
  id: string;
  input: string;
  owner: string;
  duration: number;
  playback:string;
  audioCopy?:boolean;
  audioOrdinal?:number;
  audioBitrate?:string;
  waiters?:Set<symbol>;
  relay?:Awaited<ReturnType<typeof privateMediaInput>>;
  dir: string;
  touched: number;

  process?: ChildProcess;
  currentProcessStartIndex: number;
  processStartedAt: number;

  // arrêt de l'ancien process + attente d'un slot + spawn
  transition?: Promise<void>;
  pendingStartIndex?: number;

  disposed: boolean;
  failed: boolean;
  errorMessage?: string;
};

type Registry = {
  sessions: Map<string, Session>;
  creating: Map<string, Promise<Session>>;

  active: number;
  waiting: Array<() => void>;

  timer?: ReturnType<typeof setInterval>;
};

declare global {
  var __gtvVodHlsV2: Registry | undefined;
}

const registry: Registry =
  globalThis.__gtvVodHlsV2 ??= {
    sessions: new Map(),
    creating: new Map(),
    active: 0,
    waiting: []
  };

// Process arrêtés volontairement par nous (restart / nettoyage) : pas une erreur
const stopped = new WeakSet<ChildProcess>();

const segName = (i: number) => `seg-${String(i).padStart(6, "0")}.ts`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquire() {
  if (registry.active >= MAX_ENCODERS) {
    // le slot est transmis directement par release() : active ne change pas
    await new Promise<void>((resolve) => {
      registry.waiting.push(resolve);
    });
  } else {
    registry.active++;
  }
}

function release() {
  const next = registry.waiting.shift();

  if (next) {
    next();
  } else {
    registry.active--;
  }
}

function destroySession(session: Session) {
  session.disposed = true;
  session.relay?.close();

  if (session.process) {
    stopped.add(session.process);
    stopChild(session.process);
  }

  void rm(session.dir, {
    recursive: true,
    force: true
  }).catch(() => {});
}

if (!registry.timer) {
  registry.timer = setInterval(() => {
    for (const [key, session] of registry.sessions) {
      if (Date.now() - session.touched < IDLE_TTL) {
        continue;
      }

      registry.sessions.delete(key);
      destroySession(session);
    }
  }, 60000);

  registry.timer.unref();
}

function inputOptions(input: string) {
  return /^https?:/i.test(input)
    ? [
        "-user_agent",
        UA,
        "-rw_timeout",
        "15000000",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_on_http_error",
        "5xx",
        "-reconnect_delay_max",
        "2"
      ]
    : [];
}

/**
 * Dernier segment réellement produit par le process courant :
 * on avance depuis le segment de départ tant que les fichiers existent
 * ET ont été écrits après le lancement du process (on ignore les restes
 * d'un ancien process qui aurait déjà couvert cette zone).
 */
async function frontier(session: Session) {
  let i = session.currentProcessStartIndex;

  for (;;) {
    try {
      const s = await stat(path.join(session.dir, segName(i)));

      if (
        s.size === 0 ||
        s.mtimeMs < session.processStartedAt - MTIME_TOLERANCE
      ) {
        break;
      }
    } catch {
      break;
    }

    i++;
  }

  return i - 1;
}

/**
 * Le segment sera-t-il produit bientôt par le process déjà en cours ?
 * Faux si : pas de process, transition en cours, seek en arrière,
 * ou seek trop loin devant la frontière générée.
 */
async function isReachable(session: Session, index: number) {
  if (session.transition || !session.process) {
    return false;
  }

  if (index < session.currentProcessStartIndex) {
    return false;
  }

  return index <= (await frontier(session)) + LOOKAHEAD;
}

function stopProcess(child: ChildProcess) {
  return new Promise<void>((resolve) => {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      resolve();
      return;
    }

    stopped.add(child);
    child.once("close", () => resolve());
    stopChild(child);
  });
}

async function spawnEncoder(session: Session, startIndex: number) {
  const relay=await privateMediaInput(session.input,session.owner);
  if(session.disposed){relay.close();throw Error('CANCELLED');}
  session.relay=relay;
  const start = startIndex * SEGMENT;

  const child = spawnMedia(
    "ffmpeg",
    process.env.FFMPEG_PATH || "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",

      "-threads", "2",
      "-filter_threads", "1",
      "-ss",
      String(start),

      ...inputOptions(relay.url),

      "-i",
      relay.url,
      "-t",String(SEGMENT*(LOOKAHEAD+2)),

      "-map",
      "0:v:0",
      "-map",
      `0:a:${session.audioOrdinal??0}?`,
      "-sn",
      "-dn",

      "-c:v",
      "libx264",
      "-threads:v", "2",
      "-threads:a", "1",
      "-preset",
      "ultrafast",
      "-tune",
      "zerolatency",

      "-crf",
      "23",
      "-fps_mode",
      "passthrough",

      "-force_key_frames",
      `expr:gte(t,n_forced*${SEGMENT})`,


      "-sc_threshold",
      "0",

      "-c:a",
      session.audioCopy?'copy':'aac',

      ...(session.audioCopy?[]:["-profile:a","aac_low","-ac","2","-ar","48000","-b:a",session.audioBitrate||"192k"]),

      // timestamps continus après un -ss d'entrée (sinon PTS repartent de 0)
      "-output_ts_offset",
      String(start),

      "-f",
      "hls",
      "-hls_time",
      String(SEGMENT),
      "-hls_list_size",
      "0",
      "-hls_playlist_type",
      "vod",
      "-hls_flags",
      "independent_segments+temp_file",
      "-start_number",
      String(startIndex),

      "-hls_segment_filename",
      path.join(session.dir, "seg-%06d.ts"),

      path.join(session.dir, "index.m3u8")
    ],
    {
      windowsHide:true,env:mediaEnvironment(),
      stdio: ["ignore", "ignore", "pipe"]
    }
  );

  trackMedia(child,session.owner,session.playback,()=>relay.close());
  let stderr = "";

  child.stderr?.on("data", (c) => {
    stderr = (stderr + c.toString()).slice(-2000);
  });

  // Le slot d'encodage est libéré uniquement quand FFmpeg se termine vraiment
  let finished = false;

  const finish = () => {
    if (finished) {
      return;
    }

    finished = true;

    if (session.process === child) {
      session.process = undefined;
    }

    release();
  };

  child.once("error", (e) => {
    session.failed = true;
    session.errorMessage = "Encoder failed";
    finish();
  });

  child.once("close", (code) => {
    finish();

    if (code !== 0 && code !== null && !stopped.has(child)) {
      session.failed = true;
      session.errorMessage =
        "Encoder failed";
    }
  });

  session.process = child;
  session.currentProcessStartIndex = startIndex;
  session.processStartedAt = Date.now();
}

/**
 * Démarre (ou redémarre) FFmpeg à startIndex.
 * Les appels pendant une transition ne lancent rien : ils mettent à jour la
 * cible, et c'est la dernière cible qui est utilisée au moment du spawn.
 */
function startEncoder(session: Session, startIndex: number) {
  const pending = session.pendingStartIndex;

  // une demande proche de la cible déjà retenue est couverte par elle
  if (
    pending === undefined ||
    startIndex < pending ||
    startIndex > pending + LOOKAHEAD
  ) {
    session.pendingStartIndex = startIndex;
  }

  if (session.transition) {
    return;
  }

  session.transition = (async () => {
    try {
      if (session.process) {
        await stopProcess(session.process);
      }

      await acquire();

      if (session.disposed || !session.waiters?.size) {
        release();
        return;
      }

      const target = session.pendingStartIndex ?? startIndex;
      session.pendingStartIndex = undefined;

      try {
        await spawnEncoder(session, target);
      } catch (e) {
        session.relay?.close();
        release();
        session.failed = true;
        session.errorMessage = "Encoder failed";
      }
    } finally {
      session.transition = undefined;
    }
  })();
}

export async function createVodSession(input: string, owner: string, playback="") {
  const key = createHash("sha256").update(owner+"\n"+playback+"\n"+input).digest("hex");

  const old = registry.sessions.get(key);

  if (old) {
    old.touched = Date.now();
    return old;
  }

  const running = registry.creating.get(key);

  if (running) {
    return running;
  }

  const promise = (async () => {
    const metadata=await probeMedia(input,owner);
    if(metadata.video.hdr||/10|12/.test(metadata.video.pixelFormat))throw Error("HDR_REQUIRES_COMPATIBLE_DIRECT_OR_DESKTOP");
    const duration=metadata.duration;
    const audio=metadata.audio.find(a=>a.default)||metadata.audio[0];
    const id = randomUUID();

    const dir = path.join(ROOT, id);

    await mkdir(dir, {
      recursive: true
    });

    const session: Session = {
      id,
      input,
      owner,
      playback,
      audioOrdinal:audio?.ordinal,
      audioCopy:!audio||(audio.codec==='aac'&&audio.profile==='LC'&&audio.channels<=2),
      audioBitrate:'192k',
      duration,
      dir,
      touched: Date.now(),
      disposed: false,
      failed: false,
      currentProcessStartIndex: 0,
      processStartedAt: 0
    };

    registry.sessions.set(key, session);

    // Manifest creation never launches a producer. Start only when a segment is requested.

    return session;
  })();

  registry.creating.set(key, promise);

  try {
    return await promise;
  } finally {
    registry.creating.delete(key);
  }
}

export function findVodSession(id: string) {
  for (const session of registry.sessions.values()) {
    if (session.id === id) {
      session.touched = Date.now();
      return session;
    }
  }
}

export function vodManifest(session: Session) {
  const lines = [
    "#EXTM3U",
    "#EXT-X-VERSION:3",
    `#EXT-X-TARGETDURATION:${SEGMENT}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
    "#EXT-X-PLAYLIST-TYPE:VOD",
    "#EXT-X-INDEPENDENT-SEGMENTS"
  ];

  const count = Math.ceil(session.duration / SEGMENT);

  for (let i = 0; i < count; i++) {
    // le dernier segment est généralement plus court
    const d = Math.min(SEGMENT, session.duration - i * SEGMENT);

    lines.push(
      `#EXTINF:${d.toFixed(3)},`,
      `/api/vod-hls?s=${session.id}&seg=${segName(i)}`
    );
  }

  lines.push("#EXT-X-ENDLIST");

  return lines.join("\n");
}

async function readIfReady(file: string) {
  try {
    const s = await stat(file);

    if (s.size > 0) {
      return await readFile(file);
    }
  } catch {}

  return null;
}

export async function vodSegment(session: Session, file: string, signal?:AbortSignal) {
  if(signal?.aborted)throw Error("CANCELLED");
  const waiter=Symbol(),waiters=session.waiters??=new Set<symbol>();waiters.add(waiter);
  const cancelled=()=>{waiters.delete(waiter);if(!waiters.size){session.pendingStartIndex=undefined;if(session.process)stopChild(session.process);}};
  signal?.addEventListener('abort',cancelled,{once:true});
  try {
  const match = /^seg-(\d{6})\.ts$/.exec(file);

  if (!match) {
    throw new Error("Invalid segment");
  }

  const index = Number(match[1]);

  if (index >= Math.ceil(session.duration / SEGMENT)) {
    throw new Error("Segment out of range");
  }

  session.touched = Date.now();

  const target = path.join(session.dir, file);

  // Déjà généré (par ce process ou un précédent) : on sert sans toucher à FFmpeg
  const cached = await readIfReady(target);

  if (cached) {
    return cached;
  }

  // Sinon : on ne relance que si le process courant ne peut pas l'atteindre bientôt
  if (!(await isReachable(session, index))) {
    startEncoder(session, index);
  }

  const deadline = Date.now() + SEGMENT_TIMEOUT;
  let retried = false;

  while (Date.now() < deadline) {
    if(signal?.aborted||session.disposed)throw Error("CANCELLED");
    const data = await readIfReady(target);

    if (data) {
      return data;
    }

    if (session.failed) {
      throw new Error(session.errorMessage || "Encoder failed");
    }

    // FFmpeg s'est arrêté sans produire ce segment : une seule relance
    if (!retried && !session.process && !session.transition) {
      retried = true;
      startEncoder(session, index);
    }

    await sleep(100);
  }

  throw new Error("Segment timeout");
  } finally {signal?.removeEventListener('abort',cancelled);waiters.delete(waiter);}
}
export async function stopVodPlayback(owner:string,playback:string){for(const [key,session]of registry.sessions)if(session.owner===owner&&session.playback===playback){registry.sessions.delete(key);destroySession(session);}}
export function touchVodPlayback(owner:string,playback:string){for(const session of registry.sessions.values())if(session.owner===owner&&session.playback===playback)session.touched=Date.now();}
