import type { Db, Param } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import { recordActivity } from './activity.ts';
import { UserError } from './types.ts';

/** 레퍼런스(링크) 모음: 카테고리·태그·메모·프로젝트로 정리하고 검색한다 */

export interface Reference {
  id: number;
  url: string;
  url_key: string;
  title: string;
  description: string;
  image_url: string;
  site: string;
  category: string;
  tags: string;
  note: string;
  project_id: number | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface ReferenceView extends Reference {
  project_name: string | null;
}

export const DEFAULT_REF_CATEGORIES = ['디자인', '개발', '마케팅', '기획', '문서·PPT', '영감', '도구', '기타'];

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|spm)$/i;

export function normalizeUrl(input: string): { url: string; key: string; site: string } {
  let s = input.trim();
  if (!s) throw new UserError('링크를 넣어 주세요');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new UserError(`링크 형식이 올바르지 않아요: ${input.trim()}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new UserError('http 또는 https 링크만 저장할 수 있어요');
  if (!u.hostname.includes('.') && u.hostname !== 'localhost') throw new UserError(`링크 형식이 올바르지 않아요: ${input.trim()}`);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k)) u.searchParams.delete(k);
  const site = u.hostname.replace(/^www\./i, '').toLowerCase();
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const path = u.pathname.replace(/\/+$/, '') || '';
  const key = `${site}${path}${params.length ? `?${new URLSearchParams(params).toString()}` : ''}`;
  return { url: u.toString(), key, site };
}

const DOMAIN_CATEGORY: Array<[RegExp, string]> = [
  [/(^|\.)(dribbble|behance|pinterest|awwwards|mobbin|land-book|lapa|siteinspire|godly|savee|cosmos|unsplash|freepik|coolors|colorhunt|noonnu|dafont)\./, '디자인'],
  [/(^|\.)figma\.com$/, '디자인'],
  [/(^|\.)fonts\.google\.com$/, '디자인'],
  [/(^|\.)(github|gitlab|stackoverflow|npmjs|dev|codepen|codesandbox|huggingface|vercel|supabase|pypi)\./, '개발'],
  [/^(developer|developers|docs)\./, '개발'],
  [/(^|\.)(slideshare|speakerdeck|pitch|gamma|prezi)\./, '문서·PPT'],
  [/(^|\.)(instagram|tiktok|youtube|youtu|facebook|threads|twitter|x|linkedin|brunch|stibee|mailchimp|maily)\./, '마케팅'],
  [/(^|\.)blog\.naver\.com$/, '마케팅'],
  [/(^|\.)(notion|miro|whimsical|linear|productboard|atlassian)\./, '기획'],
];

const TITLE_CATEGORY: Array<[RegExp, string]> = [
  [/디자인|design|\bui\b|\bux\b|폰트|font|컬러|color|타이포|로고|일러스트|레이아웃|포트폴리오/i, '디자인'],
  [/개발|코드|code|api|sdk|라이브러리|library|framework|react|next\.?js|typescript|python|github/i, '개발'],
  [/마케팅|marketing|광고|캠페인|브랜딩|sns|인스타|seo|카피|콘텐츠|그로스|growth/i, '마케팅'],
  [/\bppt\b|슬라이드|slide|발표|pitch|deck|제안서|템플릿/i, '문서·PPT'],
  [/기획|전략|로드맵|prd|요구사항|서비스\s*기획|product/i, '기획'],
  [/tool|툴|도구|앱\s*추천|extension|플러그인|plugin/i, '도구'],
];

export function suggestCategory(url: string, title = ''): string {
  let site = '';
  let path = '';
  try {
    const u = new URL(url);
    site = u.hostname.replace(/^www\./i, '').toLowerCase();
    path = u.pathname.toLowerCase();
  } catch {
    /* 무시 */
  }
  if (site === 'docs.google.com') return path.startsWith('/presentation') ? '문서·PPT' : '기획';
  for (const [re, cat] of DOMAIN_CATEGORY) if (re.test(site)) return cat;
  for (const [re, cat] of TITLE_CATEGORY) if (re.test(title)) return cat;
  return '기타';
}

export function normalizeTags(s: string): string {
  const tags = s
    .split(/[\s,#]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20);
  return [...new Set(tags)].join(' ');
}

function cleanCategory(c: string | undefined): string {
  const v = (c ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return v || '';
}

const SELECT = 'SELECT r.*, p.name AS project_name FROM refs r LEFT JOIN projects p ON p.id = r.project_id';

export function getReference(db: Db, id: number): ReferenceView | undefined {
  return db.get<ReferenceView>(`${SELECT} WHERE r.id = ?`, id);
}

export function requireReference(db: Db, id: number): ReferenceView {
  const r = getReference(db, id);
  if (!r) throw new UserError(`레퍼런스 R${id}를 찾을 수 없어요`);
  return r;
}

export interface RefInput {
  url: string;
  title?: string;
  description?: string;
  image_url?: string;
  site?: string;
  category?: string;
  tags?: string;
  note?: string;
  project_id?: number | null;
}

/** 같은 링크가 이미 있으면 새로 만들지 않고 비어 있는 칸만 채운다 */
export function createReference(db: Db, input: RefInput, source: string): { ref: ReferenceView; created: boolean } {
  const n = normalizeUrl(input.url);
  if (input.project_id !== undefined && input.project_id !== null && !db.get('SELECT 1 FROM projects WHERE id = ?', input.project_id)) {
    throw new UserError(`프로젝트 P${input.project_id}를 찾을 수 없어요`);
  }
  const title = (input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const description = (input.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const tags = normalizeTags(input.tags ?? '');
  const note = (input.note ?? '').trim().slice(0, 4000);
  const existing = db.get<Reference>('SELECT * FROM refs WHERE url_key = ?', n.key);
  if (existing) {
    const merged = {
      title: existing.title || title,
      description: existing.description || description,
      image_url: existing.image_url || (input.image_url ?? ''),
      note: existing.note || note,
      tags: normalizeTags(`${existing.tags} ${tags}`),
      project_id: existing.project_id ?? input.project_id ?? null,
    };
    db.run(
      'UPDATE refs SET title = ?, description = ?, image_url = ?, note = ?, tags = ?, project_id = ?, updated_at = ? WHERE id = ?',
      merged.title,
      merged.description,
      merged.image_url,
      merged.note,
      merged.tags,
      merged.project_id,
      nowIso(),
      existing.id,
    );
    return { ref: requireReference(db, existing.id), created: false };
  }
  const now = nowIso();
  const category = cleanCategory(input.category) || suggestCategory(n.url, title);
  const id = db.run(
    `INSERT INTO refs (url, url_key, title, description, image_url, site, category, tags, note, project_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    n.url,
    n.key,
    title,
    description,
    (input.image_url ?? '').slice(0, 1000),
    input.site?.trim() || n.site,
    category,
    tags,
    note,
    input.project_id ?? null,
    source,
    now,
    now,
  ).lastInsertRowid;
  if (source !== '나') {
    recordActivity(db, { source, via: 'direct', action: 'reference.create', entity_id: id, project_id: input.project_id ?? null, summary: `레퍼런스 저장 [R${id}] ${title || n.site}` });
  }
  return { ref: requireReference(db, id), created: true };
}

export interface RefChanges {
  title?: string;
  category?: string;
  tags?: string;
  note?: string;
  project_id?: number | null;
}

export function updateReference(db: Db, id: number, c: RefChanges): ReferenceView {
  const cur = requireReference(db, id);
  if (c.project_id !== undefined && c.project_id !== null && !db.get('SELECT 1 FROM projects WHERE id = ?', c.project_id)) {
    throw new UserError(`프로젝트 P${c.project_id}를 찾을 수 없어요`);
  }
  db.run(
    'UPDATE refs SET title = ?, category = ?, tags = ?, note = ?, project_id = ?, updated_at = ? WHERE id = ?',
    c.title !== undefined ? c.title.replace(/\s+/g, ' ').trim().slice(0, 300) : cur.title,
    c.category !== undefined ? cleanCategory(c.category) || '기타' : cur.category,
    c.tags !== undefined ? normalizeTags(c.tags) : cur.tags,
    c.note !== undefined ? c.note.trim().slice(0, 4000) : cur.note,
    c.project_id !== undefined ? c.project_id : cur.project_id,
    nowIso(),
    id,
  );
  return requireReference(db, id);
}

export function deleteReference(db: Db, id: number): void {
  db.run('DELETE FROM refs WHERE id = ?', id);
}

export interface RefFilter {
  q?: string;
  category?: string;
  projectId?: number;
  tag?: string;
  limit?: number;
}

function likeTerm(t: string): string {
  return `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function listReferences(db: Db, f: RefFilter = {}): ReferenceView[] {
  const where: string[] = [];
  const vals: Param[] = [];
  for (const term of (f.q ?? '').split(/\s+/).filter(Boolean).slice(0, 6)) {
    where.push(`(${['r.title', 'r.url', 'r.description', 'r.note', 'r.tags', 'r.category', 'r.site', 'p.name'].map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < 8; i++) vals.push(likeTerm(term));
  }
  if (f.category) {
    where.push('r.category = ?');
    vals.push(f.category);
  }
  if (f.projectId !== undefined) {
    where.push('r.project_id = ?');
    vals.push(f.projectId);
  }
  if (f.tag) {
    where.push("(' ' || r.tags || ' ') LIKE ? ESCAPE '\\'");
    vals.push(`% ${f.tag.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)} %`);
  }
  vals.push(f.limit ?? 200);
  return db.all<ReferenceView>(`${SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC, r.id DESC LIMIT ?`, ...vals);
}

export function refCategories(db: Db): Array<{ category: string; n: number }> {
  const rows = db.all<{ category: string; n: number }>('SELECT category, count(*) AS n FROM refs GROUP BY category');
  const counts = new Map(rows.map((r) => [r.category, r.n]));
  const ordered = [...DEFAULT_REF_CATEGORIES.map((c) => ({ category: c, n: counts.get(c) ?? 0 }))];
  for (const r of rows) if (!DEFAULT_REF_CATEGORIES.includes(r.category)) ordered.push(r);
  return ordered;
}

export function refTags(db: Db, limit = 30): Array<{ tag: string; n: number }> {
  const counts = new Map<string, number>();
  for (const r of db.all<{ tags: string }>("SELECT tags FROM refs WHERE tags != ''")) {
    for (const t of r.tags.split(' ')) if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([tag, n]) => ({ tag, n }));
}
