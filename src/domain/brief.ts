import type { Db } from '../db.ts';
import { ageInDays, dateOf, formatAgo, formatDate, formatDateTime, formatDue } from '../lib/time.ts';
import { listDecisions, listLogs } from './decisions.ts';
import { getProfile } from './profile.ts';
import { listProjects, requireProject } from './projects.ts';
import { pendingCount } from './proposals.ts';
import { listReferences } from './references.ts';
import { describeRepeat } from './repeat.ts';
import { listTasks, recentDone, todayBoard } from './tasks.ts';
import {
  PRIORITY_LABEL,
  PROJECT_STATUS_LABEL,
  ROLE_LABEL,
  toRole,
  type Decision,
  type Project,
  type SessionLog,
  type TaskWithProject,
} from './types.ts';

export type BriefSize = 'S' | 'M' | 'L';
export type BriefMode = 'mcp' | 'paste';

export interface BriefOptions {
  size: BriefSize;
  mode: BriefMode;
  today: string;
  tz: string;
  now?: Date;
}

const LIMITS: Record<BriefSize, { decisions: number; tasks: number; logs: number; logChars: number }> = {
  S: { decisions: 0, tasks: 3, logs: 0, logChars: 0 },
  M: { decisions: 10, tasks: 10, logs: 2, logChars: 300 },
  L: { decisions: 50, tasks: 50, logs: 10, logChars: 1200 },
};

const STALE_DAYS = 30;

export function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

function firstLine(s: string): string {
  return s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';
}

export function taskLine(t: TaskWithProject, today: string, withProject = false): string {
  const bits = [`[T${t.id}] ${t.title}`, ROLE_LABEL[t.role]];
  if (t.priority !== 2) bits.push(`우선순위 ${PRIORITY_LABEL[t.priority]}`);
  if (t.due_date) bits.push(`마감 ${formatDue(t.due_date, today)}${t.due_date < today && t.status !== 'done' ? '(지남)' : ''}`);
  if (t.repeat) bits.push(`반복 ${describeRepeat(t.repeat)}`);
  if (t.waiting) bits.push(`대기: ${t.waiting}`);
  if (t.status === 'doing') bits.push('진행 중');
  if (withProject && t.project_name) bits.push(`P${t.project_id} ${t.project_name}`);
  return `- ${bits.join(' · ')}`;
}

function decisionLine(d: Decision, tz: string): string {
  const reason = d.reason ? ` — 이유: ${d.reason}` : '';
  return `- [D${d.id}] ${d.content}${reason} (${formatDate(dateOf(d.created_at, tz))} · ${d.source})`;
}

function logLine(l: SessionLog, tz: string, chars: number): string {
  return `- ${formatDateTime(l.created_at, tz)} ${l.source}: ${clip(l.summary, chars)}`;
}

function header(title: string, o: BriefOptions): string[] {
  const now = o.now ?? new Date();
  return [`# ${title} · ${o.size}`, `Hub 기준 ${formatDateTime(now.toISOString(), o.tz)} (${o.tz}) · 이 내용이 최신이에요`, ''];
}

function meSection(db: Db, o: BriefOptions): string[] {
  const p = getProfile(db);
  if (!p.name && !p.about && !p.preferences) return [];
  if (o.size === 'S') {
    const who = [p.name, clip(firstLine(p.about), 120)].filter(Boolean).join(' — ');
    return who ? [`나: ${who}`] : [];
  }
  const out = ['## 나'];
  if (p.name || p.about) out.push([p.name, p.about.trim()].filter(Boolean).join(' — '));
  if (p.preferences) out.push(`작업 선호: ${p.preferences.trim()}`);
  out.push('');
  return out;
}

function rules(o: BriefOptions, projectName?: string): string[] {
  if (o.mode === 'paste') {
    return [
      '## 대화를 마칠 때',
      '이 대화에서 정해진 것을 아래 형식으로 정리해 주세요. 사용자가 Hub에 붙여넣어 반영해요. 해당 없는 줄은 빼도 돼요.',
      '',
      '[Hub 메모]',
      `프로젝트: ${projectName ?? '(프로젝트 이름)'}`,
      '요약: 이번 대화 요약 2~3문장',
      '결정: 결정 내용 | 이유: 이유 | 대체: D번호',
      '할 일: 할 일 내용 | 역할(개발/기획/디자인/마케팅/문서·PPT/운영) | 마감 YYYY-MM-DD',
      '완료: T번호, T번호',
      '위치: 어디까지 했는지 한 줄',
      '[/Hub 메모]',
    ];
  }
  if (o.size === 'S') return [];
  return [
    '## Hub 사용 규칙',
    '- 특정 프로젝트 이야기면 get_brief(project)로 먼저 맥락을 확인하세요.',
    '- 중요한 결정 → propose_decision (이전 결정을 바꾸면 supersedes에 D번호)',
    '- 새 할 일 → propose_task / 기존 할 일 완료·변경 → propose_task에 task_id',
    '- 대화를 마칠 때 → log_session (요약과 마지막 위치)',
    '- 제안은 사용자가 Hub 인박스에서 승인해야 반영돼요. 단, 사용자가 "추가해 줘/완료 처리해 줘"처럼 직접 시킨 변경은 direct=true로 보내면 바로 반영돼요.',
  ];
}

function cardLines(p: Project, o: BriefOptions): string[] {
  const out: string[] = [];
  const add = (label: string, v: string) => {
    if (v.trim()) out.push(`- ${label}: ${v.trim()}`);
  };
  add('한 줄 소개', p.summary);
  const kind = toRole(p.kind);
  out.push(
    `- 상태: ${PROJECT_STATUS_LABEL[p.status]}${kind && kind !== 'etc' ? ` · 분야: ${ROLE_LABEL[kind]}` : ''}${p.stage ? ` · 현재 단계: ${p.stage}` : ''}`,
  );
  if (o.size !== 'S') {
    add('목표', p.goal);
    add('타깃', p.audience);
    add('제약', p.constraints);
    add('작업 범위', p.scope);
  }
  if (o.size === 'L') add('링크', p.links);
  const age = ageInDays(p.updated_at, o.now);
  if (o.size !== 'S') {
    out.push(
      age > STALE_DAYS
        ? `- 카드 업데이트: ${formatAgo(p.updated_at, o.now)} ⚠️ 오래된 정보일 수 있어요`
        : `- 카드 업데이트: ${formatAgo(p.updated_at, o.now)}`,
    );
  }
  return out;
}

export function projectBrief(db: Db, projectId: number, o: BriefOptions): string {
  const p = requireProject(db, projectId);
  const lim = LIMITS[o.size];
  const lines: string[] = [];
  lines.push(...header(`브리핑: ${p.name} (P${p.id})`, o));

  const tasks = listTasks(db, { projectId: p.id, status: 'open', today: o.today, limit: lim.tasks });

  if (o.size === 'S') {
    lines.push(...meSection(db, o));
    lines.push(`프로젝트: ${[p.summary, p.stage && `현재 단계 ${p.stage}`].filter(Boolean).join(' · ') || '(소개 없음)'}`);
    if (p.resume_note) lines.push(`마지막 위치: ${p.resume_note} (${formatAgo(p.resume_note_at ?? p.updated_at, o.now)})`);
    if (tasks.length) {
      lines.push('지금 할 일:');
      lines.push(...tasks.map((t) => taskLine(t, o.today)));
    }
    const r = rules(o, p.name);
    if (r.length) lines.push('', ...r);
    return lines.join('\n').trim();
  }

  lines.push(...meSection(db, o));
  lines.push('## 프로젝트', ...cardLines(p, o), '');

  if (p.resume_note) {
    lines.push(
      '## 마지막 위치',
      `${p.resume_note} (${[p.resume_note_source, formatAgo(p.resume_note_at ?? p.updated_at, o.now)].filter(Boolean).join(', ')})`,
      '',
    );
  }

  const decisions = listDecisions(db, p.id, { limit: lim.decisions });
  if (decisions.length) {
    lines.push(`## 유효한 결정${o.size === 'M' ? ` (최근 ${lim.decisions}개)` : ''}`);
    lines.push(...decisions.map((d) => decisionLine(d, o.tz)), '');
  }

  lines.push('## 열린 할 일');
  lines.push(...(tasks.length ? tasks.map((t) => taskLine(t, o.today)) : ['- 없음']), '');

  if (o.size === 'L') {
    const since = new Date((o.now ?? new Date()).getTime() - 7 * 86_400_000).toISOString();
    const done = recentDone(db, p.id, since);
    if (done.length) {
      lines.push('## 최근 완료 (7일)');
      lines.push(...done.map((t) => `- [T${t.id}] ${t.title} (${formatDate(dateOf(t.done_at ?? t.updated_at, o.tz))})`), '');
    }
  }

  const logs = listLogs(db, { projectId: p.id, limit: lim.logs });
  if (logs.length) {
    lines.push('## 최근 세션', ...logs.map((l) => logLine(l, o.tz, lim.logChars)), '');
  }

  if (o.size === 'L') {
    const refs = listReferences(db, { projectId: p.id, limit: 15 });
    if (refs.length) {
      lines.push('## 레퍼런스', ...refs.map((r) => `- [R${r.id}] ${r.title || r.site} (${r.category}) ${r.url}${r.note ? ` — ${clip(r.note, 80)}` : ''}`), '');
    }
  }

  lines.push(...rules(o, p.name));
  return lines.join('\n').trim();
}

export function overviewBrief(db: Db, o: BriefOptions): string {
  const lines: string[] = [];
  lines.push(...header('전체 브리핑', o));
  lines.push(...meSection(db, o));
  if (o.size === 'S' && lines[lines.length - 1] !== '') lines.push('');

  const projects = listProjects(db, 'all');
  const active = projects.filter((p) => p.status === 'active');
  lines.push(`## 진행 중인 프로젝트 (${active.length})`);
  if (!active.length) lines.push('- 없음');
  for (const p of active) {
    const bits = [`[P${p.id}] ${p.name}`];
    if (p.summary) bits.push(clip(p.summary, o.size === 'S' ? 40 : 100));
    if (p.stage && o.size !== 'S') bits.push(`단계: ${p.stage}`);
    if (p.open_tasks) bits.push(`열린 할 일 ${p.open_tasks}`);
    if (p.resume_note && o.size !== 'S') bits.push(`마지막 위치: ${clip(p.resume_note, 60)} (${formatAgo(p.resume_note_at ?? p.updated_at, o.now)})`);
    lines.push(`- ${bits.join(' · ')}`);
  }
  if (o.size === 'L') {
    const others = projects.filter((p) => p.status !== 'active');
    if (others.length) {
      lines.push('', '## 보류·완료 프로젝트');
      lines.push(...others.map((p) => `- [P${p.id}] ${p.name} (${PROJECT_STATUS_LABEL[p.status]})`));
    }
  }
  lines.push('');

  const board = todayBoard(db, o.today);
  const max = o.size === 'S' ? 5 : o.size === 'M' ? 12 : 40;
  const focus = [...board.overdue, ...board.today, ...board.doing];
  if (o.size !== 'S') focus.push(...board.week);
  lines.push('## 오늘 챙길 것');
  if (!focus.length) lines.push('- 마감이 가까운 할 일이 없어요');
  lines.push(...focus.slice(0, max).map((t) => taskLine(t, o.today, true)));
  if (focus.length > max) lines.push(`- 외 ${focus.length - max}개`);
  lines.push('');

  const pending = pendingCount(db);
  if (pending) lines.push(`인박스: 승인 대기 ${pending}건`, '');

  if (o.size !== 'S') {
    const logs = listLogs(db, { limit: o.size === 'M' ? 3 : 10 });
    if (logs.length) {
      lines.push('## 최근 세션');
      lines.push(
        ...logs.map((l) => `${logLine(l, o.tz, LIMITS[o.size].logChars).replace(/^- /, `- ${l.project_name ? `[${l.project_name}] ` : ''}`)}`),
        '',
      );
    }
  }

  lines.push(...rules(o));
  return lines.join('\n').trim();
}
