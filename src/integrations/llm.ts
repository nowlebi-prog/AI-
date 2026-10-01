import { AIS, type AiId } from '../domain/ais.ts';
import { UserError } from '../domain/types.ts';

/** 각 AI의 API를 호출한다 (텍스트 입력 → 텍스트 출력, 스트리밍 없음) */

/** 요즘 모델은 생각(추론) 토큰도 출력 한도에 들어가서 넉넉히 둔다. 실제로 쓴 만큼만 요금이 나온다 */
const DEFAULT_MAX_TOKENS = 16_000;

export interface LlmCall {
  ai: AiId;
  apiKey: string;
  baseUrl: string;
  model: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmResult {
  text: string;
  usage: string;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function errorMessage(body: unknown, status: number): string {
  if (isObj(body)) {
    const e = body.error;
    if (isObj(e) && typeof e.message === 'string') return e.message;
    if (typeof e === 'string') return e;
    if (typeof body.message === 'string') return body.message;
  }
  return `HTTP ${status}`;
}

/** Responses API: output_text 또는 output[].content[].text */
function responsesText(body: Obj): string {
  if (typeof body.output_text === 'string') return body.output_text;
  const out: string[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isObj(item) || !Array.isArray(item.content)) continue;
    for (const c of item.content) {
      if (isObj(c) && typeof c.text === 'string' && (c.type === 'output_text' || c.type === 'text' || c.type === undefined)) out.push(c.text);
    }
  }
  return out.join('\n');
}

function anthropicText(body: Obj): string {
  return (Array.isArray(body.content) ? body.content : [])
    .filter((c): c is Obj => isObj(c) && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

function chatText(body: Obj): string {
  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined;
  const msg = isObj(choice) ? choice.message : undefined;
  if (isObj(msg) && typeof msg.content === 'string') return msg.content;
  if (isObj(msg) && Array.isArray(msg.content)) {
    return msg.content.map((c) => (isObj(c) && typeof c.text === 'string' ? c.text : '')).join('');
  }
  return '';
}

function usageOf(body: Obj): string {
  const u = body.usage;
  if (!isObj(u)) return '';
  const input = u.input_tokens ?? u.prompt_tokens;
  const output = u.output_tokens ?? u.completion_tokens;
  return typeof input === 'number' && typeof output === 'number' ? `입력 ${input.toLocaleString()} · 출력 ${output.toLocaleString()} 토큰` : '';
}

export async function callLlm(c: LlmCall, fetchImpl: FetchLike = fetch as unknown as FetchLike): Promise<LlmResult> {
  const info = AIS[c.ai];
  const base = c.baseUrl.replace(/\/+$/, '');
  let url: string;
  let headers: Record<string, string>;
  let payload: Obj;
  switch (info.protocol) {
    case 'responses':
      url = `${base}/responses`;
      headers = { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };
      payload = { model: c.model, instructions: c.system, input: c.prompt, max_output_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS };
      break;
    case 'anthropic':
      url = `${base}/messages`;
      headers = { 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
      payload = { model: c.model, max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS, system: c.system, messages: [{ role: 'user', content: c.prompt }] };
      break;
    case 'chat':
      url = `${base}/chat/completions`;
      headers = { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json' };
      payload = {
        model: c.model,
        max_tokens: c.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: [
          { role: 'system', content: c.system },
          { role: 'user', content: c.prompt },
        ],
      };
      break;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs ?? 240_000);
  let status = 0;
  let raw = '';
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    status = res.status;
    raw = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new UserError(`${info.label} API 응답을 읽지 못했어요 (HTTP ${status})`);
    }
    if (!res.ok) throw new UserError(`${info.label} API 오류: ${errorMessage(body, status)}`);
    if (!isObj(body)) throw new UserError(`${info.label} API 응답 형식이 달라요`);
    const text = info.protocol === 'responses' ? responsesText(body) : info.protocol === 'anthropic' ? anthropicText(body) : chatText(body);
    if (!text.trim()) throw new UserError(`${info.label}가 빈 응답을 보냈어요`);
    return { text, usage: usageOf(body) };
  } catch (err) {
    if (err instanceof UserError) throw err;
    if (err instanceof Error && err.name === 'AbortError') throw new UserError(`${info.label} 응답이 너무 오래 걸려서 멈췄어요`);
    throw new UserError(`${info.label} API에 연결하지 못했어요: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}
