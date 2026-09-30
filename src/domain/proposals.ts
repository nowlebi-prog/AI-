import type { Db } from '../db.ts';
import { nowIso, formatDate } from '../lib/time.ts';
import { checkSupersedes, createDecision, getDecision } from './decisions.ts';
import { getAutoApprove } from './profile.ts';
import { createProject, findProjectByName, getProject, requireProject, updateProject, type ProjectChanges } from './projects.ts';
import { createTask, getTask, requireTask, updateTask, type TaskChanges } from './tasks.ts';
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
}
export interface TaskUpdatePayload {
  task_id: number;
  changes: TaskChanges;
}
export interface ProjectPayload {
  name: string;
  fields: Partial<Record<ProjectField, string>>;
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

export interface ProposeResult {
  id: number;
  applied: boolean;
  resultId: number | null;
  error?: string;
}

export interface ProposalView extends Proposal {
  project_name: string | null;
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
      if (findProjectByName(db, name)) throw new UserError(`'${name}' 프로젝트가 이미 있어요`);
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

function apply(db: Db, kind: ProposalKind, projectId: number | null, payload: unknown, source: string): number {
  switch (kind) {
    case 'decision': {
      const p = payload as DecisionPayload;
      if (projectId === null) throw new UserError('결정에는 프로젝트가 필요해요');
      return createDecision(db, { project_id: projectId, content: p.content, reason: p.reason, supersedes: p.supersedes }, source).id;
    }
    case 'task': {
      const p = payload as TaskPayload;
      return createTask(
        db,
        { project_id: projectId, title: p.title, role: p.role, priority: p.priority, due_date: p.due_date, note: p.note },
        source,
      ).id;
    }
    case 'task_update': {
      const p = payload as TaskUpdatePayload;
      return updateTask(db, p.task_id, p.changes).id;
    }
    case 'project': {
      const p = payload as ProjectPayload;
      return createProject(db, { name: p.name, ...p.fields }).id;
    }
    case 'project_update': {
      const p = payload as ProjectUpdatePayload;
      if (projectId === null) throw new UserError('프로젝트가 필요해요');
      return updateProject(db, projectId, p.changes).id;
    }
  }
}

export function propose(db: Db, input: ProposalInput, source: string): ProposeResult {
  validate(db, input);
  const r = db.run(
    'INSERT INTO proposals (kind, project_id, payload, source, created_at) VALUES (?, ?, ?, ?, ?)',
    input.kind,
    input.projectId,
    JSON.stringify(input.payload),
    source,
    nowIso(),
  );
  const id = r.lastInsertRowid;
  if (getAutoApprove(db).has(input.kind)) {
    try {
      return { id, applied: true, resultId: approveProposal(db, id) };
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

export function approveProposal(db: Db, id: number, overrides?: Record<string, string>): number {
  return db.tx(() => {
    const p = db.get<Proposal>("SELECT * FROM proposals WHERE id = ? AND status = 'pending'", id);
    if (!p) throw new UserError('이미 처리됐거나 없는 제안이에요');
    let payload = JSON.parse(p.payload) as unknown;
    if (overrides) payload = mergeOverrides(p.kind, payload, overrides);
    const resultId = apply(db, p.kind, p.project_id, payload, p.source);
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
      const details = [ROLE_LABEL[t.role] ?? t.role];
      if (t.priority !== 2) details.push(`우선순위 ${PRIORITY_LABEL[t.priority]}`);
      if (t.due_date) details.push(`마감 ${formatDate(t.due_date)}`);
      if (t.note) details.push(`메모: ${clip(t.note)}`);
      return { title: t.title, details };
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
      if (c.note !== undefined) details.push(`메모 → ${clip(c.note)}`);
      return { title: task ? `[T${task.id}] ${task.title}` : `[T${u.task_id}] (삭제된 할 일)`, details };
    }
    case 'project': {
      const n = payload as ProjectPayload;
      const details = PROJECT_FIELDS.filter((f) => n.fields[f]).map((f) => `${PROJECT_FIELD_LABEL[f]}: ${clip(n.fields[f] ?? '')}`);
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
