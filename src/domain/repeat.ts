import { addDays, makeDate, weekday } from '../lib/time.ts';
import { UserError } from './types.ts';

/**
 * 반복 규칙 문자열
 *   ''            반복 없음
 *   'daily'       매일
 *   'weekdays'    평일(월~금)
 *   'weekly:0,2'  매주 월·수 (0=월 … 6=일)
 *   'monthly:10'  매월 10일 (31 = 말일, 짧은 달은 말일로 당김)
 */

const KO_DAY = ['월', '화', '수', '목', '금', '토', '일'];
const RR_DAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];

/** 월=0 … 일=6 */
export function koIndex(date: string): number {
  return (weekday(date) + 6) % 7;
}

type Parsed = { kind: 'daily' } | { kind: 'weekdays' } | { kind: 'weekly'; days: number[] } | { kind: 'monthly'; day: number };

function parseRule(rule: string): Parsed | null {
  const r = rule.trim();
  if (r === 'daily') return { kind: 'daily' };
  if (r === 'weekdays') return { kind: 'weekdays' };
  const w = /^weekly:([0-6](?:,[0-6])*)$/.exec(r);
  if (w) return { kind: 'weekly', days: [...new Set((w[1] ?? '').split(',').map(Number))].sort((a, b) => a - b) };
  const m = /^monthly:(\d{1,2})$/.exec(r);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return { kind: 'monthly', day };
  }
  return null;
}

export function isValidRule(rule: string): boolean {
  return rule === '' || parseRule(rule) !== null;
}

export function describeRepeat(rule: string): string {
  const p = parseRule(rule);
  if (!p) return '';
  switch (p.kind) {
    case 'daily':
      return '매일';
    case 'weekdays':
      return '평일';
    case 'weekly':
      return `매주 ${p.days.map((d) => KO_DAY[d]).join('·')}`;
    case 'monthly':
      return p.day >= 31 ? '매월 말일' : `매월 ${p.day}일`;
  }
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function monthlyDate(y: number, m: number, day: number): string {
  return makeDate(y, m, Math.min(day, daysInMonth(y, m))) ?? `${y}-01-01`;
}

/** from 다음(inclusive면 from 포함) 첫 발생일 */
export function nextOccurrence(rule: string, from: string, inclusive = false): string | null {
  const p = parseRule(rule);
  if (!p) return null;
  const start = inclusive ? from : addDays(from, 1);
  switch (p.kind) {
    case 'daily':
      return start;
    case 'weekdays': {
      let d = start;
      while (koIndex(d) > 4) d = addDays(d, 1);
      return d;
    }
    case 'weekly': {
      for (let i = 0; i < 7; i++) {
        const d = addDays(start, i);
        if (p.days.includes(koIndex(d))) return d;
      }
      return null;
    }
    case 'monthly': {
      const [y, m] = start.split('-').map(Number) as [number, number];
      const c = monthlyDate(y, m, p.day);
      if (c >= start) return c;
      return m === 12 ? monthlyDate(y + 1, 1, p.day) : monthlyDate(y, m + 1, p.day);
    }
  }
}

/** iCalendar RRULE */
export function toRRule(rule: string): string | null {
  const p = parseRule(rule);
  if (!p) return null;
  switch (p.kind) {
    case 'daily':
      return 'FREQ=DAILY';
    case 'weekdays':
      return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
    case 'weekly':
      return `FREQ=WEEKLY;BYDAY=${p.days.map((d) => RR_DAY[d]).join(',')}`;
    case 'monthly':
      return p.day >= 31 ? 'FREQ=MONTHLY;BYMONTHDAY=-1' : `FREQ=MONTHLY;BYMONTHDAY=${p.day}`;
  }
}

export interface RepeatMatch {
  rule: string;
  index: number;
  length: number;
}

// 요일 글자 뒤에는 요일·구분자·공백·끝만 올 수 있다 ('매주 월간 리포트'의 '월'은 요일이 아님)
const DAY_SEQ = '((?:[월화수목금토일](?:요일)?(?=[\\s,·/월화수목금토일]|$|마다)[\\s,·/]*)*)';

const PATTERNS: Array<{ re: RegExp; rule: (m: RegExpExecArray, today: string) => string | null }> = [
  { re: /(?:매\s*일|날마다)(?:\s*마다)?/, rule: () => 'daily' },
  { re: /(?:평일\s*마다|매\s*평일|주중\s*마다)/, rule: () => 'weekdays' },
  {
    re: new RegExp(`매\\s*주\\s*${DAY_SEQ}(?:\\s*마다)?`),
    rule: (m, today) => {
      const chars = (m[1] ?? '').replace(/요일/g, '');
      const days = [...new Set([...chars].map((c) => KO_DAY.indexOf(c)).filter((i) => i >= 0))].sort((a, b) => a - b);
      return `weekly:${(days.length ? days : [koIndex(today)]).join(',')}`;
    },
  },
  {
    re: /(?:매\s*월|매\s*달)\s*(\d{1,2})\s*일(?:\s*마다)?/,
    rule: (m) => {
      const d = Number(m[1]);
      return d >= 1 && d <= 31 ? `monthly:${d}` : null;
    },
  },
  { re: /(?:매\s*월|매\s*달)\s*(?:말일?|마지막\s*날)/, rule: () => 'monthly:31' },
  { re: /(?:매\s*월|매\s*달)(?:\s*마다)?/, rule: (_m, today) => `monthly:${Number(today.slice(8, 10))}` },
];

export function findRepeat(text: string, today: string): RepeatMatch | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const rule = p.rule(m, today);
    if (rule) return { rule, index: m.index, length: m[0].length };
  }
  return null;
}

const ENGLISH: Record<string, (today: string) => string> = {
  daily: () => 'daily',
  weekdays: () => 'weekdays',
  weekly: (today) => `weekly:${koIndex(today)}`,
  monthly: (today) => `monthly:${Number(today.slice(8, 10))}`,
};

/** 도구·폼 입력('매주 월', 'weekly:0', '매월 10일', '없음')을 규칙으로 */
export function normalizeRepeat(input: string, today: string): string {
  const s = input.trim();
  if (!s || /^(없음|안\s*함|none|off|null|no)$/i.test(s)) return '';
  if (isValidRule(s)) return s;
  const en = ENGLISH[s.toLowerCase()];
  if (en) return en(today);
  const m = findRepeat(s, today);
  if (m) return m.rule;
  throw new UserError(`반복 규칙을 이해하지 못했어요: '${s}'. 예: 매일, 평일마다, 매주 월·수, 매월 10일`);
}
