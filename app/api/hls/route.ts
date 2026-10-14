import { requireSession, sessionToken } from '@/lib/session';
import { buildStreamUrl } from '@/lib/xtream/urls';
import { relayMedia } from '@/lib/media-relay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) { try {
    const c = await requireSession(), s = await sessionToken(), id = new URL(req.url).searchParams.get('id');
    if (!id || !/^\d+$/.test(id))
        return new Response('ID invalide', { status: 400 });
    return relayMedia(buildStreamUrl(c, 'live', id, 'm3u8'), s, c.serverUrl, req);
}
catch {
    return new Response('Non authentifié', { status: 401 });
} }
