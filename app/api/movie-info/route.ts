import { secureJson as secureJsonBase } from '@/lib/security-json';
﻿import { requireSession } from "@/lib/session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
 let responseCredentials:{username?:string;password?:string}|undefined;
 const secureJson=(body:unknown,init?:ResponseInit)=>secureJsonBase(body,init,responseCredentials);

  try {
    const { searchParams } = new URL(req.url);
    const id = searchParams.get("id");

    if (!id) {
      return secureJson({ error: "ID manquant" }, { status: 400 });
    }

    let creds: any;
    try {
      creds = await requireSession().then(c=>{responseCredentials=c;return c;});
    } catch (e) {
      return secureJson(
        { error: "Session non authentifiee" },
        { status: 401 }
      );
    }

    const host = (creds?.baseUrl || creds?.url || creds?.serverUrl || "").replace(/\/+$/, "");
    const u = creds?.username || creds?.user || "";
    const p = creds?.password || creds?.pass || "";

    if (!host || !u || !p) {
      return secureJson(
        { error: "Identifiants IPTV incomplets." },
        { status: 400 }
      );
    }

    const targetUrl = `${host}/player_api.php?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}&action=get_vod_info&vod_id=${id}`;

    const res = await fetch(targetUrl, {
      headers: { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" },
      cache: "no-store",
    });

    if (!res.ok) {
      return secureJson(
        { error: `Erreur serveur IPTV (${res.status})` },
        { status: res.status }
      );
    }

    const data = await res.json();
    return secureJson(data);
  } catch (err: any) {
    void 0;
    return secureJson({ error: "Requête indisponible" }, { status: 500 });
  }
}
