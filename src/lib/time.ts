/** 날짜는 'YYYY-MM-DD' 문자열, 시각은 ISO(UTC) 문자열로 다룬다. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayIn(tz: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function makeDate(y: number, m: number, d: number): string | null {
  const s = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return isValidDate(s) ? s : null;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** 0=일 … 6=토 */
export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** '10/3(금)' */
export function formatDate(date: string): string {
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}(${WEEKDAY_KO[weekday(date)]})`;
}

/** 마감일 표시: 오늘/내일/어제/10/3(금) */
export function formatDue(date: string, today: string): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return '오늘';
  if (diff === 1) return '내일';
  if (diff === -1) return '어제';
  return formatDate(date);
}

function parts(iso: string, tz: string): Record<string, string> {
  const out: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  for (const p of fmt.formatToParts(new Date(iso))) out[p.type] = p.value;
  return out;
}

/** '9/30 18:20' */
export function formatDateTime(iso: string, tz: string): string {
  const p = parts(iso, tz);
  return `${p.month}/${p.day} ${p.hour}:${p.minute}`;
}

/** 해당 시간대 기준 날짜 'YYYY-MM-DD' */
export function dateOf(iso: string, tz: string): string {
  return todayIn(tz, new Date(iso));
}

/** '방금', '3시간 전', '2일 전' */
export function formatAgo(iso: string, now: Date = new Date()): string {
  const sec = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 1000));
  if (sec < 60) return '방금';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  const day = Math.floor(hr / 24);
  if (day < 60) return `${day}일 전`;
  return `${Math.floor(day / 30)}개월 전`;
}

export function ageInDays(iso: string, now: Date = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
}
