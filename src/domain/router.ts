import type { Db } from '../db.ts';
import type { AiKeys } from '../config.ts';
import { AIS, CATEGORIES, CATEGORY_IDS, getRoutes, type AiId, type CategoryId } from './ais.ts';

/**
 * 요청 → 어떤 AI·모델로 할지 추천.
 * TYPESAFE_API_KEY가 있으면 Jev(판단 모델)로 분류하고, 없거나 실패하면 규칙으로 분류한다.
 */

export interface Target {
  ai: AiId;
  model: string;
  why: string;
}

export interface RoutePlan {
  category: CategoryId;
  confidence: number;
  router: 'jev' | 'rules';
  needsWeb: boolean;
  deep: boolean;
  probabilities?: Record<string, number>;
  primary: Target;
  alternatives: Target[];
  notes: string[];
}

interface Signals {
  category: CategoryId;
  confidence: number;
  needsWeb: boolean;
  deep: boolean;
  probabilities?: Record<string, number>;
}

// ─── 규칙 기반 ────────────────────────────────────────────────────

const KEYWORDS: Record<CategoryId, RegExp> = {
  code: /코드|코딩|개발|버그|에러|오류|디버그|디버깅|리팩터|함수|쿼리|\bapi\b|\bsql\b|배포|서버|타입스크립트|typescript|javascript|python|파이썬|react|next\.?js|github|깃허브|스크립트|정규식|컴포넌트|구현/gi,
  writing: /카피|문구|글\s|글을|포스트|게시물|캡션|블로그|이메일|메일|보도자료|소개글|슬로건|헤드라인|번역|교정|다듬|톤|문장|뉴스레터|상세페이지\s*문구/gi,
  research: /트렌드|최신|요즘|뉴스|조사|리서치|검색|찾아\s*줘|경쟁사|시장|사례|레퍼런스|통계|현황|실시간|트위터|\bx에서/gi,
  planning: /기획|전략|로드맵|요구사항|\bprd\b|아이디어|브레인스토밍|계획|방향|구조\s*잡|플로우|\bmvp\b|우선순위|정리해\s*줘/gi,
  analysis: /분석|요약|비교|검토|계약서|문서|보고서|데이터|엑셀|\bcsv\b|표로|리뷰해|피드백/gi,
  image: /이미지|그림|사진|로고\s*(?:만들|그려|생성)|일러스트|썸네일\s*(?:만들|생성)|배너\s*(?:만들|생성)|목업|렌더|그려\s*줘/gi,
  agent: /예약|구매|주문|신청해|양식|대신\s*(?:해|처리|작성|신청)|자동으로\s*해|결제|알아서\s*처리|폼\s*작성/gi,
  quick: /뭐야|뜻이|차이가|몇\s*(?:개|명|시)|언제야|어디야|인가요\?|\?$/gi,
};

const TIE_ORDER: CategoryId[] = ['agent', 'image', 'code', 'research', 'writing', 'analysis', 'planning', 'quick'];

const WEB_RE = /최신|요즘|트렌드|뉴스|오늘|이번\s*주|실시간|현재|검색|찾아\s*줘|가격|시세|20\d\d년/;
const DEEP_RE = /설계|전략|아키텍처|깊이|꼼꼼|자세히|복잡|전체적으로|리팩터|단계별|분석해/;

export function classifyRules(text: string): Signals {
  const scores = {} as Record<CategoryId, number>;
  for (const c of CATEGORY_IDS) scores[c] = (text.match(KEYWORDS[c]) ?? []).length;
  const ranked = [...CATEGORY_IDS].sort((a, b) => scores[b] - scores[a] || TIE_ORDER.indexOf(a) - TIE_ORDER.indexOf(b));
  const top = ranked[0] ?? 'quick';
  const second = ranked[1] ?? 'quick';
  const none = scores[top] === 0;
  const category: CategoryId = none ? (text.trim().length < 40 ? 'quick' : 'planning') : top;
  const margin = scores[top] - scores[second];
  return {
    category,
    confidence: none ? 0.3 : Math.min(0.85, 0.5 + 0.12 * margin + 0.05 * scores[top]),
    needsWeb: WEB_RE.test(text),
    deep: text.length > 400 || DEEP_RE.test(text),
  };
}

// ─── Jev (TypeSafe System One) ────────────────────────────────────

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const COMPLEXITY_LEVELS = ['한두 줄로 답할 간단한 일', '보통 작업', '깊이 생각하고 여러 단계를 거쳐야 하는 복잡한 일'];

/**
 * 요청 본문 (TypeSafe System One 형식)
 *   choice: criteria = { 선택지 키: 설명 } → 답 { choice, probabilities, confidence }
 *   score:  criteria = [0단계, 1단계, …]   → 답 { score(0부터 기대 단계), legend, probabilities, confidence }
 *   noul:   instructions만                → 답 { noul: 예일 확률 }
 */
export function jevRequest(text: string, model: string): Record<string, unknown> {
  const criteria: Record<string, string> = {};
  for (const c of CATEGORY_IDS) criteria[c] = CATEGORIES[c].desc;
  // '해당 없음'이 있어야 엉뚱한 요청도 억지로 분류하지 않는다
  criteria.other = '위 어디에도 맞지 않음';
  return {
    model,
    state: text.slice(0, 6000),
    questions: {
      category: { type: 'choice', instructions: '이 요청은 어떤 종류의 일인가요?', criteria },
      needs_web: { type: 'noul', instructions: '이 요청은 최신 웹 정보나 검색이 있어야 제대로 답할 수 있다' },
      complexity: { type: 'score', instructions: '이 요청은 얼마나 어렵고 깊게 생각해야 하는 일인가요?', criteria: COMPLEXITY_LEVELS },
    },
  };
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** 응답 모양이 조금 달라도 질문 id로 답을 찾는다 */
function answerOf(body: Obj, key: string): unknown {
  for (const c of [body.answers, body.results, body.output, body]) {
    if (isObj(c) && key in c) return c[key];
  }
  return undefined;
}

function sideTable(body: Obj, table: 'confidence' | 'probabilities', key: string): unknown {
  const t = body[table];
  return isObj(t) ? t[key] : undefined;
}

function numberIn(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (isObj(v)) {
    for (const k of ['noul', 'score', 'probability', 'value', 'answer', 'expected', 'p']) {
      const x = v[k];
      if (typeof x === 'number' && Number.isFinite(x)) return x;
    }
  }
  return undefined;
}

function argmax(p: Obj): string | undefined {
  let best: string | undefined;
  let bestV = -1;
  for (const [k, v] of Object.entries(p)) {
    if (typeof v === 'number' && v > bestV) {
      best = k;
      bestV = v;
    }
  }
  return best;
}

export function parseJevResponse(body: unknown): Signals | null {
  if (!isObj(body)) return null;
  const cat = answerOf(body, 'category');
  let label: string | undefined;
  let confidence: number | undefined;
  let probs: Record<string, number> | undefined;
  if (typeof cat === 'string') label = cat;
  if (isObj(cat)) {
    for (const k of ['choice', 'answer', 'value', 'selected', 'label', 'result']) {
      if (typeof cat[k] === 'string') {
        label = cat[k] as string;
        break;
      }
    }
    if (typeof cat.confidence === 'number') confidence = cat.confidence;
    const p = cat.probabilities ?? cat.distribution;
    if (isObj(p)) probs = p as Record<string, number>;
  }
  const sideConf = sideTable(body, 'confidence', 'category');
  if (confidence === undefined && typeof sideConf === 'number') confidence = sideConf;
  const sideProbs = sideTable(body, 'probabilities', 'category');
  if (!probs && isObj(sideProbs)) probs = sideProbs as Record<string, number>;
  if (!label && probs) label = argmax(probs);
  if (!label || !(CATEGORY_IDS as readonly string[]).includes(label)) return null;

  const web = numberIn(answerOf(body, 'needs_web'));
  const cx = numberIn(answerOf(body, 'complexity'));
  const n = COMPLEXITY_LEVELS.length;
  const level = cx === undefined ? undefined : cx > n - 1 ? (cx - 1) / (n - 1) : cx / (n - 1);
  const labelProb = probs?.[label];
  return {
    category: label as CategoryId,
    confidence: confidence ?? (typeof labelProb === 'number' ? labelProb : 0.6),
    needsWeb: web !== undefined ? web >= 0.5 : false,
    deep: level !== undefined ? level >= 0.6 : false,
    probabilities: probs,
  };
}

export async function classifyJev(
  text: string,
  keys: Pick<AiKeys, 'typesafe' | 'typesafeModel'>,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  baseUrl = 'https://api.typesafe.ai/v1',
): Promise<Signals | null> {
  if (!keys.typesafe) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetchImpl(`${baseUrl}/systemone`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${keys.typesafe}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jevRequest(text, keys.typesafeModel)),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return parseJevResponse(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── 추천 ─────────────────────────────────────────────────────────

export function buildPlan(db: Db, s: Signals, router: 'jev' | 'rules', notes: string[] = []): RoutePlan {
  const routes = getRoutes(db);
  const r = routes[s.category];
  const primary: Target = { ai: r.ai, model: r.model || AIS[r.ai].defaultModel, why: r.why };
  const alternatives: Target[] = [];
  const seen = new Set<string>([primary.ai]);
  const push = (t: Target) => {
    if (seen.has(t.ai)) return;
    seen.add(t.ai);
    alternatives.push(t);
  };
  push({ ai: r.alt, model: r.altModel || AIS[r.alt].defaultModel, why: '대안' });
  // 확률이 두 번째로 높은 종류의 추천도 대안으로
  if (s.probabilities) {
    const second = Object.entries(s.probabilities)
      .filter(([k]) => k !== s.category && (CATEGORY_IDS as readonly string[]).includes(k))
      .sort((a, b) => b[1] - a[1])[0];
    if (second) {
      const rr = routes[second[0] as CategoryId];
      push({ ai: rr.ai, model: rr.model || AIS[rr.ai].defaultModel, why: `${CATEGORIES[second[0] as CategoryId].label}(으)로 보면` });
    }
  }
  const out = [...notes];
  if (s.needsWeb) out.push('최신 정보가 필요해 보여요 — 웹 검색을 켜고 실행하세요');
  if (s.deep) out.push('복잡한 작업이에요 — 깊게 생각하는(Thinking) 모드를 권해요');
  if (CATEGORIES[s.category].appOnly) out.push('이 종류는 API로는 할 수 없어서 앱에서 열어 실행해요');
  return { ...s, router, primary, alternatives, notes: out };
}

export async function planRoute(db: Db, text: string, keys: AiKeys, fetchImpl?: FetchLike): Promise<RoutePlan> {
  if (keys.typesafe) {
    const jev = await classifyJev(text, keys, fetchImpl);
    if (jev) {
      const rules = classifyRules(text);
      return buildPlan(db, { ...jev, needsWeb: jev.needsWeb || rules.needsWeb }, 'jev');
    }
    return buildPlan(db, classifyRules(text), 'rules', ['Jev 호출에 실패해서 규칙으로 추천했어요']);
  }
  return buildPlan(db, classifyRules(text), 'rules');
}
