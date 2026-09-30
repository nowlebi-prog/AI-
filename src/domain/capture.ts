import type { Db } from '../db.ts';
import { createLog } from './decisions.ts';
import { resolveProject, setResumeNote } from './projects.ts';
import { propose, type ProposeResult } from './proposals.ts';
import { parseDateExpr, parseQuickAdd } from './quickadd.ts';
import { toPriority, toRole, UserError, type Priority, type Role } from './types.ts';

export interface SessionDecision {
  content: string;
  reason?: string;
  supersedes?: number | null;
}

export interface SessionTask {
  title: string;
  role?: Role | null;
  priority?: Priority | null;
  due_date?: string | null;
  note?: string;
}

export interface SessionRecord {
  projectId: number | null;
  summary: string;
  resume: string;
  decisions: SessionDecision[];
  tasks: SessionTask[];
  doneTaskIds: number[];
}

export interface SessionResult {
  logId: number | null;
  resumeSaved: boolean;
  proposals: Array<{ label: string; result: ProposeResult }>;
  errors: string[];
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 대화 한 번의 결과를 반영한다.
 * 요약·마지막 위치는 바로 저장하고, 결정·할 일·완료 처리는 제안(인박스)으로 올린다.
 */
export function recordSession(db: Db, rec: SessionRecord, source: string): SessionResult {
  const out: SessionResult = { logId: null, resumeSaved: false, proposals: [], errors: [] };
  if (rec.summary.trim()) {
    out.logId = createLog(db, { project_id: rec.projectId, summary: rec.summary }, source).id;
  }
  if (rec.resume.trim()) {
    if (rec.projectId === null) out.errors.push('마지막 위치는 프로젝트가 있어야 저장할 수 있어요');
    else {
      setResumeNote(db, rec.projectId, rec.resume, source);
      out.resumeSaved = true;
    }
  }
  for (const d of rec.decisions) {
    if (rec.projectId === null) {
      out.errors.push(`결정 '${d.content}'은 프로젝트가 있어야 올릴 수 있어요`);
      continue;
    }
    try {
      out.proposals.push({
        label: `결정: ${d.content}`,
        result: propose(
          db,
          {
            kind: 'decision',
            projectId: rec.projectId,
            payload: { content: d.content, reason: d.reason ?? '', supersedes: d.supersedes ?? null },
          },
          source,
        ),
      });
    } catch (err) {
      out.errors.push(`결정 '${d.content}': ${msg(err)}`);
    }
  }
  for (const t of rec.tasks) {
    try {
      out.proposals.push({
        label: `할 일: ${t.title}`,
        result: propose(
          db,
          {
            kind: 'task',
            projectId: rec.projectId,
            payload: {
              title: t.title,
              role: t.role ?? 'etc',
              priority: t.priority ?? 2,
              due_date: t.due_date ?? null,
              note: t.note ?? '',
            },
          },
          source,
        ),
      });
    } catch (err) {
      out.errors.push(`할 일 '${t.title}': ${msg(err)}`);
    }
  }
  for (const id of rec.doneTaskIds) {
    try {
      out.proposals.push({
        label: `완료: T${id}`,
        result: propose(
          db,
          { kind: 'task_update', projectId: rec.projectId, payload: { task_id: id, changes: { status: 'done' } } },
          source,
        ),
      });
    } catch (err) {
      out.errors.push(`T${id} 완료: ${msg(err)}`);
    }
  }
  return out;
}

// ─── [Hub 메모] 파서 ──────────────────────────────────────────────

export interface Memo {
  project: string | null;
  summary: string;
  resume: string;
  decisions: SessionDecision[];
  tasks: SessionTask[];
  done: number[];
}

const START = /\[\s*hub\s*메모\s*\]/i;
const END = /\[\s*\/\s*hub\s*메모\s*\]/i;
const KEY_RE =
  /^(프로젝트|project|요약|summary|결정|decision|할\s*일|todo|task|완료|done|마지막\s*위치|현재\s*위치|위치|resume)\s*[:：]\s*(.*)$/i;

const PLACEHOLDERS = new Set([
  '',
  '-',
  '없음',
  '(없음)',
  'n/a',
  'none',
  '(프로젝트 이름)',
  '이번 대화 요약 2~3문장',
  '결정 내용',
  '할 일 내용',
  '어디까지 했는지 한 줄',
  't번호, t번호',
]);

function isPlaceholder(v: string): boolean {
  return PLACEHOLDERS.has(v.trim().toLowerCase());
}

function keyOf(k: string): keyof Memo | null {
  const s = k.replace(/\s+/g, '').toLowerCase();
  if (s === '프로젝트' || s === 'project') return 'project';
  if (s === '요약' || s === 'summary') return 'summary';
  if (s === '결정' || s === 'decision') return 'decisions';
  if (s === '할일' || s === 'todo' || s === 'task') return 'tasks';
  if (s === '완료' || s === 'done') return 'done';
  if (s === '위치' || s === '마지막위치' || s === '현재위치' || s === 'resume') return 'resume';
  return null;
}

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '')
    .replace(/\*\*/g, '')
    .replace(/^`+|`+$/g, '')
    .trim();
}

function parseDecision(value: string): SessionDecision | null {
  const [head = '', ...rest] = value.split(/\s*\|\s*/);
  let content = head.trim();
  let reason = '';
  let supersedes: number | null = null;
  const inline = /\(?\s*D(\d+)\s*대체\s*\)?/i.exec(content);
  if (inline) {
    supersedes = Number(inline[1]);
    content = content.replace(inline[0], '').trim();
  }
  for (const seg of rest) {
    const r = /^이유\s*[:：]?\s*(.*)$/.exec(seg.trim());
    if (r) {
      reason = (r[1] ?? '').trim();
      continue;
    }
    const s = /^(?:대체|supersedes?)\s*[:：]?\s*D?(\d+)/i.exec(seg.trim());
    if (s) {
      supersedes = Number(s[1]);
      continue;
    }
    if (seg.trim() && !reason) reason = seg.trim();
  }
  if (isPlaceholder(content)) return null;
  if (isPlaceholder(reason) || reason === '이유') reason = '';
  return { content, reason, supersedes };
}

function parseTask(value: string, today: string): SessionTask | null {
  const [head = '', ...rest] = value.split(/\s*\|\s*/);
  if (isPlaceholder(head)) return null;
  let role: Role | null = null;
  let due: string | null = null;
  let priority: Priority | null = null;
  const notes: string[] = [];
  for (const raw of rest) {
    const seg = raw.replace(/^(?:역할|마감|우선순위|우선)\s*[:：]?\s*/, '').trim();
    if (!seg || /^역할\(/.test(raw.trim())) continue;
    const r = toRole(seg);
    if (r && !role) {
      role = r;
      continue;
    }
    const d = parseDateExpr(seg, today);
    if (d && !due) {
      due = d;
      continue;
    }
    const p = toPriority(seg);
    if (p && !priority) {
      priority = p;
      continue;
    }
    if (!/^마감\s*YYYY-MM-DD$/i.test(raw.trim())) notes.push(seg);
  }
  const q = parseQuickAdd(head, [], today);
  return {
    title: q.title,
    role: role ?? q.role,
    due_date: due ?? q.due_date,
    priority: priority ?? (q.priority !== 2 ? q.priority : null),
    note: notes.join(' / '),
  };
}

/** 텍스트에서 [Hub 메모] 블록을 모두 찾아 구조화한다 */
export function parseMemos(text: string, today: string): Memo[] {
  const memos: Memo[] = [];
  const pieces = text.split(START);
  for (let i = 1; i < pieces.length; i++) {
    const body = (pieces[i] ?? '').split(END)[0] ?? '';
    const memo: Memo = { project: null, summary: '', resume: '', decisions: [], tasks: [], done: [] };
    let last: keyof Memo | null = null;
    for (const rawLine of body.split(/\r?\n/)) {
      if (/^\s*```/.test(rawLine)) continue;
      const line = cleanLine(rawLine);
      if (!line) continue;
      const m = KEY_RE.exec(line);
      const key = m ? keyOf(m[1] ?? '') : null;
      if (!m || !key) {
        if (last === 'summary' || last === 'resume') memo[last] = `${memo[last]} ${line}`.trim();
        continue;
      }
      const value = (m[2] ?? '').trim();
      last = key;
      switch (key) {
        case 'project':
          if (!isPlaceholder(value)) memo.project = value;
          break;
        case 'summary':
          if (!isPlaceholder(value)) memo.summary = memo.summary ? `${memo.summary} ${value}` : value;
          break;
        case 'resume':
          if (!isPlaceholder(value)) memo.resume = value;
          break;
        case 'decisions': {
          const d = parseDecision(value);
          if (d) memo.decisions.push(d);
          break;
        }
        case 'tasks': {
          const t = parseTask(value, today);
          if (t) memo.tasks.push(t);
          break;
        }
        case 'done':
          for (const mm of value.matchAll(/T?(\d+)/gi)) memo.done.push(Number(mm[1]));
          break;
      }
    }
    const empty = !memo.summary && !memo.resume && !memo.decisions.length && !memo.tasks.length && !memo.done.length;
    if (!empty) memos.push(memo);
  }
  return memos;
}

export interface MemoApplyResult extends SessionResult {
  projectName: string | null;
}

export function applyMemo(db: Db, memo: Memo, source: string, defaultProjectId: number | null): MemoApplyResult {
  let projectId = defaultProjectId;
  let projectName: string | null = null;
  const errors: string[] = [];
  if (memo.project) {
    try {
      const p = resolveProject(db, memo.project);
      projectId = p.id;
      projectName = p.name;
    } catch (err) {
      if (defaultProjectId === null) errors.push(msg(err));
    }
  }
  if (projectId !== null && projectName === null) {
    projectName = db.get<{ name: string }>('SELECT name FROM projects WHERE id = ?', projectId)?.name ?? null;
  }
  if (projectId === null && !memo.summary && !memo.tasks.length) {
    throw new UserError(errors[0] ?? '어느 프로젝트의 메모인지 알 수 없어요. 프로젝트를 선택해 주세요.');
  }
  const res = recordSession(
    db,
    {
      projectId,
      summary: memo.summary,
      resume: memo.resume,
      decisions: memo.decisions,
      tasks: memo.tasks,
      doneTaskIds: memo.done,
    },
    source,
  );
  return { ...res, errors: [...errors, ...res.errors], projectName };
}
