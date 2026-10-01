/** 링크의 제목·설명·대표 이미지를 가져온다 (레퍼런스 저장용) */

export interface PageMeta {
  title: string;
  description: string;
  image: string;
  siteName: string;
}

type FetchLike = (url: string, init: Record<string, unknown>) => Promise<Response>;

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h === '::1' || h === '0.0.0.0' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e: string) => {
    const k = e.toLowerCase();
    if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16));
    if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)));
    return ENTITIES[k] ?? m;
  });
}

function metaContent(html: string, names: string[]): string {
  for (const name of names) {
    const esc = name.replace(/[.:]/g, (c) => `\\${c}`);
    const a = new RegExp(`<meta[^>]+(?:property|name)=["']${esc}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html);
    if (a?.[1]) return decodeEntities(a[1]).trim();
    const b = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${esc}["']`, 'i').exec(html);
    if (b?.[1]) return decodeEntities(b[1]).trim();
  }
  return '';
}

export function parseMeta(html: string, baseUrl: string): PageMeta {
  const head = html.slice(0, 300_000);
  const title =
    metaContent(head, ['og:title', 'twitter:title']) ||
    decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '').replace(/\s+/g, ' ')).trim();
  const description = metaContent(head, ['og:description', 'twitter:description', 'description']);
  let image = metaContent(head, ['og:image', 'og:image:url', 'twitter:image']);
  if (image) {
    try {
      image = new URL(image, baseUrl).toString();
    } catch {
      image = '';
    }
  }
  return { title: title.slice(0, 300), description: description.replace(/\s+/g, ' ').slice(0, 1000), image, siteName: metaContent(head, ['og:site_name']) };
}

function charsetOf(contentType: string, sniff: string): string {
  const fromHeader = /charset=([\w-]+)/i.exec(contentType)?.[1];
  const fromMeta = /<meta[^>]+charset=["']?([\w-]+)/i.exec(sniff)?.[1];
  return (fromHeader || fromMeta || 'utf-8').toLowerCase();
}

export async function fetchPageMeta(
  url: string,
  opts: { fetchImpl?: FetchLike; allowPrivate?: boolean; timeoutMs?: number } = {},
): Promise<PageMeta | null> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 6000);
  try {
    const res = await (opts.fetchImpl ?? (fetch as unknown as FetchLike))(u.toString(), {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HubBot/1.0; +personal bookmark preview)', Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (type && !/html|xml/i.test(type)) return null;
    const reader = res.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 600_000) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    await reader.cancel().catch(() => undefined);
    const bytes = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c.subarray(0, Math.min(c.length, size - off)), off);
      off += c.length;
      if (off >= size) break;
    }
    const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
    let html: string;
    try {
      html = new TextDecoder(charsetOf(type, sniff)).decode(bytes);
    } catch {
      html = new TextDecoder('utf-8').decode(bytes);
    }
    return parseMeta(html, res.url || u.toString());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
