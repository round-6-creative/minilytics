const TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 256 * 1024;
const MAX_ICON_BYTES = 1024 * 1024;
const ICON_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/x-icon', 'image/vnd.microsoft.icon']);

export interface Icon {
  body: Uint8Array<ArrayBuffer>;
  type: string;
}

function linkAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m?.slice(1).find((v) => v !== undefined);
}

// Best first: a vector icon, then the largest rel="icon", then Apple touch icons, then /favicon.ico.
export function iconCandidates(html: string, base: string): string[] {
  const found: { url: string; score: number }[] = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = linkAttr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? [];
    const touch = rel.some((r) => r.startsWith('apple-touch-icon'));
    const href = linkAttr(tag, 'href')?.replace(/&amp;/g, '&');
    if ((!rel.includes('icon') && !touch) || !href) continue;
    // A dark-mode icon is usually light, so it would vanish on the dashboard.
    if (/prefers-color-scheme:\s*dark/i.test(linkAttr(tag, 'media') ?? '')) continue;
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    const svg = /svg/i.test(linkAttr(tag, 'type') ?? '') || url.pathname.endsWith('.svg');
    const size = Math.max(0, ...[...(linkAttr(tag, 'sizes') ?? '').matchAll(/(\d+)x\d+/gi)].map((m) => Number(m[1])));
    found.push({ url: url.href, score: touch ? -1 : svg ? Infinity : size });
  }
  const ranked = found.sort((a, b) => (a.score === b.score ? 0 : b.score - a.score)).map((f) => f.url);
  return [...new Set([...ranked, new URL('/favicon.ico', base).href])];
}

async function readUpTo(res: Response, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const out = new Uint8Array(max);
  let size = 0;
  const reader = res.body?.getReader();
  while (reader && size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    out.set(value.subarray(0, max - size), size);
    size += value.length;
  }
  await reader?.cancel();
  return out.subarray(0, Math.min(size, max));
}

async function fetchIcon(url: string, signal: AbortSignal): Promise<Icon | null> {
  const res = await fetch(url, { signal });
  const type = res.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!res.ok || !ICON_TYPES.has(type)) {
    await res.body?.cancel();
    return null;
  }
  const body = await readUpTo(res, MAX_ICON_BYTES);
  return body.length && body.length < MAX_ICON_BYTES ? { body, type } : null;
}

// Reads the icon from the site itself, because Google's favicon service keeps serving a copy for months.
export async function findFavicon(domain: string): Promise<Icon | null> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const home = `https://${domain}/`;
  let candidates = iconCandidates('', home);
  try {
    const res = await fetch(home, { signal });
    candidates = iconCandidates(new TextDecoder().decode(await readUpTo(res, MAX_HTML_BYTES)), res.url || home);
  } catch {
    // The homepage is unreachable, but /favicon.ico may still answer.
  }
  for (const url of candidates) {
    const icon = await fetchIcon(url, signal).catch(() => null);
    if (icon) return icon;
  }
  return null;
}
