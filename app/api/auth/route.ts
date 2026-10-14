import { secureJson as secureJsonBase } from '@/lib/security-json';
import { requireSession } from '@/lib/session';
import { privateHeaders } from '@/lib/security';
export { POST } from '../login/route';
export { POST as DELETE } from '../logout/route';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
    let responseCredentials: {
        username?: string;
        password?: string;
    } | undefined;
    const secureJson = (body: unknown, init?: ResponseInit) => secureJsonBase(body, init, responseCredentials);
    try {
        await requireSession().then(c => { responseCredentials = c; return c; });
        return secureJson({ authenticated: true }, { headers: privateHeaders });
    }
    catch {
        return secureJson({ authenticated: false }, { status: 401, headers: privateHeaders });
    }
}
