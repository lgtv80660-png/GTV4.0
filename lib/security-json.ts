import { NextResponse } from 'next/server';
export function publicData(value: unknown, creds?: {
    username?: string;
    password?: string;
}): any {
    if (Array.isArray(value))
        return value.map(v => publicData(v, creds));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(value)) {
            if (/^(password|passwd|pass|username|user_name|user_info|server_info|serverUrl|baseUrl)$/i.test(key))
                continue;
            if (/^(direct_source|stream_url)$/i.test(key)) {
                out[key] = '';
                continue;
            }
            out[key] = key === 'error' && typeof v === 'string' ? 'Requête indisponible' : publicData(v, creds);
        }
        return out;
    }
    if (typeof value === 'string' && creds) {
        if (value === creds.username || value === creds.password)
            return '';
        if (/^https?:/i.test(value)) {
            try {
                const u = new URL(value), parts = [...u.pathname.split('/').map(p => decodeURIComponent(p)), ...u.searchParams.values()];
                if (parts.some(p => p && [creds.username, creds.password].includes(p)))
                    return '';
            }
            catch {
                return '';
            }
        }
    }
    if (typeof value === 'string' && (/https?:\/\/[^\s]*[?&](username|password|_u|_p)=/i.test(value) || /https?:\/\/[^\s/]+\/(live|movie|series)\/[^/]+\/[^/]+\//i.test(value) || /https?:\/\/[^/@]+:[^/@]+@/i.test(value)))
        return '';
    return value;
}
export function secureJson(body: unknown, init?: ResponseInit, creds?: {
    username?: string;
    password?: string;
}) { const headers = new Headers(init?.headers); headers.set('Cache-Control', 'no-store'); headers.set('Referrer-Policy', 'no-referrer'); return NextResponse.json(publicData(body, creds), { ...init, headers }); }
