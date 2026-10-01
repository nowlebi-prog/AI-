import type { Db } from '../db.ts';
import { addDays } from '../lib/time.ts';
import { toRRule } from './repeat.ts';
import { PRIORITY_LABEL, ROLE_LABEL, type TaskWithProject } from './types.ts';

/** 마감이 있는 열린 할 일을 iCalendar(ICS)로 — 구글·애플 캘린더에서 구독하면 폰 알림을 받을 수 있다 */

export function icsEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

/** RFC 5545: 한 줄은 75옥텟(UTF-8 바이트)을 넘기지 않고, 넘치면 CRLF + 공백으로 접는다 */
export function foldLine(line: string): string {
  const out: string[] = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch, 'utf8');
    const limit = out.length === 0 ? 75 : 74; // 이어지는 줄은 앞의 공백 1바이트 포함
    if (bytes + n > limit) {
      out.push(cur);
      cur = '';
      bytes = 0;
    }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

function stamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function ymd(date: string): string {
  return date.replace(/-/g, '');
}

export function buildIcs(db: Db, baseUrl: string, calName = 'Hub 할 일'): string {
  const tasks = db.all<TaskWithProject>(
    `SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
     WHERE t.status != 'done' AND t.due_date IS NOT NULL AND (t.project_id IS NULL OR p.status = 'active')
     ORDER BY t.due_date LIMIT 1000`,
  );
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Hub//Tasks//KO',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(calName)}`,
    'X-WR-TIMEZONE:Asia/Seoul',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];
  for (const t of tasks) {
    if (!t.due_date) continue;
    const title = `${t.project_name ? `[${t.project_name}] ` : ''}${t.title}${t.waiting ? ' (대기)' : ''}`;
    const desc = [
      `${ROLE_LABEL[t.role]} · 우선순위 ${PRIORITY_LABEL[t.priority]}${t.status === 'doing' ? ' · 진행 중' : ''}`,
      t.waiting ? `대기: ${t.waiting}` : '',
      t.note,
      t.project_id ? `${baseUrl}/projects/${t.project_id}#task-${t.id}` : `${baseUrl}/`,
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(
      'BEGIN:VEVENT',
      `UID:task-${t.id}@hub`,
      `DTSTAMP:${stamp(t.updated_at)}`,
      `LAST-MODIFIED:${stamp(t.updated_at)}`,
      `DTSTART;VALUE=DATE:${ymd(t.due_date)}`,
      `DTEND;VALUE=DATE:${ymd(addDays(t.due_date, 1))}`,
      `SUMMARY:${icsEscape(title)}`,
      `DESCRIPTION:${icsEscape(desc)}`,
      `CATEGORIES:${icsEscape(ROLE_LABEL[t.role])}`,
      'TRANSP:TRANSPARENT',
    );
    if (t.project_id) lines.push(`URL:${baseUrl}/projects/${t.project_id}`);
    const rrule = t.repeat ? toRRule(t.repeat) : null;
    if (rrule) lines.push(`RRULE:${rrule}`);
    if (t.priority === 1) lines.push('PRIORITY:1');
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
