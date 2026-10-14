import { requireSession, sessionToken } from '@/lib/session';
import { readResource } from '@/lib/session-store';
import { relayMedia } from '@/lib/media-relay';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) { try {
    const c = await requireSession(), s = await sessionToken(), u = new URL(req.url);
    if (u.searchParams.has('url'))
        return new Response('URL refusée', { status: 400 });
    const source = await readResource(s, u.searchParams.get('t') || '');
    return relayMedia(source, s, c.serverUrl, req, true);
}
catch {
    return new Response('Ressource refusée', { status: 403, headers: { 'Cache-Control': 'no-store' } });
} }
