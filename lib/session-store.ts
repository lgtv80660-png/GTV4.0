import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
export type Credentials = {
    serverUrl: string;
    username: string;
    password: string;
};
export const SESSION_SECONDS = 12 * 3600;
export const validToken = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{43}$/.test(s);
export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function namespace() { const n = process.env.GTV_SESSION_NAMESPACE; if (!n || !/^[a-zA-Z0-9_-]{1,64}$/.test(n))
    throw Error('SESSION_UNAVAILABLE'); return 'gtv:' + n + ':'; }
export async function command(...args: (string | number)[]): Promise<any> {
    const raw = process.env.GTV_SESSION_REDIS_URL, token = process.env.GTV_SESSION_REDIS_TOKEN;
    if (!raw || !token)
        throw Error('SESSION_UNAVAILABLE');
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash)
        throw Error('SESSION_UNAVAILABLE');
    try {
        const r = await fetch(u, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(args), cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!r.ok)
            throw Error();
        const data = await r.json();
        if (data.error)
            throw Error();
        return data.result;
    }
    catch {
        throw Error('SESSION_UNAVAILABLE');
    }
}
function keys(): Record<string, string> {
    try {
        const k = JSON.parse(process.env.GTV_SESSION_KEYS || '');
        if (!k || typeof k !== 'object' || Array.isArray(k))
            throw Error();
        for (const [id, v] of Object.entries(k))
            if (!/^[a-zA-Z0-9_-]{1,32}$/.test(id) || typeof v !== 'string' || !validToken(v) || Buffer.from(v, 'base64url').length !== 32)
                throw Error();
        return k;
    }
    catch {
        throw Error('SESSION_UNAVAILABLE');
    }
}
export function seal(value: unknown, binding: string) {
    const id = process.env.GTV_SESSION_ACTIVE_KEY || '', k = keys()[id];
    if (!k)
        throw Error('SESSION_UNAVAILABLE');
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', Buffer.from(k, 'base64url'), iv);
    c.setAAD(Buffer.from(binding));
    const body = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
    return [id, iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}
export function unseal(raw: string, binding: string): any {
    try {
        const [id, iv, tag, body, ...extra] = raw.split('.');
        const k = keys()[id];
        if (!k || extra.length || !body)
            throw Error();
        const c = createDecipheriv('aes-256-gcm', Buffer.from(k, 'base64url'), Buffer.from(iv, 'base64url'));
        c.setAAD(Buffer.from(binding));
        c.setAuthTag(Buffer.from(tag, 'base64url'));
        return JSON.parse(Buffer.concat([c.update(Buffer.from(body, 'base64url')), c.final()]).toString('utf8'));
    }
    catch {
        throw Error('SESSION_INVALID');
    }
}
const sessionKey = (token: string) => namespace() + 'session:' + digest(token);
export async function readSession(token: unknown): Promise<Credentials> {
    if (!validToken(token))
        throw Error('SESSION_INVALID');
    const key = sessionKey(token), raw = await command('GET', key);
    if (typeof raw !== 'string')
        throw Error('SESSION_INVALID');
    const v = unseal(raw, key);
    if (v.v !== 2 || !Number.isSafeInteger(v.expires) || v.expires <= Date.now() || typeof v.creds?.username !== 'string' || typeof v.creds?.password !== 'string' || typeof v.creds?.serverUrl !== 'string')
        throw Error('SESSION_INVALID');
    return v.creds;
}
export async function createSession(creds: Credentials) {
    const token = opaque(), key = sessionKey(token), expires = Date.now() + SESSION_SECONDS * 1000;
    const result = await command('SET', key, seal({ v: 2, expires, creds }, key), 'EX', SESSION_SECONDS, 'NX');
    if (result !== 'OK')
        throw Error('SESSION_UNAVAILABLE');
    return token;
}
export async function revokeSession(token: unknown) { if (validToken(token))
    await command('DEL', sessionKey(token)); }
export async function saveResource(session: string, url: string) {
    await readSession(session);
    const token = opaque(), key = namespace() + 'media:' + digest(token);
    if (await command('SET', key, seal({ session: digest(session), url }, key), 'EX', 180, 'NX') !== 'OK')
        throw Error('SESSION_UNAVAILABLE');
    return token;
}
export async function readResource(session: string, token: string) {
    await readSession(session);
    if (!validToken(token))
        throw Error('MEDIA_INVALID');
    const key = namespace() + 'media:' + digest(token), raw = await command('GET', key);
    if (typeof raw !== 'string')
        throw Error('MEDIA_INVALID');
    const v = unseal(raw, key);
    if (v.session !== digest(session) || typeof v.url !== 'string')
        throw Error('MEDIA_INVALID');
    return v.url as string;
}
export async function loginBudget(username: string) {
    const key = namespace() + 'login:' + digest(username.toLowerCase());
    const n = await command('EVAL', "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],300) end; return n", 1, key);
    if (Number(n) > 10)
        throw Error('LOGIN_RATE_LIMIT');
}
