import type { Db } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import { UserError } from './types.ts';

export interface ImportDoc {
  id: number;
  source: string;
  title: string;
  content: string;
  created_at: string;
}

export function createImport(db: Db, input: { source: string; title: string; content: string }): number {
  const content = input.content.trim();
  if (!content) throw new UserError('가져올 내용이 비어 있어요');
  if (content.length > 1_000_000) throw new UserError('내용이 너무 길어요 (최대 100만 자)');
  const title = input.title.trim() || '가져온 문서';
  return db.run(
    'INSERT INTO imports (source, title, content, created_at) VALUES (?, ?, ?, ?)',
    input.source,
    title.slice(0, 200),
    content,
    nowIso(),
  ).lastInsertRowid;
}

export function getImport(db: Db, id: number): ImportDoc | undefined {
  return db.get<ImportDoc>('SELECT * FROM imports WHERE id = ?', id);
}

export function listImports(db: Db): Array<Omit<ImportDoc, 'content'> & { length: number }> {
  return db.all('SELECT id, source, title, length(content) AS length, created_at FROM imports ORDER BY created_at DESC');
}

export function deleteImport(db: Db, id: number): void {
  db.run('DELETE FROM imports WHERE id = ?', id);
}

// ─── 노션 ─────────────────────────────────────────────────────────

/** 노션 페이지 URL 또는 ID에서 UUID를 뽑는다 */
export function parseNotionId(ref: string): string | null {
  const s = ref.trim();
  const dashed = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
  if (dashed) return (dashed[1] ?? '').toLowerCase();
  const path = s.split(/[?#]/)[0] ?? '';
  const hex = /([0-9a-f]{32})(?![0-9a-f])/i.exec(path);
  if (!hex) return null;
  const h = (hex[1] ?? '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

interface RichText {
  plain_text?: string;
  href?: string | null;
}

export interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

function rt(list: unknown): string {
  if (!Array.isArray(list)) return '';
  return (list as RichText[])
    .map((r) => {
      const t = r.plain_text ?? '';
      return r.href && t && !t.startsWith('http') ? `[${t}](${r.href})` : t;
    })
    .join('');
}

function data(b: NotionBlock): Record<string, unknown> {
  const v = b[b.type];
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

const INDENT_CHILDREN = new Set(['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle']);

/** 노션 블록 트리를 마크다운으로 */
export function notionBlocksToMarkdown(blocks: NotionBlock[], indent = ''): string {
  const out: string[] = [];
  let num = 0;
  for (const b of blocks) {
    const d = data(b);
    const text = rt(d.rich_text);
    num = b.type === 'numbered_list_item' ? num + 1 : 0;
    let line: string | null = null;
    switch (b.type) {
      case 'paragraph':
        line = text;
        break;
      case 'heading_1':
        line = `# ${text}`;
        break;
      case 'heading_2':
        line = `## ${text}`;
        break;
      case 'heading_3':
        line = `### ${text}`;
        break;
      case 'bulleted_list_item':
      case 'toggle':
        line = `- ${text}`;
        break;
      case 'numbered_list_item':
        line = `${num}. ${text}`;
        break;
      case 'to_do':
        line = `- [${d.checked ? 'x' : ' '}] ${text}`;
        break;
      case 'quote':
        line = `> ${text}`;
        break;
      case 'callout': {
        const icon = d.icon as { emoji?: string } | undefined;
        line = `> ${icon?.emoji ? `${icon.emoji} ` : ''}${text}`;
        break;
      }
      case 'code':
        line = `\`\`\`${String(d.language ?? '')}\n${text}\n\`\`\``;
        break;
      case 'divider':
        line = '---';
        break;
      case 'child_page':
        line = `📄 ${String(d.title ?? '')}`;
        break;
      case 'child_database':
        line = `🗂 ${String(d.title ?? '')}`;
        break;
      case 'table_row': {
        const cells = Array.isArray(d.cells) ? (d.cells as unknown[]).map((c) => rt(c).replace(/\|/g, '/')) : [];
        line = `| ${cells.join(' | ')} |`;
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview':
        line = String(d.url ?? '');
        break;
      case 'equation':
        line = String(d.expression ?? '');
        break;
      case 'image':
      case 'file':
      case 'pdf':
      case 'video': {
        const caption = rt(d.caption);
        line = `[${b.type}]${caption ? ` ${caption}` : ''}`;
        break;
      }
      default:
        line = null; // table, column_list, column, synced_block 등은 자식만 출력
    }
    if (line !== null) out.push(line.split('\n').map((l) => indent + l).join('\n'));
    if (b.children?.length) {
      const childIndent = INDENT_CHILDREN.has(b.type) ? `${indent}  ` : indent;
      out.push(notionBlocksToMarkdown(b.children, childIndent));
    }
  }
  return out.filter((l) => l !== '').join('\n');
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_BLOCKS = 3000;
const MAX_DEPTH = 5;

async function notionGet(path: string, token: string, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(`${NOTION_API}${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION },
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? '1');
      await new Promise((r) => setTimeout(r, Math.min(10, Math.max(1, wait)) * 1000));
      continue;
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const m = typeof body.message === 'string' ? body.message : `HTTP ${res.status}`;
      if (res.status === 401) throw new UserError('노션 토큰이 올바르지 않아요');
      if (res.status === 404) throw new UserError('페이지를 찾을 수 없어요. 노션에서 이 페이지를 통합(integration)에 연결했는지 확인해 주세요.');
      throw new UserError(`노션 API 오류: ${m}`);
    }
    return body;
  }
  throw new UserError('노션 API 요청이 너무 많아요. 잠시 뒤 다시 시도해 주세요.');
}

export async function fetchNotionPage(
  ref: string,
  token: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ title: string; markdown: string }> {
  const id = parseNotionId(ref);
  if (!id) throw new UserError('노션 페이지 주소나 ID를 확인해 주세요');
  if (!token) throw new UserError('노션 통합 토큰이 필요해요');

  let title = '노션 페이지';
  try {
    const page = await notionGet(`/pages/${id}`, token, fetchImpl);
    const props = (page.properties ?? {}) as Record<string, { type?: string; title?: unknown }>;
    for (const p of Object.values(props)) {
      if (p.type === 'title') title = rt(p.title) || title;
    }
  } catch (err) {
    if (err instanceof UserError && /토큰/.test(err.message)) throw err;
  }

  let count = 0;
  async function children(blockId: string, depth: number): Promise<NotionBlock[]> {
    const out: NotionBlock[] = [];
    let cursor: string | undefined;
    do {
      const q = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`;
      const body = await notionGet(`/blocks/${blockId}/children${q}`, token, fetchImpl);
      const results = Array.isArray(body.results) ? (body.results as NotionBlock[]) : [];
      for (const b of results) {
        if (++count > MAX_BLOCKS) return out;
        if (b.has_children && depth < MAX_DEPTH && b.type !== 'child_page' && b.type !== 'child_database') {
          b.children = await children(b.id, depth + 1);
        }
        out.push(b);
      }
      cursor = body.has_more && typeof body.next_cursor === 'string' ? body.next_cursor : undefined;
    } while (cursor);
    return out;
  }

  const blocks = await children(id, 0);
  const markdown = notionBlocksToMarkdown(blocks);
  if (!markdown.trim()) throw new UserError('페이지 내용이 비어 있어요');
  return { title, markdown: count > MAX_BLOCKS ? `${markdown}\n\n…(블록이 많아 ${MAX_BLOCKS}개까지만 가져왔어요)` : markdown };
}

/** 가져온 문서를 AI에게 정리시키는 프롬프트 */
export function organizePrompt(importId: number): string {
  return [
    `Hub의 fetch 도구로 import:${importId} 문서를 읽고, 내용을 Hub 구조에 맞게 정리해서 제안해 줘.`,
    '- 프로젝트마다 propose_project 한 번씩: 이름, 분야(kind), 한 줄 소개, 목표, 타깃, 현재 단계, 제약, 작업 범위에',
    '  이미 정해진 사항은 decisions, 남은 할 일은 tasks(분야·마감·반복이 보이면 함께)로 같이 넣어 줘. 그러면 한 번에 승인할 수 있어.',
    '- 이미 Hub에 있는 프로젝트라면 propose_decision, propose_task로 따로 올려 줘.',
    '- 문서에 있는 참고 링크는 save_reference로 저장해 줘 (카테고리와 메모 포함).',
    '- 나에 대한 정보(소개, 작업 선호)는 따로 요약해서 알려 줘. 내가 프로필에 붙여 넣을게.',
  ].join('\n');
}
