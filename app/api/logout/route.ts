import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { revokeSession } from '@/lib/session-store';
import { csrfAllowed, privateHeaders } from '@/lib/security';
export async function POST(req: Request) {
    if (!csrfAllowed(req))
        return NextResponse.json({ error: 'Origine refusée' }, { status: 403, headers: privateHeaders });
    try {
        await revokeSession((await cookies()).get('gtv_session')?.value);
    }
    catch {
        return NextResponse.json({ error: 'Déconnexion indisponible' }, { status: 503, headers: privateHeaders });
    }
    const r = NextResponse.json({ ok: true }, { headers: privateHeaders });
    r.cookies.set('gtv_session', '', { path: '/', maxAge: 0, httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' });
    return r;
}
export async function GET() { return NextResponse.json({ error: 'Utiliser POST' }, { status: 405, headers: { Allow: 'POST', ...privateHeaders } }); }
