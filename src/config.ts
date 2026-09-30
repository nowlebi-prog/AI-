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
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    publicUrl: (env.HUB_PUBLIC_URL ?? '').trim().replace(/\/+$/, ''),
    dataDir: env.HUB_DATA_DIR ?? './data',
    password: env.HUB_PASSWORD ?? '',
    secret: env.HUB_SECRET ?? '',
    timezone: env.HUB_TZ ?? 'Asia/Seoul',
    notionToken: env.NOTION_TOKEN ?? '',
  };
}
