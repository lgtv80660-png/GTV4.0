import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createSession, revokeSession, SESSION_SECONDS, loginBudget } from '@/lib/session-store';
import { csrfAllowed, privateHeaders } from '@/lib/security';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function POST(req: Request) {
    const answer = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: privateHeaders });
    if (!csrfAllowed(req))
        return answer({ error: 'Origine refusée' }, 403);
    try {
        if (!req.headers.get('content-type')?.includes('application/json'))
            return answer({ error: 'Requête invalide' }, 415);
        const raw = await req.text();
        if (raw.length > 8192)
            return answer({ error: 'Requête invalide' }, 413);
        const { username, password } = JSON.parse(raw);
        if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length > 256 || password.length > 1024 || /[\x00-\x1f]/.test(username + password))
            return answer({ error: 'Identifiants invalides' }, 400);
        await loginBudget(username.trim());
        const base = new URL(process.env.XTREAM_SERVER_URL || '');
        if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && process.env.NODE_ENV === 'production'))
            throw Error('AUTH_UNAVAILABLE');
        const url = new URL('/player_api.php', base);
        url.searchParams.set('username', username.trim());
        url.searchParams.set('password', password);
        const upstream = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
        if (!upstream.ok)
            return answer({ error: 'Authentification indisponible' }, 502);
        const text = await upstream.text();
        if (text.length > 131072)
            throw Error('AUTH_UNAVAILABLE');
        const user = JSON.parse(text)?.user_info;
        if (Number(user?.auth) !== 1 || user.status !== 'Active' || (user.exp_date && (!Number.isFinite(Number(user.exp_date)) || Number(user.exp_date) * 1000 <= Date.now())))
            return answer({ error: 'Identifiants refusés' }, 401);
        const token = await createSession({ serverUrl: base.href.replace(/\/+$/, ''), username: username.trim(), password });
        try {
            await revokeSession((await cookies()).get('gtv_session')?.value);
        }
        catch {
            await revokeSession(token);
            throw Error('SESSION_UNAVAILABLE');
        }
        const r = answer({ success: true, user: { status: user.status, exp_date: user.exp_date ?? null } });
        r.cookies.set('gtv_session', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: SESSION_SECONDS });
        return r;
    }
    catch (e) {
        return answer({ error: e instanceof Error && e.message === 'LOGIN_RATE_LIMIT' ? 'Trop de tentatives' : 'Connexion indisponible' }, e instanceof Error && e.message === 'LOGIN_RATE_LIMIT' ? 429 : 503);
    }
}
