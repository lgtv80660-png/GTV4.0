import { requireSession, sessionToken } from '@/lib/session';
import { buildStreamUrl } from '@/lib/xtream/urls';
import { relayMedia } from '@/lib/media-relay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) { try {
    const c = await requireSession(), s = await sessionToken(), u = new URL(req.url), id = u.searchParams.get('id') || '', type = u.searchParams.get('type') || '', ext = u.searchParams.get('ext') || 'mp4';
    if (!/^\d+$/.test(id) || !['movie', 'series'].includes(type) || !/^[a-z0-9]{1,10}$/.test(ext))
        return new Response('Média invalide', { status: 400 });
    return relayMedia(buildStreamUrl(c, type, id, ext), s, c.serverUrl, req);
}
catch {
    return new Response('Non authentifié', { status: 401 });
} }

export const HEAD=GET;
