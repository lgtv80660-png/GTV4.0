// Only G-PANEL capabilities are accepted; never a provider URL.
export function panelTarget(value: string, base: string, expected?: string) {
  const origin = new URL(base);
  const u = new URL(value, origin);
  if (u.origin !== origin.origin || u.pathname !== '/live_source_media.php' ||
      u.username || u.password || u.hash ||
      [...u.searchParams.keys()].sort().join(',') !== 'g,r,s') throw Error('PANEL_TARGET_INVALID');
  const s = u.searchParams.get('s')!, g = u.searchParams.get('g')!, r = u.searchParams.get('r')!;
  if (!/^[a-f0-9]{64}$/.test(s) || !/^(0|[1-9]\d{0,8})$/.test(g) ||
      !/^(root|[a-f0-9]{64})$/.test(r) || (expected && s !== expected)) throw Error('PANEL_TARGET_INVALID');
  return {url: u.href, session: s, generation: Number(g), resource: r};
}
export function retrySeconds(value: string | null) {
  return value && /^\d+$/.test(value) ? Math.max(1, Math.min(30, Number(value))) : 3;
}
export async function panelPlaylist(text: string, base: string, expected: string, save: (url: string) => Promise<string>) {
  if (text.length > 1000000 || !text.trimStart().startsWith('#EXTM3U')) throw Error('PANEL_MANIFEST_INVALID');
  const rewrite = async (value: string) => save(panelTarget(value, base, expected).url);
  const lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) { lines.push(line); continue; }
    if (!line.startsWith('#')) { lines.push(await rewrite(line.trim())); continue; }
    let changed = line;
    for (const m of line.matchAll(/URI="([^"]+)"/g)) changed = changed.replace(m[0], 'URI="'+await rewrite(m[1])+'"');
    if (/https?:\/\/|\/live_source_media\.php|URI=(?!")/i.test(changed)) throw Error('PANEL_MANIFEST_INVALID');
    lines.push(changed);
  }
  return lines.join('\n');
}
