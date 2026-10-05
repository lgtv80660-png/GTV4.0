import { requireSession } from "@/lib/session";
import {
  createVodSession,
  findVodSession,
  vodManifest,
  vodSegment,
  SEGMENT,
} from "@/lib/vod-hls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Range, Content-Type, Accept",
  "Access-Control-Expose-Headers": "Content-Length, X-GTV-Session",
  "X-Content-Type-Options": "nosniff",
};

export async function GET(req: Request) {
  const url = new URL(req.url);

  try {
    const sessionId = url.searchParams.get("s");

    // =========================
    // HLS SESSION EXISTANTE
    // =========================
    if (sessionId) {
      const session = findVodSession(sessionId);

      if (!session) {
        return new Response("Session HLS expirée", {
          status: 404,
          headers,
        });
      }

      const file = url.searchParams.get("seg");

      if (file) {
        const match = /^seg-(\d{6})\.ts$/.exec(file);
        if (!match) {
          return new Response("Segment invalide", {
            status: 400,
            headers,
          });
        }

        const segIndex = Number(match[1]);
        const maxSegments = Math.ceil(session.duration / SEGMENT);

        if (segIndex < 0 || segIndex >= maxSegments) {
          return new Response("Index de segment hors limites", {
            status: 400,
            headers,
          });
        }

        const segment = await vodSegment(session, file);

        return new Response(new Uint8Array(segment), {
          headers: {
            ...headers,
            "Content-Type": "video/mp2t",
            "Content-Length": String(segment.length),
            "X-GTV-Session": session.id,
          },
        });
      }

      return new Response(vodManifest(session), {
        headers: {
          ...headers,
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "X-GTV-Session": session.id,
        },
      });
    }

    // =========================
    // CREATION SESSION VOD
    // =========================
    const type =
      url.searchParams.get("type") === "series" ? "series" : "movie";

    const id = url.searchParams.get("id") || "";

    const ext = (url.searchParams.get("ext") || "mkv").toLowerCase();

    if (!/^\d+$/.test(id)) {
      return new Response("ID VOD invalide", {
        status: 400,
        headers,
      });
    }

    if (!/^[a-z0-9]{1,10}$/.test(ext)) {
      return new Response("Extension invalide", {
        status: 400,
        headers,
      });
    }

    let host = url.searchParams.get("_h");
    let username = url.searchParams.get("_u");
    let password = url.searchParams.get("_p");

    if (!host || !username || !password) {
      try {
        const credentials = await requireSession();

        host = credentials.serverUrl || null;
        username = credentials.username || null;
        password = credentials.password || null;
      } catch {
        return new Response("Non autorisé", {
          status: 401,
          headers,
        });
      }
    }

    if (
      !host ||
      !username ||
      !password ||
      !/^https?:\/\//i.test(host)
    ) {
      return new Response("Identifiants Xtream incomplets", {
        status: 400,
        headers,
      });
    }

    const input =
      `${host.replace(/\/+$/, "")}/${type}/` +
      `${encodeURIComponent(username)}/` +
      `${encodeURIComponent(password)}/` +
      `${id}.${ext}`;

    const session = await createVodSession(input);

    return new Response(null, {
      status: 302,
      headers: {
        ...headers,
        Location: `/api/vod-hls?s=${session.id}`,
      },
    });
  } catch (error: any) {
    return new Response(error?.message || "Génération HLS indisponible", {
      status: 503,
      headers: {
        ...headers,
        "Retry-After": "2",
      },
    });
  }
}

export async function HEAD(req: Request) {
  const url = new URL(req.url);

  const sessionId = url.searchParams.get("s");

  const session = sessionId ? findVodSession(sessionId) : undefined;

  if (sessionId && !session) {
    return new Response(null, {
      status: 404,
      headers,
    });
  }

  return new Response(null, {
    headers: {
      ...headers,
      "Content-Type": url.searchParams.has("seg")
        ? "video/mp2t"
        : "application/vnd.apple.mpegurl",
    },
  });
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    },
  });
}