import type { Db, Param } from '../db.ts';
import { addDays, daysBetween, makeDate } from '../lib/time.ts';
import { listProjects, progressOf } from './projects.ts';
import { koIndex, nextOccurrence } from './repeat.ts';
import { ROLES, type Role, type TaskStatus } from './types.ts';

/** 월간 달력: 마감일 기준으로 할 일을 날짜 칸에 놓고, 분야별·프로젝트별 진행도를 계산한다 */

export interface MonthItem {
  id: number;
  title: string;
  role: Role;
  status: TaskStatus;
  waiting: boolean;
  project_id: number | null;
  project_name: string | null;
  /** 반복 할 일의 앞으로 올 차례 (아직 만들어지지 않은 가상 항목) */
  virtual: boolean;
  overdue: boolean;
}

export interface MonthCell {
  date: string;
  inMonth: boolean;
  isToday: boolean;
  weekend: boolean;
  items: MonthItem[];
}

export interface RoleProgress {
  role: Role;
  due: number;
  done: number;
  pct: number;
}

export interface ProjectProgress {
  id: number;
  name: string;
  kind: string;
  pct: number;
  done: number;
  total: number;
  monthDue: number;
  monthDone: number;
}

export interface MonthView {
  month: string; // YYYY-MM
  label: string;
  prev: string;
  next: string;
  weeks: MonthCell[][];
  roles: RoleProgress[];
  total: { due: number; done: number; pct: number };
  projects: ProjectProgress[];
}

export function parseMonth(input: string | null | undefined, today: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(input ?? '');
  if (m && Number(m[2]) >= 1 && Number(m[2]) <= 12) return `${m[1]}-${m[2]}`;
  return today.slice(0, 7);
}

function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
}

interface Row {
  id: number;
  title: string;
  role: Role;
  status: TaskStatus;
  waiting: string;
  due_date: string;
  repeat: string;
  project_id: number | null;
  project_name: string | null;
}

export function monthView(db: Db, monthInput: string | null, today: string, filter: { role?: Role; projectId?: number } = {}): MonthView {
  const month = parseMonth(monthInput, today);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = makeDate(y, m, 1) ?? today;
  const last = addDays(m === 12 ? (makeDate(y + 1, 1, 1) ?? first) : (makeDate(y, m + 1, 1) ?? first), -1);
  const gridStart = addDays(first, -koIndex(first));
  const gridEnd = addDays(last, 6 - koIndex(last));

  const where: string[] = ['t.due_date >= ?', 't.due_date <= ?', "(t.project_id IS NULL OR p.status != 'done')"];
  const vals: Param[] = [gridStart, gridEnd];
  if (filter.role) {
    where.push('t.role = ?');
    vals.push(filter.role);
  }
  if (filter.projectId !== undefined) {
    where.push('t.project_id = ?');
    vals.push(filter.projectId);
  }
  const rows = db.all<Row>(
    `SELECT t.id, t.title, t.role, t.status, t.waiting, t.due_date, t.repeat, t.project_id, p.name AS project_name
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE ${where.join(' AND ')}
     ORDER BY t.due_date, t.status = 'done', t.priority, t.id`,
    ...vals,
  );

  const byDate = new Map<string, MonthItem[]>();
  const push = (date: string, item: MonthItem) => byDate.set(date, [...(byDate.get(date) ?? []), item]);
  for (const r of rows) {
    push(r.due_date, {
      id: r.id,
      title: r.title,
      role: r.role,
      status: r.status,
      waiting: r.waiting !== '',
      project_id: r.project_id,
      project_name: r.project_name,
      virtual: false,
      overdue: r.status !== 'done' && r.due_date < today,
    });
  }

  // 반복 할 일: 지금 차례 이후의 날짜도 흐리게 보여 준다
  const repeating = db.all<Row>(
    `SELECT t.id, t.title, t.role, t.status, t.waiting, t.due_date, t.repeat, t.project_id, p.name AS project_name
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.repeat != '' AND t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ?
       AND (t.project_id IS NULL OR p.status = 'active') ${filter.role ? 'AND t.role = ?' : ''} ${filter.projectId !== undefined ? 'AND t.project_id = ?' : ''}`,
    gridEnd,
    ...(filter.role ? [filter.role] : []),
    ...(filter.projectId !== undefined ? [filter.projectId] : []),
  );
  for (const r of repeating) {
    let d = nextOccurrence(r.repeat, r.due_date);
    for (let i = 0; d && d <= gridEnd && i < 45; i++) {
      if (d >= gridStart) {
        push(d, { id: r.id, title: r.title, role: r.role, status: 'todo', waiting: false, project_id: r.project_id, project_name: r.project_name, virtual: true, overdue: false });
      }
      d = nextOccurrence(r.repeat, d);
    }
  }

  const weeks: MonthCell[][] = [];
  const span = daysBetween(gridStart, gridEnd) + 1;
  for (let i = 0; i < span; i++) {
    const date = addDays(gridStart, i);
    if (i % 7 === 0) weeks.push([]);
    weeks[weeks.length - 1]?.push({
      date,
      inMonth: date >= first && date <= last,
      isToday: date === today,
      weekend: koIndex(date) >= 5,
      items: byDate.get(date) ?? [],
    });
  }

  // 이번 달(1일~말일) 마감 기준 진행도 — 가상 항목은 세지 않는다
  const inMonth = rows.filter((r) => r.due_date >= first && r.due_date <= last);
  const roles = ROLES.map((role) => {
    const due = inMonth.filter((r) => r.role === role);
    const done = due.filter((r) => r.status === 'done').length;
    return { role, due: due.length, done, pct: due.length ? Math.round((done / due.length) * 100) : 0 };
  }).filter((r) => r.due > 0);
  const doneAll = inMonth.filter((r) => r.status === 'done').length;

  const projects = listProjects(db, 'active')
    .filter((p) => filter.projectId === undefined || p.id === filter.projectId)
    .filter((p) => !filter.role || p.kind === filter.role || inMonth.some((r) => r.project_id === p.id))
    .map((p) => {
      const mine = inMonth.filter((r) => r.project_id === p.id);
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        pct: progressOf(p),
        done: p.done_tasks,
        total: p.total_tasks,
        monthDue: mine.length,
        monthDone: mine.filter((r) => r.status === 'done').length,
      };
    });

  return {
    month,
    label: `${y}년 ${m}월`,
    prev: shiftMonth(month, -1),
    next: shiftMonth(month, 1),
    weeks,
    roles,
    total: { due: inMonth.length, done: doneAll, pct: inMonth.length ? Math.round((doneAll / inMonth.length) * 100) : 0 },
    projects,
  };
}
