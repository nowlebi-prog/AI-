import type { Db } from '../db.ts';
import { addDays } from '../lib/time.ts';
import { listProjects, type ProjectListItem } from './projects.ts';
import { ROLES, type Role } from './types.ts';

/** 작업 분야(개발·기획·디자인·마케팅·문서·PPT·운영)별 현황 */

export interface RoleStat {
  role: Role;
  open: number;
  overdue: number;
  week: number;
  doing: number;
  waiting: number;
  doneWeek: number;
}

export function roleStats(db: Db, today: string): RoleStat[] {
  const weekEnd = addDays(today, 6);
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString();
  const rows = db.all<{ role: Role; open: number; overdue: number; week: number; doing: number; waiting: number }>(
    `SELECT t.role,
       count(*) AS open,
       sum(CASE WHEN t.due_date < ? AND t.waiting = '' THEN 1 ELSE 0 END) AS overdue,
       sum(CASE WHEN t.due_date >= ? AND t.due_date <= ? THEN 1 ELSE 0 END) AS week,
       sum(CASE WHEN t.status = 'doing' THEN 1 ELSE 0 END) AS doing,
       sum(CASE WHEN t.waiting != '' THEN 1 ELSE 0 END) AS waiting
     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status != 'done' AND (t.project_id IS NULL OR p.status = 'active')
     GROUP BY t.role`,
    today,
    today,
    weekEnd,
  );
  const done = db.all<{ role: Role; n: number }>(
    "SELECT role, count(*) AS n FROM tasks WHERE status = 'done' AND done_at >= ? GROUP BY role",
    since,
  );
  const byRole = new Map(rows.map((r) => [r.role, r]));
  const doneBy = new Map(done.map((d) => [d.role, d.n]));
  return ROLES.map((role) => {
    const r = byRole.get(role);
    return {
      role,
      open: r?.open ?? 0,
      overdue: r?.overdue ?? 0,
      week: r?.week ?? 0,
      doing: r?.doing ?? 0,
      waiting: r?.waiting ?? 0,
      doneWeek: doneBy.get(role) ?? 0,
    };
  });
}

export interface ProjectStat extends ProjectListItem {
  overdue: number;
  done30: number;
  byRole: Partial<Record<Role, number>>;
  nextTask: { id: number; title: string; due_date: string | null } | null;
}

export function projectStats(db: Db, today: string): ProjectStat[] {
  const projects = listProjects(db, 'active');
  const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString();
  const roleRows = db.all<{ project_id: number; role: Role; n: number }>(
    "SELECT project_id, role, count(*) AS n FROM tasks WHERE status != 'done' AND project_id IS NOT NULL GROUP BY project_id, role",
  );
  const overdueRows = db.all<{ project_id: number; n: number }>(
    "SELECT project_id, count(*) AS n FROM tasks WHERE status != 'done' AND waiting = '' AND due_date < ? AND project_id IS NOT NULL GROUP BY project_id",
    today,
  );
  const doneRows = db.all<{ project_id: number; n: number }>(
    "SELECT project_id, count(*) AS n FROM tasks WHERE status = 'done' AND done_at >= ? AND project_id IS NOT NULL GROUP BY project_id",
    since,
  );
  const nextRows = db.all<{ project_id: number; id: number; title: string; due_date: string | null }>(
    `SELECT project_id, id, title, due_date FROM tasks t
     WHERE status != 'done' AND waiting = '' AND project_id IS NOT NULL
     ORDER BY (status = 'doing') DESC, (due_date IS NULL), due_date, priority, id`,
  );
  const byRole = new Map<number, Partial<Record<Role, number>>>();
  for (const r of roleRows) {
    const m = byRole.get(r.project_id) ?? {};
    m[r.role] = r.n;
    byRole.set(r.project_id, m);
  }
  const overdue = new Map(overdueRows.map((r) => [r.project_id, r.n]));
  const done30 = new Map(doneRows.map((r) => [r.project_id, r.n]));
  const next = new Map<number, { id: number; title: string; due_date: string | null }>();
  for (const r of nextRows) if (!next.has(r.project_id)) next.set(r.project_id, { id: r.id, title: r.title, due_date: r.due_date });
  return projects.map((p) => ({
    ...p,
    overdue: overdue.get(p.id) ?? 0,
    done30: done30.get(p.id) ?? 0,
    byRole: byRole.get(p.id) ?? {},
    nextTask: next.get(p.id) ?? null,
  }));
}

/** 앞으로 N일 동안 날짜별 마감 수 */
export function dueHistogram(db: Db, today: string, days = 14): Array<{ date: string; count: number; overdue: boolean }> {
  const end = addDays(today, days - 1);
  const rows = db.all<{ due_date: string; n: number }>(
    `SELECT t.due_date, count(*) AS n FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status != 'done' AND t.due_date IS NOT NULL AND t.due_date <= ? AND (t.project_id IS NULL OR p.status = 'active')
     GROUP BY t.due_date`,
    end,
  );
  const map = new Map(rows.map((r) => [r.due_date, r.n]));
  const overdueCount = rows.filter((r) => r.due_date < today).reduce((s, r) => s + r.n, 0);
  const out: Array<{ date: string; count: number; overdue: boolean }> = [];
  if (overdueCount) out.push({ date: 'overdue', count: overdueCount, overdue: true });
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    out.push({ date: d, count: map.get(d) ?? 0, overdue: false });
  }
  return out;
}
