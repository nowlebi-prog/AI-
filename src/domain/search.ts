import type { Db, Param } from '../db.ts';
import { dateOf, formatDate } from '../lib/time.ts';
import { projectBrief, clip } from './brief.ts';
import { getDecision, getLog } from './decisions.ts';
import { getImport } from './imports.ts';
import { getProject } from './projects.ts';
import { getReference } from './references.ts';
import { getTask } from './tasks.ts';
import { PRIORITY_LABEL, ROLE_LABEL, TASK_STATUS_LABEL, UserError } from './types.ts';

export interface SearchHit {
  id: string;
  title: string;
  url: string;
  text: string;
  created_at: string;
}

function likeTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((t) => `%${t.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
}

/** 모든 검색어가 (여러 컬럼 중 하나에) 들어간 행 */
function whereAll(cols: string[], terms: string[]): { sql: string; params: Param[] } {
  const parts: string[] = [];
  const params: Param[] = [];
  for (const t of terms) {
    parts.push(`(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
    for (let i = 0; i < cols.length; i++) params.push(t);
  }
  return { sql: parts.join(' AND '), params };
}

export function search(db: Db, query: string, baseUrl: string, limit = 20): SearchHit[] {
  const terms = likeTerms(query);
  if (!terms.length) return [];
  const hits: SearchHit[] = [];

  const p = whereAll(['name', 'summary', 'goal', 'audience', 'stage', 'constraints', 'scope', 'links', 'resume_note'], terms);
  for (const r of db.all<{ id: number; name: string; summary: string; updated_at: string }>(
    `SELECT id, name, summary, updated_at FROM projects WHERE ${p.sql} ORDER BY updated_at DESC LIMIT 10`,
    ...p.params,
  )) {
    hits.push({ id: `project:${r.id}`, title: `[P${r.id}] ${r.name}`, url: `${baseUrl}/projects/${r.id}`, text: clip(r.summary, 160), created_at: r.updated_at });
  }

  const d = whereAll(['d.content', 'd.reason'], terms);
  for (const r of db.all<{ id: number; project_id: number; name: string; content: string; reason: string; created_at: string; superseded_by: number | null }>(
    `SELECT d.id, d.project_id, p.name, d.content, d.reason, d.created_at, d.superseded_by
     FROM decisions d JOIN projects p ON p.id = d.project_id WHERE ${d.sql} ORDER BY d.created_at DESC LIMIT 20`,
    ...d.params,
  )) {
    hits.push({
      id: `decision:${r.id}`,
      title: `[D${r.id}] ${r.name} 결정${r.superseded_by ? ` (D${r.superseded_by}로 대체됨)` : ''}: ${clip(r.content, 60)}`,
      url: `${baseUrl}/projects/${r.project_id}#decision-${r.id}`,
      text: clip(`${r.content}${r.reason ? ` — 이유: ${r.reason}` : ''}`, 200),
      created_at: r.created_at,
    });
  }

  const t = whereAll(['t.title', 't.note'], terms);
  for (const r of db.all<{ id: number; project_id: number | null; name: string | null; title: string; status: string; updated_at: string }>(
    `SELECT t.id, t.project_id, p.name, t.title, t.status, t.updated_at
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${t.sql} ORDER BY t.updated_at DESC LIMIT 20`,
    ...t.params,
  )) {
    hits.push({
      id: `task:${r.id}`,
      title: `[T${r.id}] ${r.name ? `${r.name} · ` : ''}${clip(r.title, 60)} (${TASK_STATUS_LABEL[r.status as 'todo'] ?? r.status})`,
      url: r.project_id ? `${baseUrl}/projects/${r.project_id}#task-${r.id}` : `${baseUrl}/`,
      text: clip(r.title, 200),
      created_at: r.updated_at,
    });
  }

  const l = whereAll(['l.summary'], terms);
  for (const r of db.all<{ id: number; project_id: number | null; name: string | null; source: string; summary: string; created_at: string }>(
    `SELECT l.id, l.project_id, p.name, l.source, l.summary, l.created_at
     FROM session_logs l LEFT JOIN projects p ON p.id = l.project_id WHERE ${l.sql} ORDER BY l.created_at DESC LIMIT 20`,
    ...l.params,
  )) {
    hits.push({
      id: `log:${r.id}`,
      title: `[L${r.id}] ${r.name ? `${r.name} · ` : ''}${r.source} 세션`,
      url: r.project_id ? `${baseUrl}/projects/${r.project_id}#log-${r.id}` : `${baseUrl}/`,
      text: clip(r.summary, 200),
      created_at: r.created_at,
    });
  }

  const rf = whereAll(['r.title', 'r.url', 'r.description', 'r.note', 'r.tags', 'r.category'], terms);
  for (const r of db.all<{ id: number; title: string; url: string; site: string; category: string; description: string; note: string; created_at: string }>(
    `SELECT r.id, r.title, r.url, r.site, r.category, r.description, r.note, r.created_at FROM refs r WHERE ${rf.sql} ORDER BY r.created_at DESC LIMIT 20`,
    ...rf.params,
  )) {
    hits.push({
      id: `ref:${r.id}`,
      title: `[R${r.id}] 레퍼런스(${r.category}): ${clip(r.title || r.site, 60)}`,
      url: r.url,
      text: clip([r.note, r.description].filter(Boolean).join(' — ') || r.url, 200),
      created_at: r.created_at,
    });
  }

  const im = whereAll(['title', 'content'], terms);
  for (const r of db.all<{ id: number; title: string; content: string; created_at: string }>(
    `SELECT id, title, content, created_at FROM imports WHERE ${im.sql} ORDER BY created_at DESC LIMIT 5`,
    ...im.params,
  )) {
    hits.push({ id: `import:${r.id}`, title: `[I${r.id}] 가져온 문서: ${r.title}`, url: `${baseUrl}/import/${r.id}`, text: clip(r.content, 200), created_at: r.created_at });
  }

  hits.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  return hits.slice(0, limit);
}

export interface FetchedDoc {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, string | number | null>;
}

const SHORT: Record<string, string> = { p: 'project', d: 'decision', t: 'task', l: 'log', i: 'import', r: 'ref' };

export function parseDocId(id: string): { type: string; num: number } {
  const s = id.trim();
  const long = /^(project|decision|task|log|import|ref|reference)[:#\s-]?(\d+)$/i.exec(s);
  if (long) {
    const t = (long[1] ?? '').toLowerCase();
    return { type: t === 'reference' ? 'ref' : t, num: Number(long[2]) };
  }
  const short = /^([pdtlir])(\d+)$/i.exec(s);
  if (short) return { type: SHORT[(short[1] ?? '').toLowerCase()] ?? '', num: Number(short[2]) };
  throw new UserError(`문서 ID 형식을 모르겠어요: '${id}'. 예: project:1, decision:12, task:5, log:7, ref:3, import:2 (또는 P1, D12, T5, R3)`);
}

export function fetchDoc(db: Db, id: string, ctx: { baseUrl: string; today: string; tz: string }): FetchedDoc {
  const { type, num } = parseDocId(id);
  switch (type) {
    case 'project': {
      const p = getProject(db, num);
      if (!p) break;
      return {
        id: `project:${p.id}`,
        title: `[P${p.id}] ${p.name}`,
        text: projectBrief(db, p.id, { size: 'L', mode: 'mcp', today: ctx.today, tz: ctx.tz }),
        url: `${ctx.baseUrl}/projects/${p.id}`,
        metadata: { type: 'project', status: p.status, updated_at: p.updated_at },
      };
    }
    case 'decision': {
      const d = getDecision(db, num);
      if (!d) break;
      const p = getProject(db, d.project_id);
      const lines = [
        `결정: ${d.content}`,
        d.reason ? `이유: ${d.reason}` : '',
        `상태: ${d.superseded_by ? `D${d.superseded_by}로 대체됨` : '유효'}`,
        `프로젝트: P${d.project_id} ${p?.name ?? ''}`,
        `기록: ${formatDate(dateOf(d.created_at, ctx.tz))} · ${d.source}`,
      ].filter(Boolean);
      return {
        id: `decision:${d.id}`,
        title: `[D${d.id}] ${clip(d.content, 60)}`,
        text: lines.join('\n'),
        url: `${ctx.baseUrl}/projects/${d.project_id}#decision-${d.id}`,
        metadata: { type: 'decision', project_id: d.project_id, superseded_by: d.superseded_by, created_at: d.created_at },
      };
    }
    case 'task': {
      const t = getTask(db, num);
      if (!t) break;
      const lines = [
        `할 일: ${t.title}`,
        `상태: ${TASK_STATUS_LABEL[t.status]} · 역할: ${ROLE_LABEL[t.role]} · 우선순위: ${PRIORITY_LABEL[t.priority]}`,
        t.due_date ? `마감: ${t.due_date}` : '마감: 없음',
        t.project_id ? `프로젝트: P${t.project_id} ${t.project_name ?? ''}` : '프로젝트: 없음',
        t.note ? `메모: ${t.note}` : '',
        `출처: ${t.source}`,
      ].filter(Boolean);
      return {
        id: `task:${t.id}`,
        title: `[T${t.id}] ${clip(t.title, 60)}`,
        text: lines.join('\n'),
        url: t.project_id ? `${ctx.baseUrl}/projects/${t.project_id}#task-${t.id}` : `${ctx.baseUrl}/`,
        metadata: { type: 'task', status: t.status, project_id: t.project_id, due_date: t.due_date },
      };
    }
    case 'log': {
      const l = getLog(db, num);
      if (!l) break;
      return {
        id: `log:${l.id}`,
        title: `[L${l.id}] ${l.project_name ?? '프로젝트 없음'} · ${l.source} 세션`,
        text: `${l.summary}\n\n(${formatDate(dateOf(l.created_at, ctx.tz))} · ${l.source})`,
        url: l.project_id ? `${ctx.baseUrl}/projects/${l.project_id}#log-${l.id}` : `${ctx.baseUrl}/`,
        metadata: { type: 'log', project_id: l.project_id, created_at: l.created_at },
      };
    }
    case 'ref': {
      const r = getReference(db, num);
      if (!r) break;
      const lines = [
        `레퍼런스: ${r.title || r.site}`,
        `링크: ${r.url}`,
        `카테고리: ${r.category}${r.tags ? ` · 태그: ${r.tags.split(' ').map((t) => `#${t}`).join(' ')}` : ''}`,
        r.project_name ? `프로젝트: P${r.project_id} ${r.project_name}` : '',
        r.description ? `설명: ${r.description}` : '',
        r.note ? `메모: ${r.note}` : '',
        `저장: ${formatDate(dateOf(r.created_at, ctx.tz))} · ${r.source}`,
      ].filter(Boolean);
      return {
        id: `ref:${r.id}`,
        title: `[R${r.id}] ${r.title || r.site}`,
        text: lines.join('\n'),
        url: r.url,
        metadata: { type: 'ref', category: r.category, project_id: r.project_id, created_at: r.created_at },
      };
    }
    case 'import': {
      const im = getImport(db, num);
      if (!im) break;
      const max = 100_000;
      return {
        id: `import:${im.id}`,
        title: `[I${im.id}] ${im.title}`,
        text: im.content.length > max ? `${im.content.slice(0, max)}\n\n…(뒷부분 생략)` : im.content,
        url: `${ctx.baseUrl}/import/${im.id}`,
        metadata: { type: 'import', source: im.source, created_at: im.created_at },
      };
    }
  }
  throw new UserError(`'${id}'에 해당하는 항목이 없어요`);
}
