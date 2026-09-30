import type { Db } from '../db.ts';
import type { AiKeys } from '../config.ts';
import { getSetting, setSetting } from './profile.ts';

/** 사용하는 AI와 기본 추천표. 모델 이름·추천은 모두 설정에서 바꿀 수 있다 (2026년 9월 기준 기본값). */

export const AI_IDS = ['chatgpt', 'claude', 'grok', 'muse'] as const;
export type AiId = (typeof AI_IDS)[number];

export function isAiId(v: unknown): v is AiId {
  return typeof v === 'string' && (AI_IDS as readonly string[]).includes(v);
}

export type ApiProtocol = 'responses' | 'anthropic' | 'chat';

export interface AiInfo {
  id: AiId;
  label: string;
  /** 새 대화를 여는 주소. {q}에 프롬프트가 들어간다. 비어 있으면 복사 후 homeUrl을 연다 */
  openUrl: string;
  homeUrl: string;
  protocol: ApiProtocol;
  keyEnv: string;
  defaultModel: string;
}

export const AIS: Record<AiId, AiInfo> = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    openUrl: 'https://chatgpt.com/?q={q}',
    homeUrl: 'https://chatgpt.com/',
    protocol: 'responses',
    keyEnv: 'OPENAI_API_KEY',
    defaultModel: 'gpt-6-sol',
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    openUrl: 'https://claude.ai/new?q={q}',
    homeUrl: 'https://claude.ai/new',
    protocol: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    defaultModel: 'claude-opus-5-5',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    openUrl: 'https://grok.com/?q={q}',
    homeUrl: 'https://grok.com/',
    protocol: 'responses',
    keyEnv: 'XAI_API_KEY',
    defaultModel: 'grok-4.7',
  },
  muse: {
    id: 'muse',
    label: 'Meta Muse',
    openUrl: '',
    homeUrl: 'https://muse.meta.ai/',
    protocol: 'chat',
    keyEnv: 'META_API_KEY',
    defaultModel: 'muse-spark-1.3',
  },
};

export const CATEGORY_IDS = ['code', 'writing', 'research', 'planning', 'analysis', 'image', 'agent', 'quick'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryInfo {
  id: CategoryId;
  label: string;
  /** 판단 모델(Jev)에 주는 설명 */
  desc: string;
  /** API로는 할 수 없고 앱에서 해야 하는 일 (이미지, 브라우저 작업) */
  appOnly: boolean;
}

export const CATEGORIES: Record<CategoryId, CategoryInfo> = {
  code: { id: 'code', label: '개발·코딩', desc: '코드 작성, 디버깅, 리팩터링, 기술 설계', appOnly: false },
  writing: { id: 'writing', label: '글·카피', desc: '마케팅 카피, SNS 글, 블로그, 이메일, 소개 문구, 번역·교정', appOnly: false },
  research: { id: 'research', label: '최신 정보·리서치', desc: '트렌드, 뉴스, 경쟁사·시장 조사처럼 최신 웹 정보가 필요한 일', appOnly: false },
  planning: { id: 'planning', label: '기획·전략', desc: '기획서, 요구사항, 로드맵, 아이디어 정리, 의사결정', appOnly: false },
  analysis: { id: 'analysis', label: '분석·긴 문서', desc: '긴 문서·계약서·데이터 분석, 요약, 비교, 검토', appOnly: false },
  image: { id: 'image', label: '이미지·디자인', desc: '이미지 생성·편집, 시안 아이디어, 디자인 피드백', appOnly: true },
  agent: { id: 'agent', label: '대신 처리', desc: '웹에서 예약·구매·양식 작성처럼 여러 단계를 대신 실행하는 일', appOnly: true },
  quick: { id: 'quick', label: '간단한 질문', desc: '짧게 답할 수 있는 간단한 질문', appOnly: false },
};

export interface Route {
  ai: AiId;
  model: string;
  alt: AiId;
  altModel: string;
  why: string;
}

export const DEFAULT_ROUTES: Record<CategoryId, Route> = {
  code: { ai: 'claude', model: 'claude-opus-5-5', alt: 'chatgpt', altModel: 'gpt-6-sol', why: '긴 코드 맥락과 리팩터링' },
  writing: { ai: 'chatgpt', model: 'gpt-6-sol', alt: 'claude', altModel: 'claude-opus-5-5', why: '톤 바꾸기, 여러 버전 뽑기' },
  research: { ai: 'grok', model: 'grok-4.7', alt: 'chatgpt', altModel: 'gpt-6-sol', why: '실시간 웹·X 검색' },
  planning: { ai: 'claude', model: 'claude-opus-5-5', alt: 'chatgpt', altModel: 'gpt-6-sol', why: '구조화된 문서, 긴 맥락 정리' },
  analysis: { ai: 'claude', model: 'claude-opus-5-5', alt: 'muse', altModel: 'muse-spark-1.3', why: '긴 문서 요약·비교' },
  image: { ai: 'chatgpt', model: 'gpt-6-sol', alt: 'grok', altModel: 'grok-4.7', why: '대화하며 이미지 생성·수정' },
  agent: { ai: 'muse', model: 'muse-spark-1.3', alt: 'chatgpt', altModel: 'gpt-6-sol', why: '앱 연결·브라우저로 여러 단계 대신 실행' },
  quick: { ai: 'chatgpt', model: 'gpt-6-luna', alt: 'claude', altModel: 'claude-opus-5-5', why: '빠른 답' },
};

export function getRoutes(db: Db): Record<CategoryId, Route> {
  const out = structuredClone(DEFAULT_ROUTES);
  try {
    const saved = JSON.parse(getSetting(db, 'routes') ?? '{}') as Record<string, Partial<Route>>;
    for (const c of CATEGORY_IDS) {
      const s = saved[c];
      if (!s) continue;
      if (isAiId(s.ai)) out[c].ai = s.ai;
      if (isAiId(s.alt)) out[c].alt = s.alt;
      if (typeof s.model === 'string') out[c].model = s.model.trim();
      if (typeof s.altModel === 'string') out[c].altModel = s.altModel.trim();
      if (typeof s.why === 'string') out[c].why = s.why.trim();
    }
  } catch {
    /* 기본값 사용 */
  }
  return out;
}

export function saveRoutes(db: Db, routes: Record<CategoryId, Route>): void {
  setSetting(db, 'routes', JSON.stringify(routes));
}

export interface AiAppSettings {
  openUrl: string;
  homeUrl: string;
  /** 'auto' | 'yes' | 'no' — Hub MCP가 연결돼 있는지 */
  mcp: 'auto' | 'yes' | 'no';
}

export function getAiApps(db: Db): Record<AiId, AiAppSettings> {
  let saved: Record<string, Partial<AiAppSettings>> = {};
  try {
    saved = JSON.parse(getSetting(db, 'ai_apps') ?? '{}') as Record<string, Partial<AiAppSettings>>;
  } catch {
    saved = {};
  }
  const out = {} as Record<AiId, AiAppSettings>;
  for (const id of AI_IDS) {
    const s = saved[id] ?? {};
    out[id] = {
      openUrl: typeof s.openUrl === 'string' ? s.openUrl.trim() : AIS[id].openUrl,
      homeUrl: typeof s.homeUrl === 'string' && s.homeUrl.trim() ? s.homeUrl.trim() : AIS[id].homeUrl,
      mcp: s.mcp === 'yes' || s.mcp === 'no' ? s.mcp : 'auto',
    };
  }
  return out;
}

export function saveAiApps(db: Db, apps: Record<AiId, AiAppSettings>): void {
  setSetting(db, 'ai_apps', JSON.stringify(apps));
}

/** 최근 30일 안에 그 AI 이름으로 MCP 호출이 있었는지 */
export function mcpSeen(db: Db, id: AiId): boolean {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const names = db.all<{ client: string }>('SELECT DISTINCT client FROM mcp_calls WHERE at >= ?', since);
  const key = id === 'chatgpt' ? /chatgpt|openai|gpt/i : id === 'claude' ? /claude|anthropic/i : id === 'grok' ? /grok|xai/i : /muse|meta/i;
  return names.some((n) => key.test(n.client));
}

export function mcpConnected(db: Db, id: AiId, apps = getAiApps(db)): boolean {
  const s = apps[id].mcp;
  return s === 'yes' || (s === 'auto' && mcpSeen(db, id));
}

export function apiKeyFor(keys: AiKeys, id: AiId): { key: string; baseUrl: string } | null {
  switch (id) {
    case 'chatgpt':
      return keys.openai ? { key: keys.openai, baseUrl: keys.openaiBaseUrl } : null;
    case 'claude':
      return keys.anthropic ? { key: keys.anthropic, baseUrl: keys.anthropicBaseUrl } : null;
    case 'grok':
      return keys.xai ? { key: keys.xai, baseUrl: keys.xaiBaseUrl } : null;
    case 'muse':
      return keys.meta && keys.metaBaseUrl ? { key: keys.meta, baseUrl: keys.metaBaseUrl } : null;
  }
}
