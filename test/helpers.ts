import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';

export const PASSWORD = 'pw-test-1234';

export interface TestServer {
  app: App;
  base: string;
  close(): Promise<void>;
}

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'hub-test-'));
  const config = loadConfig({ HUB_PASSWORD: PASSWORD, HUB_DATA_DIR: dir, HUB_TZ: 'Asia/Seoul', ...env });
  const app = createApp(config);
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', () => resolve()));
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 쿠키를 기억하는 아주 작은 브라우저 */
export class Browser {
  readonly base: string;
  private cookies = new Map<string, string>();
  constructor(base: string) {
    this.base = base;
  }

  private remember(res: Response): void {
    for (const c of res.headers.getSetCookie()) {
      const [pair = ''] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || /Max-Age=0/i.test(c)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  private cookieHeader(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async get(path: string): Promise<Response> {
    const res = await fetch(this.base + path, { redirect: 'manual', headers: { Cookie: this.cookieHeader(), Accept: 'text/html' } });
    this.remember(res);
    return res;
  }

  async post(path: string, form: Record<string, string | string[]>, headers: Record<string, string> = {}): Promise<Response> {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(form)) {
      if (Array.isArray(v)) for (const x of v) body.append(k, x);
      else body.set(k, v);
    }
    const res = await fetch(this.base + path, {
      method: 'POST',
      redirect: 'manual',
      headers: { Cookie: this.cookieHeader(), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html', ...headers },
      body,
    });
    this.remember(res);
    return res;
  }

  async login(password = PASSWORD): Promise<Response> {
    return this.post('/login', { password, next: '/' });
  }

  /** 페이지에서 CSRF 토큰을 읽는다 */
  async csrf(path = '/'): Promise<string> {
    const html = await (await this.get(path)).text();
    const m = /name="_csrf" value="([^"]+)"/.exec(html);
    if (!m?.[1]) throw new Error('CSRF 토큰을 찾지 못했어요');
    return m[1];
  }
}

export async function mcp(base: string, token: string, body: unknown): Promise<{ status: number; json: any; headers: Headers }> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
}

let rpcId = 1;
export async function callTool(base: string, token: string, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean; raw: any }> {
  const r = await mcp(base, token, { jsonrpc: '2.0', id: rpcId++, method: 'tools/call', params: { name, arguments: args } });
  if (r.json.error) throw new Error(`RPC error ${r.json.error.code}: ${r.json.error.message}`);
  return { text: r.json.result.content[0].text, isError: Boolean(r.json.result.isError), raw: r.json };
}
