export class UserError extends Error {}

export const ROLES = ['dev', 'plan', 'design', 'marketing', 'docs', 'ops', 'etc'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  dev: '개발',
  plan: '기획',
  design: '디자인',
  marketing: '마케팅',
  docs: '문서·PPT',
  ops: '운영',
  etc: '기타',
};

export const TASK_STATUSES = ['todo', 'doing', 'done'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  todo: '할 일',
  doing: '진행 중',
  done: '완료',
};

export const PROJECT_STATUSES = ['active', 'paused', 'done'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABEL: Record<ProjectStatus, string> = {
  active: '진행 중',
  paused: '보류',
  done: '완료',
};

export type Priority = 1 | 2 | 3;
export const PRIORITY_LABEL: Record<Priority, string> = { 1: '높음', 2: '보통', 3: '낮음' };

/** 프로젝트 카드 필드 (이름·상태 제외) */
export const PROJECT_FIELDS = ['summary', 'goal', 'audience', 'stage', 'constraints', 'scope', 'links'] as const;
export type ProjectField = (typeof PROJECT_FIELDS)[number];
export const PROJECT_FIELD_LABEL: Record<ProjectField, string> = {
  summary: '한 줄 소개',
  goal: '목표',
  audience: '타깃',
  stage: '현재 단계',
  constraints: '제약',
  scope: '작업 범위',
  links: '링크',
};

export interface Project {
  id: number;
  name: string;
  status: ProjectStatus;
  /** 주 작업 분야 (Role 값, 없으면 '') */
  kind: string;
  summary: string;
  goal: string;
  audience: string;
  stage: string;
  constraints: string;
  scope: string;
  links: string;
  resume_note: string;
  resume_note_at: string | null;
  resume_note_source: string | null;
  created_at: string;
  updated_at: string;
}

export interface Task {
  id: number;
  project_id: number | null;
  title: string;
  role: Role;
  status: TaskStatus;
  priority: Priority;
  due_date: string | null;
  note: string;
  source: string;
  created_at: string;
  updated_at: string;
  done_at: string | null;
  /** 비어 있지 않으면 '대기 중' (무엇을 기다리는지) */
  waiting: string;
  /** 반복 규칙 (repeat.ts) */
  repeat: string;
  /** 반복 할 일을 완료해서 만들어진 다음 할 일 */
  next_task_id: number | null;
}

export interface TaskWithProject extends Task {
  project_name: string | null;
}

export interface Decision {
  id: number;
  project_id: number;
  content: string;
  reason: string;
  source: string;
  superseded_by: number | null;
  created_at: string;
}

export interface SessionLog {
  id: number;
  project_id: number | null;
  source: string;
  summary: string;
  created_at: string;
}

export interface SessionLogWithProject extends SessionLog {
  project_name: string | null;
}

export const PROPOSAL_KINDS = ['decision', 'task', 'task_update', 'project', 'project_update'] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export const PROPOSAL_KIND_LABEL: Record<ProposalKind, string> = {
  decision: '결정',
  task: '할 일 추가',
  task_update: '할 일 변경',
  project: '새 프로젝트',
  project_update: '프로젝트 카드 수정',
};

export interface Proposal {
  id: number;
  kind: ProposalKind;
  project_id: number | null;
  payload: string;
  source: string;
  status: 'pending' | 'approved' | 'rejected';
  result_id: number | null;
  created_at: string;
  resolved_at: string | null;
}

export function isRole(v: unknown): v is Role {
  return typeof v === 'string' && (ROLES as readonly string[]).includes(v);
}

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}

export function isProjectStatus(v: unknown): v is ProjectStatus {
  return typeof v === 'string' && (PROJECT_STATUSES as readonly string[]).includes(v);
}

const ROLE_ALIASES: Record<string, Role> = {
  dev: 'dev', development: 'dev', 개발: 'dev', 퍼블리싱: 'dev',
  plan: 'plan', planning: 'plan', 기획: 'plan',
  design: 'design', 디자인: 'design',
  marketing: 'marketing', 마케팅: 'marketing',
  docs: 'docs', doc: 'docs', ppt: 'docs', 피피티: 'docs', 문서: 'docs', '문서·ppt': 'docs', 문서ppt: 'docs', 발표: 'docs', 슬라이드: 'docs', 자료: 'docs',
  ops: 'ops', operation: 'ops', operations: 'ops', admin: 'ops', 운영: 'ops',
  etc: 'etc', other: 'etc', 기타: 'etc',
};

/** '디자인', 'design', 'Design' 등을 Role로. 모르면 null */
export function toRole(v: unknown): Role | null {
  if (typeof v !== 'string') return null;
  return ROLE_ALIASES[v.trim().toLowerCase()] ?? null;
}

const PRIORITY_ALIASES: Record<string, Priority> = {
  '1': 1, high: 1, urgent: 1, 높음: 1, 긴급: 1, 급함: 1, 상: 1,
  '2': 2, normal: 2, medium: 2, 보통: 2, 중: 2,
  '3': 3, low: 3, 낮음: 3, 여유: 3, 하: 3,
};

export function toPriority(v: unknown): Priority | null {
  if (typeof v === 'number' && (v === 1 || v === 2 || v === 3)) return v;
  if (typeof v !== 'string') return null;
  return PRIORITY_ALIASES[v.trim().toLowerCase()] ?? null;
}

const TASK_STATUS_ALIASES: Record<string, TaskStatus> = {
  todo: 'todo', 'to do': 'todo', open: 'todo', '할 일': 'todo', 할일: 'todo', 대기: 'todo',
  doing: 'doing', 'in progress': 'doing', in_progress: 'doing', progress: 'doing', '진행 중': 'doing', 진행중: 'doing', 진행: 'doing',
  done: 'done', complete: 'done', completed: 'done', 완료: 'done', 끝: 'done',
};

export function toTaskStatus(v: unknown): TaskStatus | null {
  if (typeof v !== 'string') return null;
  return TASK_STATUS_ALIASES[v.trim().toLowerCase()] ?? null;
}
