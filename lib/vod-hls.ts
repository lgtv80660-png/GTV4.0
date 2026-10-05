import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// 4 secondes pour stabiliser le buffer réseau
export const SEGMENT = 4;
const ROOT = path.join(tmpdir(), "gtv-vod-hls");
const IDLE_TTL = 4 * 60 * 60 * 1000;
const UA = "VLC/3.0.20 LibVLC/3.0.20";

type Session = {
  id: string;
  input: string;
  duration: number;
  dir: string;
  touched: number;
  process?: ReturnType<typeof spawn>;
  currentProcessStartIndex: number; 
  lastRequestedIndex?: number; // Suivi des sauts de lecture (seek)
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
  // eslint-disable-next-line no-var
  var __gtvVodHlsV2: Registry | undefined;
}

const registry: Registry = globalThis.__gtvVodHlsV2 ??= {
  sessions: new Map(),
  creating: new Map(),
  active: 0,
  waiting: [],
};

async function acquire() {
  if (registry.active >= 4) {
    await new Promise<void>((resolve) => registry.waiting.push(resolve));
  } else {
    registry.active++;
  }
}

function release() {
  const next = registry.waiting.shift();
  if (next) next();
  else registry.active--;
}

if (!registry.timer) {
  registry.timer = setInterval(() => {
    for (const [key, session] of registry.sessions) {
      if (Date.now() - session.touched < IDLE_TTL) continue;
      registry.sessions.delete(key);
      if (session.process) {
        session.process.kill("SIGKILL");
      }
      void rm(session.dir, { recursive: true, force: true }).catch(() => {});
    }
  }, 60_000);
  registry.timer.unref();
}

function inputOptions(input: string) {
  return /^https?:/.test(input)
    ? [
        "-user_agent", UA,
        "-rw_timeout", "15000000",
        "-reconnect", "1",
        "-reconnect_streamed", "1",
        "-reconnect_on_network_error", "1",
        "-reconnect_on_http_error", "5xx",
        "-reconnect_delay_max", "2",
      ]
    : [];
}

async function probeDuration(input: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.env.FFPROBE_PATH || "ffprobe",
      [
        "-v", "error",
        ...inputOptions(input),
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        input,
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    );

    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("VOD metadata timeout"));
    }, 20_000);

    child.stdout.on("data", (chunk) => {
      output = (output + chunk.toString()).slice(-1024);
    });

    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("FFprobe unavailable"));
    });

    child.once("close", (code) => {
      clearTimeout(timer);
      const seconds = Number(output.trim());
      if (code !== 0 || !Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) {
        reject(new Error("Unable to determine finite VOD duration"));
      } else {
        resolve(seconds);
      }
    });
  });
}

function startEncoder(session: Session, startIndex: number, forceRestart: boolean) {
  // Si l'encodeur tourne déjà sur la bonne zone et qu'on ne force pas le redémarrage
  if (session.process && !forceRestart && !session.failed) {
    return;
  }

  // Tuer le processus précédent s'il y a un saut (seek)
  if (session.process) {
    session.process.kill("SIGKILL");
    session.process = undefined;
  }

  session.failed = false;
  session.errorMessage = undefined;
  session.currentProcessStartIndex = startIndex;

  const startTimeInSeconds = startIndex * SEGMENT;

  void (async () => {
    await acquire();
    try {
      const child = spawn(
        process.env.FFMPEG_PATH || "ffmpeg",
        [
          "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
          
          // Fast-seek pour démarrer instantanément à la bonne minute
          "-ss", String(startTimeInSeconds),
          ...inputOptions(session.input),
          "-i", session.input,
          
          // CRUCIAL : Force les timestamps HLS à correspondre au temps réel de la vidéo (évite les micro-coupures de saut)
          "-output_ts_offset", String(startTimeInSeconds),
          
          "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn",
          
          // Vidéo
          "-c:v", "libx264",
          "-preset", "ultrafast",
          "-tune", "zerolatency",
          "-profile:v", "main",
          "-level:v", "4.1",
          "-pix_fmt", "yuv420p",
          "-crf", "23",
          "-vf", "scale=w='min(1920,iw)':h='min(1080,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=25",
          "-fps_mode", "cfr",
          "-flags", "+cgop",
          "-g", "100", 
          "-keyint_min", "100",
          "-sc_threshold", "0",
          
          // Audio
          "-c:a", "aac",
          "-ac", "2",
          "-b:a", "128k",
          "-ar", "48000",
          "-af", "aresample=async=1:first_pts=0",
          
          // Sortie HLS
          "-f", "hls",
          "-hls_time", String(SEGMENT),
          "-hls_list_size", "0",
          "-hls_playlist_type", "vod",
          "-hls_flags", "independent_segments+temp_file",
          "-muxdelay", "0",
          "-hls_segment_type", "mpegts",
          "-start_number", String(startIndex), // Nomme correctement le segment même si on a fait un bond en avant
          "-hls_segment_filename", path.join(session.dir, "seg-%06d.ts"),
          path.join(session.dir, `index_${startIndex}.m3u8`), // Manifest jetable
        ],
        { stdio: ["ignore", "ignore", "pipe"] }
      );

      session.process = child;

      let stderrOutput = "";
      if (child.stderr) {
        child.stderr.on("data", (chunk) => {
          stderrOutput = (stderrOutput + chunk.toString()).slice(-2048);
        });
      }

      child.once("error", (err) => {
        session.failed = true;
        session.errorMessage = err.message;
      });

      child.once("close", (code) => {
        if (code !== 0 && code !== null) {
          session.failed = true;
          session.errorMessage = `FFmpeg error ${code}: ${stderrOutput}`;
        }
      });
    } catch (err: any) {
      session.failed = true;
      session.errorMessage = err?.message || "Encoder failure";
    } finally {
      release();
    }
  })();
}

export async function createVodSession(input: string) {
  const key = createHash("sha256").update(input).digest("hex");
  const existing = registry.sessions.get(key);
  if (existing) {
    existing.touched = Date.now();
    return existing;
  }

  const pending = registry.creating.get(key);
  if (pending) return pending;

  const creating = (async () => {
    const duration = await probeDuration(input);
    const id = randomUUID();
    const dir = path.join(ROOT, id);
    await mkdir(dir, { recursive: true });
    const session: Session = {
      id,
      input,
      duration,
      dir,
      touched: Date.now(),
      failed: false,
      currentProcessStartIndex: -1,
    };
    registry.sessions.set(key, session);
    return session;
  })();

  registry.creating.set(key, creating);
  try {
    return await creating;
  } finally {
    registry.creating.delete(key);
  }
}

export function findVodSession(id: string) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return undefined;
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
    "#EXT-X-INDEPENDENT-SEGMENTS",
    "#EXT-X-START:TIME-OFFSET=0,PRECISE=YES",
  ];

  const count = Math.ceil(session.duration / SEGMENT);
  for (let index = 0; index < count; index++) {
    lines.push(
      `#EXTINF:${Math.min(SEGMENT, session.duration - index * SEGMENT).toFixed(6)},`,
      `/api/vod-hls?s=${session.id}&seg=seg-${String(index).padStart(6, "0")}.ts`
    );
  }

  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

export async function vodSegment(session: Session, file: string): Promise<Buffer> {
  const match = /^seg-(\d{6})\.ts$/.exec(file);
  if (!match) throw new Error("Invalid segment");

  const index = Number(match[1]);
  if (index >= Math.ceil(session.duration / SEGMENT)) throw new Error("Invalid segment index");

  // Détection d'un saut de lecture (seek) par l'utilisateur
  const isSequential = 
    session.lastRequestedIndex !== undefined &&
    index >= session.currentProcessStartIndex &&
    index <= session.lastRequestedIndex + 3; // Tolère 3 segments d'avance de pré-chargement

  if (!isSequential) {
    // L'utilisateur a cliqué plus loin sur la barre : on force le redémarrage ciblé
    startEncoder(session, index, true);
  } else {
    // Lecture normale : on s'assure juste que l'encodeur tourne
    startEncoder(session, index, false);
  }
  
  session.lastRequestedIndex = index;

  const target = path.join(session.dir, file);
  const deadline = Date.now() + 60_000;

  while (Date.now() < deadline) {
    session.touched = Date.now();

    try {
      const st = await stat(target);
      if (st.size > 0) {
        return await readFile(target);
      }
    } catch {}

    if (session.failed) {
      throw new Error(session.errorMessage || "Encodage échoué");
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error("Délai d'attente du segment dépassé");
}