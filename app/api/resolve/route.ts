import { secureJson as secureJsonBase } from '@/lib/security-json';
﻿import { requireSession } from "@/lib/session";
import { buildStreamUrl } from "@/lib/xtream/urls";
import type { StreamKind } from "@/lib/xtream/types";

export const runtime = "nodejs";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const PROBE_TIMEOUT = 3000;

export async function GET(req: Request) {
 let responseCredentials:{username?:string;password?:string}|undefined;
 const secureJson=(body:unknown,init?:ResponseInit)=>secureJsonBase(body,init,responseCredentials);

  let creds: any;
  try {
    creds = await requireSession().then(c=>{responseCredentials=c;return c;});
  } catch {
    return secureJson({ error: "Non authentifie" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const type = searchParams.get("type") as StreamKind | null;
  const id = searchParams.get("id");
  const ext = searchParams.get("ext") || "mp4";

  if (!type || !id || !["live", "movie", "series"].includes(type)) {
    return secureJson({ error: "Requete invalide" }, { status: 400 });
  }

  let url = "";
  try {
    url = buildStreamUrl(creds, type, id, ext);
  } catch (e) {
    url = "";
  }

  let directOk = false;
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);

  if (url) {
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: { 
          "User-Agent": BROWSER_UA, 
          Range: "bytes=0-1", 
          Accept: "*/*" 
        },
        redirect: "follow",
        signal: ctrl.signal,
      });

      directOk = res.ok || res.status === 206;
      void 0;
      
      res.body?.cancel().catch(() => {});
    } catch (e) {
      void 0;
      directOk = false;
    } finally {
      clearTimeout(timer);
    }
  }

  return secureJson({ 
    url: '/api/vod-direct?'+new URLSearchParams({type,id,ext}).toString(), 
    directOk, 
    ext,
    proxyUrl: `/api/stream-vod?type=${type}&id=${id}&ext=${ext}`
  });
}
