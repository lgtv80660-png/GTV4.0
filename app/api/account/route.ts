import { secureJson as secureJsonBase } from '@/lib/security-json';
﻿import { requireSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
 let responseCredentials:{username?:string;password?:string}|undefined;
 const secureJson=(body:unknown,init?:ResponseInit)=>secureJsonBase(body,init,responseCredentials);

  try {
    const c = await requireSession().then(c=>{responseCredentials=c;return c;});

    if (!c.serverUrl || !c.username || !c.password) {
      return secureJson({ ok: false, error: "Session incomplete" }, { status: 401 });
    }

    const base = c.serverUrl.replace(/\/+$/, "");
    const params = new URLSearchParams({
      username: c.username,
      password: c.password,
    });

    const response = await fetch(`${base}/player_api.php?${params.toString()}`, {
      cache: "no-store",
    });

    if (!response.ok) {
      return secureJson({ ok: false }, { status: response.status });
    }

    const data = await response.json();
    const user = data?.user_info ?? {};

    return secureJson({
      ok: true,
      username: user.username ?? c.username,
      status: user.status ?? null,
      expDate: user.exp_date ?? null,
      maxConnections: user.max_connections ?? null,
      activeConnections: user.active_cons ?? null,
    });
  } catch {
    return secureJson({ ok: false }, { status: 401 });
  }
}
