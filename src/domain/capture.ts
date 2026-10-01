import type { Db } from '../db.ts';
import { recordActivity } from './activity.ts';
import { createLog } from './decisions.ts';
import { getProject, resolveProject, setResumeNote } from './projects.ts';
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
  repeat?: string;
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
    const log = createLog(db, { project_id: rec.projectId, summary: rec.summary }, source);
    out.logId = log.id;
    recordActivity(db, { source, via: 'session', action: 'log.create', entity_id: log.id, project_id: rec.projectId, summary: `세션 기록 [L${log.id}] ${rec.summary.slice(0, 80)}` });
  }
  if (rec.resume.trim()) {
    if (rec.projectId === null) out.errors.push('마지막 위치는 프로젝트가 있어야 저장할 수 있어요');
    else {
      const p = getProject(db, rec.projectId);
      setResumeNote(db, rec.projectId, rec.resume, source);
      recordActivity(db, {
        source,
        via: 'session',
        action: 'resume.update',
        entity_id: rec.projectId,
        project_id: rec.projectId,
        summary: `마지막 위치: ${rec.resume.slice(0, 80)}`,
        before: { resume_note: p?.resume_note ?? '', resume_note_at: p?.resume_note_at ?? null, resume_note_source: p?.resume_note_source ?? null },
      });
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
              repeat: t.repeat ?? '',
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
// AI마다 형식을 조금씩 바꿔서 쓰므로 넉넉하게 읽는다:
//   [Hub 메모] / ## Hub 메모 / **Hub 메모** / 【Hub 메모】, 키 동의어, 키 아래 목록, 끝 태그 생략

export interface Memo {
  project: string | null;
  summary: string;
  resume: string;
  decisions: SessionDecision[];
  tasks: SessionTask[];
  done: number[];
}

type MemoKey = 'project' | 'summary' | 'resume' | 'decisions' | 'tasks' | 'done';

const START_LINE = /^\s*(?:#{1,6}\s*)?(?:\*\*|__)?\s*[[【]?\s*hub\s*메모\s*[\]】]?\s*(?:\*\*|__)?\s*:?\s*$/i;
const START_INLINE = /[[【]\s*hub\s*메모\s*[\]】]/i;
const END = /[[【]\s*\/\s*hub\s*메모\s*[\]】]|\[\s*hub\s*메모\s*끝\s*\]/i;

const KEYS: Array<[MemoKey, string[]]> = [
  ['project', ['프로젝트', 'project']],
  ['summary', ['요약', '대화요약', '대화 요약', '요약문', 'summary']],
  ['decisions', ['결정', '결정사항', '결정 사항', '정한것', '정한 것', 'decision', 'decisions']],
  ['tasks', ['할일', '할 일', '해야할일', '해야 할 일', '다음할일', '다음 할 일', '다음단계', '다음 단계', '액션', '액션아이템', 'todo', 'to-do', 'task', 'tasks', 'next']],
  ['done', ['완료', '완료한일', '완료한 일', '끝낸일', '끝낸 일', 'done', 'completed']],
  ['resume', ['위치', '마지막위치', '마지막 위치', '현재위치', '현재 위치', '진행위치', '진행 위치', '이어서', '다음에이어서', '다음에 이어서', 'resume', 'where']],
];

const KEY_LOOKUP = new Map<string, MemoKey>();
for (const [key, names] of KEYS) for (const n of names) KEY_LOOKUP.set(n.replace(/\s+/g, '').toLowerCase(), key);

const KEY_RE = new RegExp(
  `^(${[...new Set(KEYS.flatMap(([, n]) => n))].sort((a, b) => b.length - a.length).map((n) => n.replace(/\s+/g, '\\s*').replace(/-/g, '\\-')).join('|')})\\s*[:：]\\s*(.*)$`,
  'i',
);

const PLACEHOLDERS = new Set([
  '',
  '-',
  '없음',
  '(없음)',
  '해당 없음',
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

function stripDecor(line: string): { text: string; bullet: boolean } {
  const bullet = /^\s*(?:[-*•·]|\d+[.)]|\[[ xX]\])\s+/.test(line);
  const text = line
    .replace(/^\s*(?:[-*•·]|\d+[.)])\s+/, '')
    .replace(/^\s*\[[ xX]\]\s+/, '')
    .replace(/^\s*[\p{Extended_Pictographic}\uFE0F\u200D]+\s*/u, '')
    .replace(/\*\*|__/g, '')
    .replace(/^`+|`+$/g, '')
    .trim();
  return { text, bullet };
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
  const why = /\s+[-—–]\s*(?:이유|왜)\s*[:：]\s*(.+)$/.exec(content) ?? /\s*\((?:이유|왜)\s*[:：]\s*([^)]+)\)\s*$/.exec(content);
  if (why) {
    reason = (why[1] ?? '').trim();
    content = content.slice(0, why.index).trim();
  }
  for (const seg of rest) {
    const r = /^(?:이유|왜)\s*[:：]?\s*(.*)$/.exec(seg.trim());
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
    repeat: q.repeat,
  };
}

function addValue(memo: Memo, key: MemoKey, value: string, today: string): void {
  if (!value || isPlaceholder(value)) return;
  switch (key) {
    case 'project':
      memo.project = value;
      break;
    case 'summary':
      memo.summary = memo.summary ? `${memo.summary} ${value}` : value;
      break;
    case 'resume':
      memo.resume = memo.resume ? `${memo.resume} ${value}` : value;
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

function splitBlocks(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const blocks: string[][] = [];
  let cur: string[] | null = null;
  for (const line of lines) {
    if (START_LINE.test(line) || (START_INLINE.test(line) && !END.test(line))) {
      cur = [];
      blocks.push(cur);
      const after = line.replace(START_INLINE, '').trim();
      if (after && !START_LINE.test(line)) cur.push(after);
      continue;
    }
    if (!cur) continue;
    if (END.test(line)) {
      cur = null;
      continue;
    }
    cur.push(line);
  }
  return blocks.map((b) => b.join('\n'));
}

/** 텍스트에서 [Hub 메모] 블록을 모두 찾아 구조화한다 */
export function parseMemos(text: string, today: string): Memo[] {
  const memos: Memo[] = [];
  for (const body of splitBlocks(text)) {
    const memo: Memo = { project: null, summary: '', resume: '', decisions: [], tasks: [], done: [] };
    let listKey: MemoKey | null = null; // '결정:' 처럼 값 없이 끝난 키 → 아래 목록이 값
    let lastKey: MemoKey | null = null; // 이어 쓰기 대상 (빈 줄이 나오면 끊김)
    for (const rawLine of body.split(/\r?\n/)) {
      if (/^\s*```/.test(rawLine)) continue;
      if (!rawLine.trim()) {
        lastKey = null;
        continue;
      }
      const { text: line, bullet } = stripDecor(rawLine);
      if (!line) continue;
      const m = KEY_RE.exec(line);
      const key = m ? KEY_LOOKUP.get((m[1] ?? '').replace(/\s+/g, '').toLowerCase()) ?? null : null;
      if (m && key) {
        const value = (m[2] ?? '').trim();
        if (value) {
          addValue(memo, key, value, today);
          listKey = null;
        } else {
          listKey = key;
        }
        lastKey = key;
        continue;
      }
      if (bullet && listKey) {
        addValue(memo, listKey, line, today);
        continue;
      }
      if (lastKey === 'summary' || (listKey === 'summary' && !bullet)) {
        addValue(memo, 'summary', line, today);
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
