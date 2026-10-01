import type { Db } from '../db.ts';
import { formatDate, nowIso } from '../lib/time.ts';
import { recordActivity, snapshotProject, type ActivityVia } from './activity.ts';
import { checkSupersedes, createDecision, getDecision, listDecisions } from './decisions.ts';
import { getAutoApprove, getSetting } from './profile.ts';
import { createProject, findProjectByName, getProject, requireProject, updateProject, type ProjectChanges } from './projects.ts';
import { describeRepeat } from './repeat.ts';
import {
  createTask,
  findOpenTaskByTitle,
  getTask,
  normalizeForMatch,
  requireTask,
  snapshotTask,
  updateTask,
  type TaskChanges,
} from './tasks.ts';
import {
  PRIORITY_LABEL,
  PROJECT_FIELDS,
  PROJECT_FIELD_LABEL,
  PROJECT_STATUS_LABEL,
  ROLE_LABEL,
  TASK_STATUS_LABEL,
  UserError,
  toPriority,
  toRole,
  type Priority,
  type ProjectField,
  type Proposal,
  type ProposalKind,
  type Role,
} from './types.ts';

export interface DecisionPayload {
  content: string;
  reason: string;
  supersedes: number | null;
}
export interface TaskPayload {
  title: string;
  role: Role;
  priority: Priority;
  due_date: string | null;
  note: string;
  repeat?: string;
  waiting?: string;
}
export interface TaskUpdatePayload {
  task_id: number;
  changes: TaskChanges;
}
export interface ProjectPayload {
  name: string;
  fields: Partial<Record<ProjectField, string>>;
  /** 주 작업 분야 (Role) */
  kind?: string;
  /** 새 프로젝트와 함께 만들 결정·할 일 (한 번에 승인) */
  decisions?: Array<{ content: string; reason?: string }>;
  tasks?: TaskPayload[];
}
export interface ProjectUpdatePayload {
  changes: ProjectChanges;
}

export type ProposalInput =
  | { kind: 'decision'; projectId: number; payload: DecisionPayload }
  | { kind: 'task'; projectId: number | null; payload: TaskPayload }
  | { kind: 'task_update'; projectId: number | null; payload: TaskUpdatePayload }
  | { kind: 'project'; projectId: null; payload: ProjectPayload }
  | { kind: 'project_update'; projectId: number; payload: ProjectUpdatePayload };

export interface Duplicate {
  type: 'task' | 'decision' | 'proposal';
  id: number;
  title: string;
}

export interface ProposeResult {
  /** 제안 번호 (중복으로 건너뛰면 0) */
  id: number;
  applied: boolean;
  resultId: number | null;
  via?: ActivityVia;
  duplicate?: Duplicate;
  error?: string;
}

export interface ProposalView extends Proposal {
  project_name: string | null;
}

/** 사용자가 AI에게 직접 시킨 변경을 바로 반영할지 (기본: 켜짐) */
export function getDirectApply(db: Db): boolean {
  return getSetting(db, 'direct_apply') !== '0';
}

function validate(db: Db, input: ProposalInput): void {
  switch (input.kind) {
    case 'decision': {
      requireProject(db, input.projectId);
      if (!input.payload.content.trim()) throw new UserError('결정 내용이 비어 있어요');
      checkSupersedes(db, input.projectId, input.payload.supersedes);
      return;
    }
    case 'task': {
      if (input.projectId !== null) requireProject(db, input.projectId);
      if (!input.payload.title.trim()) throw new UserError('할 일 제목이 비어 있어요');
      return;
    }
    case 'task_update': {
      requireTask(db, input.payload.task_id);
      if (!Object.keys(input.payload.changes).length) throw new UserError('바꿀 내용이 없어요');
      if (input.payload.changes.title !== undefined && !input.payload.changes.title.trim()) {
        throw new UserError('할 일 제목이 비어 있어요');
      }
      return;
    }
    case 'project': {
      const name = input.payload.name.trim();
      if (!name) throw new UserError('프로젝트 이름이 비어 있어요');
      if (findProjectByName(db, name)) throw new UserError(`'${name}' 프로젝트가 이미 있어요. 기존 프로젝트를 고치려면 project를 지정해 주세요`);
      return;
    }
    case 'project_update': {
      requireProject(db, input.projectId);
      if (!Object.keys(input.payload.changes).length) throw new UserError('바꿀 내용이 없어요');
      const name = input.payload.changes.name;
      if (name !== undefined) {
        const other = findProjectByName(db, name);
        if (other && other.id !== input.projectId) throw new UserError(`'${name}' 프로젝트가 이미 있어요`);
      }
      return;
    }
  }
}

function pendingOfKind(db: Db, kind: ProposalKind, projectId: number | null): Proposal[] {
  return db.all<Proposal>(
    `SELECT * FROM proposals WHERE status = 'pending' AND kind = ? AND ${projectId === null ? 'project_id IS NULL' : 'project_id = ?'}`,
    ...(projectId === null ? [kind] : [kind, projectId]),
  );
}

/** AI가 같은 걸 두 번 올리는 걸 막는다 */
function findDuplicate(db: Db, input: ProposalInput): Duplicate | undefined {
  if (input.kind === 'task') {
    const t = findOpenTaskByTitle(db, input.projectId, input.payload.title);
    if (t) return { type: 'task', id: t.id, title: t.title };
    const key = normalizeForMatch(input.payload.title);
    const p = pendingOfKind(db, 'task', input.projectId).find((x) => normalizeForMatch((JSON.parse(x.payload) as TaskPayload).title) === key);
    if (p) return { type: 'proposal', id: p.id, title: input.payload.title };
  }
  if (input.kind === 'decision') {
    const key = normalizeForMatch(input.payload.content);
    const d = listDecisions(db, input.projectId).find((x) => normalizeForMatch(x.content) === key);
    if (d) return { type: 'decision', id: d.id, title: d.content };
    const p = pendingOfKind(db, 'decision', input.projectId).find(
      (x) => normalizeForMatch((JSON.parse(x.payload) as DecisionPayload).content) === key,
    );
    if (p) return { type: 'proposal', id: p.id, title: input.payload.content };
  }
  return undefined;
}

function taskSummary(t: { id: number; title: string }): string {
  return `[T${t.id}] ${t.title}`;
}

/** 제안 내용을 실제로 반영하고 기록을 남긴다 */
function apply(db: Db, p: Proposal, payload: unknown, via: ActivityVia): number {
  const base = { source: p.source, via };
  switch (p.kind) {
    case 'decision': {
      const d = payload as DecisionPayload;
      if (p.project_id === null) throw new UserError('결정에는 프로젝트가 필요해요');
      const created = createDecision(db, { project_id: p.project_id, content: d.content, reason: d.reason, supersedes: d.supersedes }, p.source);
      recordActivity(db, { ...base, action: 'decision.create', entity_id: created.id, project_id: p.project_id, summary: `결정 [D${created.id}] ${d.content}` });
      return created.id;
    }
    case 'task': {
      const t = payload as TaskPayload;
      const created = createTask(
        db,
        { project_id: p.project_id, title: t.title, role: t.role, priority: t.priority, due_date: t.due_date, note: t.note, repeat: t.repeat, waiting: t.waiting },
        p.source,
      );
      recordActivity(db, { ...base, action: 'task.create', entity_id: created.id, project_id: p.project_id, summary: `할 일 추가 ${taskSummary(created)}` });
      return created.id;
    }
    case 'task_update': {
      const u = payload as TaskUpdatePayload;
      const before = snapshotTask(requireTask(db, u.task_id));
      const res = updateTask(db, u.task_id, u.changes);
      const what = u.changes.status ? `${TASK_STATUS_LABEL[u.changes.status]}로` : '변경';
      recordActivity(db, {
        ...base,
        action: 'task.update',
        entity_id: u.task_id,
        project_id: res.task.project_id,
        summary: `할 일 ${what} ${taskSummary(res.task)}${res.spawned ? ` (다음 반복 T${res.spawned.id} 생성)` : ''}`,
        before: { ...before, spawned: res.spawned?.id ?? null },
      });
      return u.task_id;
    }
    case 'project': {
      const n = payload as ProjectPayload;
      const proj = createProject(db, { name: n.name, ...n.fields, kind: n.kind ?? '' });
      for (const d of n.decisions ?? []) {
        if (d.content?.trim()) createDecision(db, { project_id: proj.id, content: d.content, reason: d.reason ?? '' }, p.source);
      }
      for (const t of n.tasks ?? []) {
        if (!t.title?.trim()) continue;
        createTask(
          db,
          { project_id: proj.id, title: t.title, role: t.role, priority: t.priority, due_date: t.due_date, note: t.note, repeat: t.repeat },
          p.source,
        );
      }
      const extra = [n.decisions?.length ? `결정 ${n.decisions.length}` : '', n.tasks?.length ? `할 일 ${n.tasks.length}` : ''].filter(Boolean).join(', ');
      recordActivity(db, { ...base, action: 'project.create', entity_id: proj.id, project_id: proj.id, summary: `새 프로젝트 [P${proj.id}] ${proj.name}${extra ? ` (${extra})` : ''}` });
      return proj.id;
    }
    case 'project_update': {
      const u = payload as ProjectUpdatePayload;
      if (p.project_id === null) throw new UserError('프로젝트가 필요해요');
      const before = snapshotProject(requireProject(db, p.project_id));
      const proj = updateProject(db, p.project_id, u.changes);
      recordActivity(db, {
        ...base,
        action: 'project.update',
        entity_id: proj.id,
        project_id: proj.id,
        summary: `프로젝트 카드 수정 [P${proj.id}] ${proj.name} (${Object.keys(u.changes).join(', ')})`,
        before,
      });
      return proj.id;
    }
  }
}

export function propose(db: Db, input: ProposalInput, source: string, opts: { direct?: boolean } = {}): ProposeResult {
  validate(db, input);
  const duplicate = findDuplicate(db, input);
  if (duplicate) return { id: 0, applied: false, resultId: null, duplicate };
  const r = db.run(
    'INSERT INTO proposals (kind, project_id, payload, source, created_at) VALUES (?, ?, ?, ?, ?)',
    input.kind,
    input.projectId,
    JSON.stringify(input.payload),
    source,
    nowIso(),
  );
  const id = r.lastInsertRowid;
  const via: ActivityVia | null = opts.direct && getDirectApply(db) ? 'direct' : getAutoApprove(db).has(input.kind) ? 'auto' : null;
  if (via) {
    try {
      return { id, applied: true, resultId: approveProposal(db, id, { via }), via };
    } catch (err) {
      return { id, applied: false, resultId: null, error: err instanceof Error ? err.message : String(err) };
    }
  }
  return { id, applied: false, resultId: null };
}

export function getProposal(db: Db, id: number): ProposalView | undefined {
  return db.get<ProposalView>(
    'SELECT pr.*, p.name AS project_name FROM proposals pr LEFT JOIN projects p ON p.id = pr.project_id WHERE pr.id = ?',
    id,
  );
}

/** 승인 화면에서 고친 값 반영 (결정·할 일만) */
function mergeOverrides(kind: ProposalKind, payload: unknown, o: Record<string, string>): unknown {
  if (kind === 'decision') {
    const p = { ...(payload as DecisionPayload) };
    if (o.content !== undefined) p.content = o.content;
    if (o.reason !== undefined) p.reason = o.reason;
    return p;
  }
  if (kind === 'task') {
    const p = { ...(payload as TaskPayload) };
    if (o.title !== undefined) p.title = o.title;
    if (o.role !== undefined) p.role = toRole(o.role) ?? p.role;
    if (o.priority !== undefined) p.priority = toPriority(o.priority) ?? p.priority;
    if (o.due_date !== undefined) p.due_date = o.due_date || null;
    return p;
  }
  return payload;
}

export function approveProposal(db: Db, id: number, opts: { overrides?: Record<string, string>; via?: ActivityVia } = {}): number {
  return db.tx(() => {
    const p = db.get<Proposal>("SELECT * FROM proposals WHERE id = ? AND status = 'pending'", id);
    if (!p) throw new UserError('이미 처리됐거나 없는 제안이에요');
    let payload = JSON.parse(p.payload) as unknown;
    if (opts.overrides) payload = mergeOverrides(p.kind, payload, opts.overrides);
    const resultId = apply(db, p, payload, opts.via ?? 'approved');
    db.run(
      "UPDATE proposals SET status = 'approved', result_id = ?, payload = ?, resolved_at = ? WHERE id = ?",
      resultId,
      JSON.stringify(payload),
      nowIso(),
      id,
    );
    return resultId;
  });
}

export function rejectProposal(db: Db, id: number): void {
  const r = db.run("UPDATE proposals SET status = 'rejected', resolved_at = ? WHERE id = ? AND status = 'pending'", nowIso(), id);
  if (!r.changes) throw new UserError('이미 처리됐거나 없는 제안이에요');
}

export function listProposals(db: Db, status: 'pending' | 'resolved', limit = 200): ProposalView[] {
  const where = status === 'pending' ? "pr.status = 'pending'" : "pr.status != 'pending'";
  const order = status === 'pending' ? 'pr.created_at ASC, pr.id ASC' : 'pr.resolved_at DESC, pr.id DESC';
  return db.all<ProposalView>(
    `SELECT pr.*, p.name AS project_name FROM proposals pr LEFT JOIN projects p ON p.id = pr.project_id
     WHERE ${where} ORDER BY ${order} LIMIT ?`,
    limit,
  );
}

export function pendingCount(db: Db): number {
  return db.get<{ n: number }>("SELECT count(*) AS n FROM proposals WHERE status = 'pending'")?.n ?? 0;
}

function clip(s: string, n = 80): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

export interface ProposalDescription {
  title: string;
  details: string[];
}

function taskDetails(t: TaskPayload): string[] {
  const details = [ROLE_LABEL[t.role] ?? t.role];
  if (t.priority !== 2) details.push(`우선순위 ${PRIORITY_LABEL[t.priority]}`);
  if (t.due_date) details.push(`마감 ${formatDate(t.due_date)}`);
  if (t.repeat) details.push(`반복 ${describeRepeat(t.repeat)}`);
  if (t.waiting) details.push(`대기: ${t.waiting}`);
  if (t.note) details.push(`메모: ${clip(t.note)}`);
  return details;
}

/** 인박스·도구 응답에 보여줄 설명 */
export function describeProposal(db: Db, p: Proposal): ProposalDescription {
  const payload = JSON.parse(p.payload) as unknown;
  switch (p.kind) {
    case 'decision': {
      const d = payload as DecisionPayload;
      const details: string[] = [];
      if (d.reason) details.push(`이유: ${d.reason}`);
      if (d.supersedes) {
        const old = getDecision(db, d.supersedes);
        details.push(`D${d.supersedes} 대체${old ? `: ${clip(old.content, 60)}` : ''}`);
      }
      return { title: d.content, details };
    }
    case 'task': {
      const t = payload as TaskPayload;
      return { title: t.title, details: taskDetails(t) };
    }
    case 'task_update': {
      const u = payload as TaskUpdatePayload;
      const task = getTask(db, u.task_id);
      const c = u.changes;
      const details: string[] = [];
      if (c.status !== undefined) {
        details.push(`상태: ${task ? TASK_STATUS_LABEL[task.status] : '?'} → ${TASK_STATUS_LABEL[c.status]}`);
      }
      if (c.title !== undefined) details.push(`제목 → ${c.title}`);
      if (c.role !== undefined) details.push(`역할 → ${ROLE_LABEL[c.role]}`);
      if (c.priority !== undefined) details.push(`우선순위 → ${PRIORITY_LABEL[c.priority]}`);
      if (c.due_date !== undefined) details.push(`마감 → ${c.due_date ? formatDate(c.due_date) : '없음'}`);
      if (c.repeat !== undefined) details.push(`반복 → ${c.repeat ? describeRepeat(c.repeat) : '없음'}`);
      if (c.waiting !== undefined) details.push(c.waiting ? `대기 → ${c.waiting}` : '대기 해제');
      if (c.note !== undefined) details.push(`메모 → ${clip(c.note)}`);
      if (c.project_id !== undefined) details.push(`프로젝트 → ${c.project_id ? getProject(db, c.project_id)?.name ?? `P${c.project_id}` : '없음'}`);
      return { title: task ? `[T${task.id}] ${task.title}` : `[T${u.task_id}] (삭제된 할 일)`, details };
    }
    case 'project': {
      const n = payload as ProjectPayload;
      const details = PROJECT_FIELDS.filter((f) => n.fields[f]).map((f) => `${PROJECT_FIELD_LABEL[f]}: ${clip(n.fields[f] ?? '')}`);
      const kind = toRole(n.kind ?? '');
      if (kind && kind !== 'etc') details.unshift(`분야: ${ROLE_LABEL[kind]}`);
      if (n.decisions?.length) details.push(`결정 ${n.decisions.length}개: ${n.decisions.slice(0, 4).map((d) => clip(d.content, 30)).join(' / ')}${n.decisions.length > 4 ? ' …' : ''}`);
      if (n.tasks?.length) details.push(`할 일 ${n.tasks.length}개: ${n.tasks.slice(0, 4).map((t) => clip(t.title, 30)).join(' / ')}${n.tasks.length > 4 ? ' …' : ''}`);
      return { title: n.name, details };
    }
    case 'project_update': {
      const u = payload as ProjectUpdatePayload;
      const proj = p.project_id !== null ? getProject(db, p.project_id) : undefined;
      const details: string[] = [];
      if (u.changes.name !== undefined) details.push(`이름: ${proj?.name ?? '?'} → ${u.changes.name}`);
      if (u.changes.status !== undefined) {
        details.push(`상태: ${proj ? PROJECT_STATUS_LABEL[proj.status] : '?'} → ${PROJECT_STATUS_LABEL[u.changes.status]}`);
      }
      if (u.changes.kind !== undefined) {
        const k = toRole(u.changes.kind);
        details.push(`분야 → ${k && k !== 'etc' ? ROLE_LABEL[k] : '없음'}`);
      }
      for (const f of PROJECT_FIELDS) {
        const v = u.changes[f];
        if (v === undefined) continue;
        const before = proj?.[f] ?? '';
        details.push(`${PROJECT_FIELD_LABEL[f]}: ${before ? `${clip(before, 40)} → ` : ''}${clip(v)}`);
      }
      return { title: proj?.name ?? '(삭제된 프로젝트)', details };
    }
  }
}

/** 도구 응답용 한 줄 */
export function proposeMessage(r: ProposeResult, what: string): string {
  if (r.duplicate) {
    const d = r.duplicate;
    return d.type === 'proposal'
      ? `이미 인박스에 같은 제안이 있어요 (#${d.id}) — 새로 올리지 않았어요: ${what}`
      : `이미 같은 ${d.type === 'task' ? `할 일이 있어요 (T${d.id})` : `결정이 있어요 (D${d.id})`} — 새로 만들지 않았어요: ${what}`;
  }
  if (r.applied) {
    return r.via === 'direct'
      ? `요청대로 바로 반영했어요: ${what}. (되돌리려면 Hub 인박스 → 변경 기록)`
      : `자동 승인 규칙에 따라 바로 반영했어요: ${what}`;
  }
  if (r.error) return `제안 #${r.id}을 인박스에 올렸지만 바로 반영하지 못했어요 (${r.error}): ${what}`;
  return `인박스에 올렸어요 (제안 #${r.id}): ${what}. 사용자가 Hub에서 승인하면 반영돼요.`;
}
