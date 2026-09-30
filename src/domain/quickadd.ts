import { addDays, isValidDate, makeDate, weekday } from '../lib/time.ts';
import { toRole, type Priority, type Role } from './types.ts';

const KO_DAYS: Record<string, number> = { 월: 0, 화: 1, 수: 2, 목: 3, 금: 4, 토: 5, 일: 6 };

function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

function monthDay(month: number, day: number, today: string, year?: number): string | null {
  const thisYear = Number(today.slice(0, 4));
  if (year) return makeDate(year, month, day);
  const d = makeDate(thisYear, month, day);
  if (!d) return null;
  // 한 달 넘게 지난 날짜면 내년으로 본다
  if (d < addDays(today, -30)) return makeDate(thisYear + 1, month, day);
  return d;
}

function lastDayOfMonth(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const firstNext = m === 12 ? makeDate(y + 1, 1, 1) : makeDate(y, m + 1, 1);
  return addDays(firstNext ?? today, -1);
}

const THIS_WEEK = '(?:이번\\s*주|금주)';
const NEXT_WEEK = '(?:다음\\s*주|담주|차주)';

interface DatePattern {
  re: RegExp;
  resolve: (m: RegExpExecArray, today: string) => string | null;
}

/** 날짜 표현 뒤에 붙는 '까지' 류 */
const SUFFIX = '(?:\\s*(?:전\\s*)?까지|\\s*안에|\\s*중으로|\\s*내로|\\s*마감)?';

const PATTERNS: DatePattern[] = [
  {
    re: new RegExp(`(\\d{4})-(\\d{1,2})-(\\d{1,2})${SUFFIX}`),
    resolve: (m) => makeDate(Number(m[1]), Number(m[2]), Number(m[3])),
  },
  {
    re: new RegExp(`(?:(\\d{4})년\\s*)?(\\d{1,2})월\\s*(\\d{1,2})일${SUFFIX}`),
    resolve: (m, today) => monthDay(Number(m[2]), Number(m[3]), today, m[1] ? Number(m[1]) : undefined),
  },
  {
    re: new RegExp(`(?<![\\d/])(\\d{1,2})/(\\d{1,2})(?![\\d/])${SUFFIX}`),
    resolve: (m, today) => monthDay(Number(m[1]), Number(m[2]), today),
  },
  {
    re: new RegExp(`(\\d{1,3})\\s*일\\s*(?:후|뒤)${SUFFIX}`),
    resolve: (m, today) => addDays(today, Number(m[1])),
  },
  {
    re: new RegExp(`(${THIS_WEEK}|${NEXT_WEEK})\\s*([월화수목금토일])(?:요일)?${SUFFIX}`),
    resolve: (m, today) => {
      const idx = KO_DAYS[m[2] ?? ''] ?? 4;
      const next = new RegExp(`^${NEXT_WEEK}$`).test(m[1] ?? '');
      return addDays(mondayOf(today), idx + (next ? 7 : 0));
    },
  },
  {
    re: new RegExp(`([월화수목금토일])요일${SUFFIX}`),
    resolve: (m, today) => {
      const idx = KO_DAYS[m[1] ?? ''] ?? 4;
      const cur = (weekday(today) + 6) % 7;
      return addDays(today, (idx - cur + 7) % 7);
    },
  },
  {
    re: new RegExp(`(오늘|금일|내일|모레|글피)${SUFFIX}`),
    resolve: (m, today) => {
      const map: Record<string, number> = { 오늘: 0, 금일: 0, 내일: 1, 모레: 2, 글피: 3 };
      return addDays(today, map[m[1] ?? ''] ?? 0);
    },
  },
  {
    re: new RegExp(`(${THIS_WEEK}|${NEXT_WEEK})(?:\\s*(?:중|내))?${SUFFIX}`),
    resolve: (m, today) => {
      const next = new RegExp(`^${NEXT_WEEK}$`).test(m[1] ?? '');
      const friday = addDays(mondayOf(today), 4 + (next ? 7 : 0));
      if (!next && friday < today) return addDays(mondayOf(today), 6);
      return friday;
    },
  },
  {
    re: new RegExp(`(월말|이달\\s*말|이번\\s*달\\s*말)${SUFFIX}`),
    resolve: (_m, today) => lastDayOfMonth(today),
  },
  {
    re: new RegExp(`(주말)${SUFFIX}`),
    resolve: (_m, today) => addDays(mondayOf(today), 6),
  },
];

export interface DateMatch {
  date: string;
  index: number;
  length: number;
}

export function findDate(text: string, today: string): DateMatch | null {
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (!m) continue;
    const date = p.resolve(m, today);
    if (date && isValidDate(date)) return { date, index: m.index, length: m[0].length };
  }
  return null;
}

/** 도구 입력용: 'YYYY-MM-DD' 또는 '내일', '다음 주 금요일', '10/3' 같은 표현 전체를 날짜로 */
export function parseDateExpr(input: string, today: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (isValidDate(s)) return s;
  const m = findDate(s, today);
  if (!m) return null;
  const rest = (s.slice(0, m.index) + s.slice(m.index + m.length)).trim();
  return rest === '' ? m.date : null;
}

const ROLE_KEYWORDS: Array<[Role, RegExp]> = [
  ['ops', /견적|계산서|세금|미팅|정산|계약|입금|청구|회신|일정\s*조율/i],
  ['marketing', /마케팅|광고|콘텐츠|컨텐츠|인스타|블로그|캠페인|카피|뉴스레터|유튜브|릴스|홍보|\bsns\b|\bseo\b/i],
  ['design', /디자인|시안|로고|배너|썸네일|피그마|목업|\bfigma\b|\bui\b|\bux\b/i],
  ['dev', /개발|버그|배포|코드|서버|퍼블리싱|프론트|백엔드|리팩터|\bapi\b|\bdb\b|\bgithub\b/i],
  ['plan', /기획|요구사항|스펙|와이어프레임|플로우|정책|시나리오|\bprd\b|\bia\b/i],
];

export function inferRole(text: string): Role {
  for (const [role, re] of ROLE_KEYWORDS) if (re.test(text)) return role;
  return 'etc';
}

export interface QuickAddResult {
  title: string;
  projectId: number | null;
  role: Role;
  priority: Priority;
  due_date: string | null;
}

function normalizeName(s: string): string {
  return s.replace(/\s+/g, '').toLowerCase();
}

function tidy(s: string): string {
  return s
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.:·\-–—]+|[\s,.:·\-–—]+$/g, '')
    .trim();
}

/** '브랜드X 로고 시안 3개 금요일까지 #디자인 !' → 구조화 */
export function parseQuickAdd(
  input: string,
  projects: Array<{ id: number; name: string }>,
  today: string,
): QuickAddResult {
  let text = ` ${input.trim()} `;
  let projectId: number | null = null;
  let role: Role | null = null;
  let priority: Priority = 2;

  // @프로젝트
  const at = /(?:^|\s)@(\S+)/.exec(text);
  if (at) {
    const key = normalizeName(at[1] ?? '');
    const found =
      projects.find((p) => normalizeName(p.name) === key) ??
      projects.find((p) => normalizeName(p.name).startsWith(key));
    if (found) {
      projectId = found.id;
      text = text.replace(at[0], ' ');
    }
  }
  // 문장 속 프로젝트 이름 (긴 이름 우선). 맨 앞에 있으면 제목에서 뺀다.
  if (projectId === null) {
    const lower = text.toLowerCase();
    const sorted = [...projects].sort((a, b) => b.name.length - a.name.length);
    for (const p of sorted) {
      const idx = lower.indexOf(p.name.toLowerCase());
      if (idx < 0) continue;
      projectId = p.id;
      if (text.slice(0, idx).trim() === '') text = ` ${text.slice(idx + p.name.length)}`;
      break;
    }
  }

  // #역할
  const tag = /(?:^|\s)#(\S+)/.exec(text);
  if (tag) {
    const r = toRole(tag[1] ?? '');
    if (r) {
      role = r;
      text = text.replace(tag[0], ' ');
    }
  }

  // ! / 긴급
  const urgent = /(?:^|\s)(!{1,3}|긴급|급함)(?=\s)/.exec(text);
  if (urgent) {
    priority = 1;
    text = text.replace(urgent[0], ' ');
  }

  // 마감
  let due: string | null = null;
  const dm = findDate(text, today);
  if (dm) {
    due = dm.date;
    text = `${text.slice(0, dm.index)} ${text.slice(dm.index + dm.length)}`;
  }

  const title = tidy(text) || input.trim();
  return {
    title,
    projectId,
    role: role ?? inferRole(title),
    priority,
    due_date: due,
  };
}
