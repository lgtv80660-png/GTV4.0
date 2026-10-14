import { secureJson as secureJsonBase } from '@/lib/security-json';
import { requireSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CacheEntry = { expiresAt: number; value: unknown };
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();

function ttlFor(action: string) {
  if (action.includes("categories")) return 30 * 60 * 1000;
  if (action === "get_live_streams") return 10 * 60 * 1000;
  if (action === "get_vod_streams" || action === "get_series") return 15 * 60 * 1000;
  if (action.includes("info")) return 15 * 60 * 1000;
  return 2 * 60 * 1000;
}

function cacheable(action: string) {
  return [
    "get_live_categories",
    "get_live_streams",
    "get_vod_categories",
    "get_vod_streams",
    "get_series_categories",
    "get_series",
    "get_vod_info",
    "get_series_info",
  ].includes(action);
}

export async function GET(req: Request) {
 let responseCredentials:{username?:string;password?:string}|undefined;
 const secureJson=(body:unknown,init?:ResponseInit)=>secureJsonBase(body,init,responseCredentials);

  let creds: any;
  try {
    creds = await requireSession().then(c=>{responseCredentials=c;return c;});
  } catch {
    return secureJson({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const action = searchParams.get("action") || "";
    if (!['get_live_categories','get_live_streams','get_vod_categories','get_vod_streams','get_series_categories','get_series','get_vod_info','get_series_info','get_short_epg','get_simple_data_table'].includes(action))return secureJson({error:'Action refusée'},{status:400});
    const baseUrl = String(creds?.baseUrl || creds?.url || creds?.serverUrl || "").replace(/\/+$/, "");
    const username = String(creds?.username || creds?.user || "");
    const password = String(creds?.password || creds?.pass || "");

    if (!baseUrl || !username || !password) {
      return secureJson({ error: "Identifiants incomplets" }, { status: 400 });
    }

    const forwarded = new URLSearchParams();
    searchParams.forEach((value, key) => {
      if (['category_id','vod_id','series_id','stream_id','limit'].includes(key)) forwarded.append(key, value);
    });
    const cacheKey = `${baseUrl}|${username}|${action}|${forwarded.toString()}`;

    if (cacheable(action)) {
      const hit = cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        return secureJson(hit.value, {
          headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300", "x-gtv-cache": "hit" },
        });
      }
    }

    const load = async () => {
      const url = new URL(`${baseUrl}/player_api.php`);
      url.searchParams.set("username", username);
      url.searchParams.set("password", password);
      if (action) url.searchParams.set("action", action);
      forwarded.forEach((value, key) => url.searchParams.append(key, value));

      const res = await fetch(url.toString(), {
        headers: { "User-Agent": "GTV/3.0" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw Object.assign(new Error(`Erreur IPTV (${res.status})`), { status: res.status });
      return res.json();
    };

    let promise = inflight.get(cacheKey);
    if (!promise) {
      promise = load();
      inflight.set(cacheKey, promise);
    }

    let data: unknown;
    try {
      data = await promise;
    } finally {
      inflight.delete(cacheKey);
    }

    if (cacheable(action)) cache.set(cacheKey, { expiresAt: Date.now() + ttlFor(action), value: data });

    return secureJson(data, {
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=180", "x-gtv-cache": "miss" },
    });
  } catch (err: any) {
    return secureJson({ error: "Requête indisponible" }, { status: err?.status || 500 });
  }
}
