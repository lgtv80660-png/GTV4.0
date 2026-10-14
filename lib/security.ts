export function csrfAllowed(req: Request) {
    const origin = req.headers.get('origin');
    if (!origin || req.headers.get('sec-fetch-site') === 'cross-site')
        return false;
    const allowed = (process.env.GTV_WEB_ORIGINS || '').split(',').filter(Boolean);
    if (process.env.NODE_ENV !== 'production')
        allowed.push('http://127.0.0.1:3000', 'http://localhost:3000');
    return allowed.includes(origin);
}
export const privateHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' };
