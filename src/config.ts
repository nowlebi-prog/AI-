export interface AiKeys {
  openai: string;
  openaiBaseUrl: string;
  anthropic: string;
  anthropicBaseUrl: string;
  xai: string;
  xaiBaseUrl: string;
  meta: string;
  metaBaseUrl: string;
  /** TypeSafe Jev (AI 추천용 판단 모델) */
  typesafe: string;
  typesafeModel: string;
}

export interface Config {
  port: number;
  host: string;
  /** 외부 접속 주소. 비어 있으면 요청 헤더에서 추정한다. */
  publicUrl: string;
  dataDir: string;
  password: string;
  secret: string;
  timezone: string;
  notionToken: string;
  ai: AiKeys;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const trim = (v: string | undefined) => (v ?? '').trim();
  const base = (v: string | undefined, fallback: string) => (trim(v) || fallback).replace(/\/+$/, '');
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    publicUrl: trim(env.HUB_PUBLIC_URL).replace(/\/+$/, ''),
    dataDir: env.HUB_DATA_DIR ?? './data',
    password: env.HUB_PASSWORD ?? '',
    secret: env.HUB_SECRET ?? '',
    timezone: env.HUB_TZ ?? 'Asia/Seoul',
    notionToken: env.NOTION_TOKEN ?? '',
    ai: {
      openai: trim(env.OPENAI_API_KEY),
      openaiBaseUrl: base(env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
      anthropic: trim(env.ANTHROPIC_API_KEY),
      anthropicBaseUrl: base(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com/v1'),
      xai: trim(env.XAI_API_KEY),
      xaiBaseUrl: base(env.XAI_BASE_URL, 'https://api.x.ai/v1'),
      meta: trim(env.META_API_KEY),
      metaBaseUrl: base(env.META_API_BASE_URL, ''),
      typesafe: trim(env.TYPESAFE_API_KEY),
      typesafeModel: trim(env.TYPESAFE_MODEL) || 'jev-latest',
    },
  };
}
