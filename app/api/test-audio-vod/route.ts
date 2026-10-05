import { spawn, ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Full preprocessing is deliberate: no incomplete playlist is advertised as VOD.
const MAX_BYTES = 12 * 1024 ** 3;
const MAX_TIME = 45 * 60 * 1000;
const TTL = 60 * 60 * 1000;
type Job = { dir: string; state: "preparing" | "ready" | "failed"; touched: number; child?: ChildProcess; reason?: string; timer?: ReturnType<typeof setInterval> };
const globalLab = globalThis as typeof globalThis & { audioVodLab?: Map<string, Job> };
const jobs = globalLab.audioVodLab ??= new Map<string, Job>();

async function remove(key: string, job: Job) {
  job.child?.kill();
  if (job.timer) clearInterval(job.timer);
  jobs.delete(key);
  await rm(job.dir, { recursive: true, force: true });
}

async function prepare(job: Job, source: string) {
  const child = spawn(/* turbopackIgnore: true */ process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "2",
    "-rw_timeout", "30000000", "-fflags", "+genpts", "-i", source,
    "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy",
    "-c:a", "aac", "-ac", "2", "-b:a", "192k", "-threads", "2",
    "-avoid_negative_ts", "make_zero", "-f", "hls", "-hls_time", "6",
    "-hls_playlist_type", "vod", "-hls_list_size", "0",
    "-hls_segment_filename", join(job.dir, "segment-%06d.ts"),
    join(job.dir, "index.m3u8"),
  ], { windowsHide: true, stdio: "ignore" });
  job.child = child;
  const started = Date.now();
  const fail = (reason: string) => { job.reason = reason; job.state = "failed"; child.kill(); };
  let checking = false;
  job.timer = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const files = await readdir(job.dir);
      let bytes = 0;
      for (const file of files) bytes += (await stat(join(job.dir, file))).size;
      if (bytes > MAX_BYTES) fail("Limite de stockage de 12 Gio atteinte");
      if (Date.now() - started > MAX_TIME) fail("Limite de préparation de 45 minutes atteinte");
    } catch { fail("Échec du stockage temporaire"); }
    finally { checking = false; }
  }, 1000);
  job.timer.unref();
  await new Promise<void>(resolve => {
    child.once("error", () => { fail("FFmpeg indisponible"); resolve(); });
    child.once("close", code => { if (code !== 0 && !job.reason) fail("Préparation FFmpeg échouée (source ou codec)"); resolve(); });
  });
  clearInterval(job.timer);
  job.child = undefined;
  if (job.state !== "failed") {
    try {
      const playlist = await readFile(join(job.dir, "index.m3u8"), "utf8");
      if (!playlist.includes("#EXT-X-ENDLIST") || !playlist.includes("#EXT-X-PLAYLIST-TYPE:VOD") || !playlist.includes("#EXTINF:")) throw new Error();
      job.state = "ready";
    } catch { job.state = "failed"; job.reason = "Playlist VOD complète absente"; }
  }
  if (job.state === "failed") await rm(job.dir, { recursive: true, force: true });
}

const janitor = setInterval(() => {
  for (const [key, job] of jobs) if (Date.now() - job.touched > TTL) void remove(key, job).catch(() => {});
}, 60_000);
janitor.unref();

export async function GET(request: Request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !/^\d+$/.test(id)) return new Response("ID invalide", { status: 400 });
  let credentials;
  try { credentials = await requireSession(); } catch { return new Response("Non authentifié", { status: 401 }); }
  const { serverUrl, username, password } = credentials;
  if (!serverUrl || !username || !password) return new Response("Session incomplète", { status: 401 });
  const key = createHash("sha256").update(JSON.stringify([serverUrl, username, password, id])).digest("hex");
  const headers = { "Cache-Control": "no-store" };
  const asset = url.searchParams.get("asset");
  if (asset && asset !== "index.m3u8" && !/^segment-\d{6}\.ts$/.test(asset)) return new Response("Asset invalide", { status: 400 });
  let job = jobs.get(key);
  if (url.searchParams.get("cleanup") === "1") {
    if (job) await remove(key, job);
    return Response.json({ cleaned: true }, { headers });
  }
  if (!job) {
    if (asset) return new Response("Préparation expirée", { status: 410, headers });
    if (jobs.size >= 1) return new Response("Laboratoire occupé (un seul film à la fois)", { status: 429, headers });
    job = { dir: await mkdtemp(join(tmpdir(), "gtv-audio-vod-")), state: "preparing", touched: Date.now() };
    jobs.set(key, job);
    const source = `${serverUrl.replace(/\/+$/, "")}/movie/${encodeURIComponent(username)}/${encodeURIComponent(password)}/${id}.mkv`;
    void prepare(job, source).catch(async () => { job!.state = "failed"; job!.reason = "Préparation échouée"; await rm(job!.dir, { recursive: true, force: true }); });
  }
  job.touched = Date.now();
  if (job.state !== "ready") return Response.json({ state: job.state, reason: job.reason, limits: { storageGiB: 12, preparationMinutes: 45, retentionMinutes: 60 } }, { status: job.state === "failed" ? 502 : 202, headers: { ...headers, "Retry-After": "5" } });
  if (asset?.startsWith("segment-")) {
    try { return new Response(new Uint8Array(await readFile(join(job.dir, asset))), { headers: { ...headers, "Content-Type": "video/mp2t" } }); }
    catch { return new Response("Segment absent", { status: 404, headers }); }
  }
  const playlist = await readFile(join(job.dir, "index.m3u8"), "utf8");
  const rewritten = playlist.replace(/^segment-\d{6}\.ts$/gm, name => `/api/test-audio-vod?id=${id}&asset=${name}`);
  return new Response(rewritten, { headers: { ...headers, "Content-Type": "application/vnd.apple.mpegurl" } });
}
