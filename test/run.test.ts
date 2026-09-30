import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestServer, type TestServer } from './helpers.ts';
import { createProject } from '../src/domain/projects.ts';
import { createTask } from '../src/domain/tasks.ts';
import { listProposals } from '../src/domain/proposals.ts';
import { listLogs } from '../src/domain/decisions.ts';
import { canUseApi, composePrompt, createRun, getRun, handoffUrl, MAX_URL_PROMPT, startApiRun } from '../src/domain/runs.ts';
import { planRoute } from '../src/domain/router.ts';
import { getAiApps, saveAiApps } from '../src/domain/ais.ts';

/** OpenAI Responses / Anthropic Messages 흉내 서버 */
let mock: Server;
let mockBase = '';
const seen: Array<{ path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }> = [];
let failNext = false;

const ANSWER = `카피 5개예요.
1. 피부에게 쉬는 시간을

[Hub 메모]
프로젝트: 브랜드X
요약: 런칭 카피 5개를 뽑았다.
결정: 메인 카피는 1번 | 이유: 짧고 기억에 남음
할 일: 카피 A/B 테스트 준비 | 마케팅 | 금요일
위치: 카피 확정, 배너 적용 전
[/Hub 메모]`;

function startMock(): Promise<void> {
  mock = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      seen.push({ path: req.url ?? '', headers: req.headers, body });
      res.setHeader('Content-Type', 'application/json');
      if (failNext) {
        failNext = false;
        res.statusCode = 401;
        res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
        return;
      }
      if (req.url === '/v1/responses') {
        res.end(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: ANSWER }] }], usage: { input_tokens: 1200, output_tokens: 300 } }));
      } else if (req.url === '/v1/messages') {
        res.end(JSON.stringify({ content: [{ type: 'text', text: '분석 결과예요. (메모 없음)' }], usage: { input_tokens: 10, output_tokens: 5 } }));
      } else {
        res.statusCode = 404;
        res.end('{}');
      }
    });
  });
  return new Promise<void>((r) =>
    mock.listen(0, '127.0.0.1', () => {
      mockBase = `http://127.0.0.1:${(mock.address() as AddressInfo).port}/v1`;
      r();
    }),
  );
}

let srv: TestServer;

before(async () => {
  await startMock();
  srv = await startTestServer({ OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: mockBase, ANTHROPIC_API_KEY: 'ak-test', ANTHROPIC_BASE_URL: mockBase });
  const p = createProject(srv.app.db, { name: '브랜드X', summary: '비건 스킨케어 리뉴얼' });
  createTask(srv.app.db, { project_id: p.id, title: '런칭 배너', role: 'design' }, '나');
});

after(async () => {
  await srv.close();
  await new Promise<void>((r) => mock.close(() => r()));
});

test('API로 실행: 브리핑을 붙여 보내고, 결과의 [Hub 메모]를 자동 반영한다', async () => {
  const keys = srv.app.ctx.config.ai;
  const id = await createRun(srv.app.db, keys, '브랜드X 런칭 인스타 카피 5개 써줘', null);
  const run = getRun(srv.app.db, id);
  assert.equal(run?.project_id, 1);
  assert.equal(JSON.parse(run?.plan ?? '{}').primary.ai, 'chatgpt');
  await startApiRun(srv.app.db, keys, id, 'chatgpt', 'gpt-6-sol');
  const done = getRun(srv.app.db, id);
  assert.equal(done?.status, 'done', done?.error ?? '');
  assert.match(done?.response ?? '', /피부에게 쉬는 시간을/);
  const req = seen.at(-1);
  assert.equal(req?.path, '/v1/responses');
  assert.equal(req?.headers.authorization, 'Bearer sk-test');
  assert.equal(req?.body.model, 'gpt-6-sol');
  assert.match(String(req?.body.input), /<hub-context>[\s\S]*# 브리핑: 브랜드X \(P1\)[\s\S]*요청: 브랜드X 런칭 인스타 카피/);
  assert.match(String(req?.body.instructions), /\[Hub 메모\]/);
  const result = JSON.parse(done?.result ?? '{}');
  assert.match(result.usage, /입력 1,200/);
  assert.ok(result.applied.some((x: string) => x.startsWith('세션 기록')));
  assert.deepEqual(result.pending.sort(), ['결정: 메인 카피는 1번', '할 일: 카피 A/B 테스트 준비']);
  assert.equal(listLogs(srv.app.db, { projectId: 1 })[0]?.source, 'ChatGPT (API)');
  assert.equal(listProposals(srv.app.db, 'pending').length, 2);
});

test('Claude API 형식과 실패 처리', async () => {
  const keys = srv.app.ctx.config.ai;
  const id = await createRun(srv.app.db, keys, '이 계약서 검토하고 요약해줘', 1);
  await startApiRun(srv.app.db, keys, id, 'claude', 'claude-opus-5-5');
  const req = seen.at(-1);
  assert.equal(req?.path, '/v1/messages');
  assert.equal(req?.headers['x-api-key'], 'ak-test');
  assert.equal(req?.headers['anthropic-version'], '2023-06-01');
  assert.equal(getRun(srv.app.db, id)?.status, 'done');

  failNext = true;
  await startApiRun(srv.app.db, keys, id, 'chatgpt', '');
  const failed = getRun(srv.app.db, id);
  assert.equal(failed?.status, 'failed');
  assert.match(failed?.error ?? '', /ChatGPT API 오류: invalid api key/);

  // 키가 없는 AI, 앱 전용 작업은 API로 실행하지 않는다
  assert.equal(canUseApi(keys, 'grok', getRun(srv.app.db, id)!).ok, false);
  const img = await createRun(srv.app.db, keys, '로고 이미지 3가지 스타일로 만들어줘', 1);
  assert.match(canUseApi(keys, 'chatgpt', getRun(srv.app.db, img)!).reason, /앱에서만/);
});

test('Jev로 추천하고, 실패하면 규칙으로 돌아간다', async () => {
  const keys = { ...srv.app.ctx.config.ai, typesafe: 'ts-test' };
  const calls: Array<Record<string, unknown>> = [];
  const ok = async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body) as Record<string, unknown>);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          category: { type: 'choice', choice: 'research', confidence: 0.83, probabilities: { research: 0.83, planning: 0.17 } },
          needs_web: { type: 'noul', noul: 0.9 },
          complexity: { type: 'score', score: 0, confidence: 0.9 },
        },
        usage: { input_tokens: 420, output_tokens: 0 },
      }),
    };
  };
  const plan = await planRoute(srv.app.db, '비건 패키지 사례 좀 모아줘', keys, ok);
  assert.equal(plan.router, 'jev');
  assert.equal(plan.category, 'research');
  assert.equal(plan.confidence, 0.83);
  assert.equal(plan.primary.ai, 'grok');
  assert.ok(plan.notes.some((n) => n.includes('웹 검색')));
  // 두 번째로 확률이 높은 종류(기획)의 추천 AI도 대안에 들어간다
  assert.ok(plan.alternatives.some((t) => t.ai === 'claude'));
  const sent = calls[0] as { model: string; questions: Record<string, { type: string; criteria?: unknown }> };
  assert.equal(sent.model, 'jev-latest');
  assert.equal(sent.questions.category?.type, 'choice');
  assert.ok(sent.questions.category?.criteria && typeof sent.questions.category.criteria === 'object');

  const broken = async () => {
    throw new Error('network down');
  };
  const fallback = await planRoute(srv.app.db, '로그인 API 에러 고쳐줘', keys, broken);
  assert.equal(fallback.router, 'rules');
  assert.equal(fallback.category, 'code');
  assert.ok(fallback.notes.some((n) => n.includes('Jev 호출에 실패')));
});

test('앱에서 열기: MCP가 연결된 AI에는 짧은 요청, 긴 프롬프트는 복사로', async () => {
  const keys = srv.app.ctx.config.ai;
  const id = await createRun(srv.app.db, keys, '브랜드X 배너 문구 다듬어줘', null);
  const run = getRun(srv.app.db, id)!;
  const full = composePrompt(srv.app.db, run, 'claude', 'app');
  assert.match(full, /<hub-context>/);
  const apps = getAiApps(srv.app.db);
  apps.claude.mcp = 'yes';
  saveAiApps(srv.app.db, apps);
  const short = composePrompt(srv.app.db, run, 'claude', 'app');
  assert.match(short, /get_brief\("브랜드X"\)/);
  assert.ok(short.length < 300);
  const h = handoffUrl(srv.app.db, 'claude', short);
  assert.ok(h.inUrl);
  assert.ok(h.url.startsWith('https://claude.ai/new?q='));
  const long = handoffUrl(srv.app.db, 'chatgpt', 'x'.repeat(MAX_URL_PROMPT + 10));
  assert.deepEqual(long, { url: 'https://chatgpt.com/', inUrl: false });
  const muse = handoffUrl(srv.app.db, 'muse', '짧은 요청');
  assert.equal(muse.inUrl, false); // Muse는 주소로 프롬프트를 못 넘겨서 복사 후 열기
});
