import { NextRequest, NextResponse } from 'next/server';
import { csrfAllowed, privateHeaders } from './lib/security';
export function proxy(req: NextRequest) {
    const p = req.nextUrl.pathname;
    if (['_h', '_u', '_p', 'username', 'password'].some(k => req.nextUrl.searchParams.has(k)))
        return NextResponse.json({ error: 'Credentials URL refusés' }, { status: 400, headers: privateHeaders });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !csrfAllowed(req)) {
        // Engine redeems a short-lived capability without browser cookies or credentials.
        if (p !== '/api/desktop' || req.headers.has('cookie') || req.headers.has('origin'))
            return NextResponse.json({ error: 'Origine refusée' }, { status: 403, headers: privateHeaders });
    }
    return NextResponse.next();
}
export const config = { matcher: ['/api/:path*'] };
