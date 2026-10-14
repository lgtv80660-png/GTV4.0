import { cookies } from 'next/headers';
import { readSession, validToken } from './session-store';
export async function sessionToken() { const raw = (await cookies()).get('gtv_session')?.value; if (!validToken(raw))
    throw Error('SESSION_INVALID'); return raw; }
export async function requireSession() { return readSession(await sessionToken()); }
