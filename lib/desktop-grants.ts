import { randomBytes, createHash } from 'node:crypto';

export type Grant = { source: string; session: string; binding: string; expires: number; resources: Map<string,string>; redeemed: boolean };
// Process-local capabilities fail closed on restart and are never persisted.
const state = globalThis as typeof globalThis & { desktopGrants?: Map<string,Grant> };
export const grants = state.desktopGrants ??= new Map();
export const opaque = () => randomBytes(32).toString('hex');
export const fingerprint = (value: string) => createHash('sha256').update(value).digest('hex');
export function sweep() { for (const [key,g] of grants) if (g.expires <= Date.now()) grants.delete(key); }
