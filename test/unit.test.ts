import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw } from '../src/lib/html.ts';
import { findDate, parseDateExpr, parseQuickAdd } from '../src/domain/quickadd.ts';
import { parseMemos } from '../src/domain/capture.ts';
import { notionBlocksToMarkdown, parseNotionId, type NotionBlock } from '../src/domain/imports.ts';
import { isAllowedRedirectUri } from '../src/auth/oauth.ts';
import { validateArgs } from '../src/mcp/schema.ts';
import { safeLocalPath } from '../src/lib/http.ts';

const TODAY = '2026-09-30'; // 수요일

test('html 템플릿은 값을 이스케이프한다', () => {
  const evil = '<script>alert("x")</script>';
  assert.equal(html`<p>${evil}</p>`.value, '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>');
  assert.equal(html`<p>${raw('<b>ok</b>')}</p>`.value, '<p><b>ok</b></p>');
  assert.equal(html`${[html`<i>${'a&b'}</i>`, 'c<d']}`.value, '<i>a&amp;b</i>c&lt;d');
  assert.equal(html`${null}${undefined}${false}${0}`.value, '0');
});

test('날짜 표현 해석', () => {
  const cases: Array<[string, string | null]> = [
    ['2026-10-07', '2026-10-07'],
    ['내일', '2026-10-01'],
    ['모레', '2026-10-02'],
    ['금요일', '2026-10-02'],
    ['수요일', '2026-09-30'],
    ['다음 주 월요일', '2026-10-05'],
    ['다음주 금', '2026-10-09'],
    ['이번 주', '2026-10-02'],
    ['10/3', '2026-10-03'],
    ['10월 15일', '2026-10-15'],
    ['1/5', '2027-01-05'],
    ['3일 후', '2026-10-03'],
    ['월말', '2026-09-30'],
    ['없는 날', null],
    ['13/45', null],
  ];
  for (const [input, expected] of cases) assert.equal(parseDateExpr(input, TODAY), expected, input);
});

test('빠른 추가: 프로젝트·역할·긴급·마감을 뽑아낸다', () => {
  const projects = [
    { id: 1, name: '브랜드X' },
    { id: 2, name: '앱 MVP' },
  ];
  const a = parseQuickAdd('브랜드X 로고 시안 3개 금요일까지 #디자인 !', projects, TODAY);
  assert.deepEqual(a, { title: '로고 시안 3개', projectId: 1, role: 'design', priority: 1, due_date: '2026-10-02' });

  const b = parseQuickAdd('견적서 보내기 내일', projects, TODAY);
  assert.deepEqual(b, { title: '견적서 보내기', projectId: null, role: 'ops', priority: 2, due_date: '2026-10-01' });

  const c = parseQuickAdd('@앱 로그인 API 버그 수정 10/3', projects, TODAY);
  assert.equal(c.projectId, 2);
  assert.equal(c.title, '로그인 API 버그 수정');
  assert.equal(c.role, 'dev');
  assert.equal(c.due_date, '2026-10-03');

  const d = parseQuickAdd('인스타 릴스 기획안', projects, TODAY);
  assert.equal(d.role, 'marketing');
  assert.equal(d.due_date, null);

  // 'build' 안의 ui 같은 영어 조각에 속지 않는다
  assert.equal(parseQuickAdd('rebuild script', [], TODAY).role, 'etc');
  assert.equal(findDate('금액 정리', TODAY), null);
});

test('[Hub 메모] 파서', () => {
  const text = `대화 내용이 길게 있고…
\`\`\`
[Hub 메모]
프로젝트: 브랜드X
요약: 로고 방향을 정했다.
상세페이지 구성도 논의했다.
결정: 로고는 B안 | 이유: 타깃 선호 | 대체: D3
- **결정:** 메인 컬러 네이비 (D4 대체)
할 일: 상세페이지 시안 3종 | 디자인 | 2026-10-03
할 일: 견적서 발송 내일
완료: T5, T7
위치: 시안 2까지 완료
[/Hub 메모]
\`\`\``;
  const [m, ...rest] = parseMemos(text, TODAY);
  assert.equal(rest.length, 0);
  assert.ok(m);
  assert.equal(m.project, '브랜드X');
  assert.equal(m.summary, '로고 방향을 정했다. 상세페이지 구성도 논의했다.');
  assert.deepEqual(m.decisions, [
    { content: '로고는 B안', reason: '타깃 선호', supersedes: 3 },
    { content: '메인 컬러 네이비', reason: '', supersedes: 4 },
  ]);
  assert.equal(m.tasks.length, 2);
  assert.equal(m.tasks[0]?.title, '상세페이지 시안 3종');
  assert.equal(m.tasks[0]?.role, 'design');
  assert.equal(m.tasks[0]?.due_date, '2026-10-03');
  assert.equal(m.tasks[1]?.title, '견적서 발송');
  assert.equal(m.tasks[1]?.role, 'ops');
  assert.equal(m.tasks[1]?.due_date, '2026-10-01');
  assert.deepEqual(m.done, [5, 7]);
  assert.equal(m.resume, '시안 2까지 완료');
});

test('[Hub 메모] 빈 양식(안내문 그대로)은 무시한다', () => {
  const template = `[Hub 메모]
프로젝트: 브랜드X
요약: 이번 대화 요약 2~3문장
결정: 결정 내용 | 이유: 이유 | 대체: D번호
할 일: 할 일 내용 | 역할(개발/기획/디자인/마케팅/운영) | 마감 YYYY-MM-DD
완료: T번호, T번호
위치: 어디까지 했는지 한 줄
[/Hub 메모]`;
  assert.deepEqual(parseMemos(template, TODAY), []);
  assert.deepEqual(parseMemos('메모 없음', TODAY), []);
});

test('노션 ID 추출과 블록 변환', () => {
  assert.equal(
    parseNotionId('https://www.notion.so/team/My-Page-0123456789abcdef0123456789abcdef?pvs=4'),
    '01234567-89ab-cdef-0123-456789abcdef',
  );
  assert.equal(parseNotionId('01234567-89ab-cdef-0123-456789abcdef'), '01234567-89ab-cdef-0123-456789abcdef');
  assert.equal(parseNotionId('not a page'), null);

  const t = (s: string) => [{ plain_text: s }];
  const blocks: NotionBlock[] = [
    { id: '1', type: 'heading_2', heading_2: { rich_text: t('브랜드X') } },
    { id: '2', type: 'paragraph', paragraph: { rich_text: [{ plain_text: '피그마', href: 'https://figma.com/x' }] } },
    {
      id: '3',
      type: 'bulleted_list_item',
      bulleted_list_item: { rich_text: t('로고 B안') },
      children: [{ id: '4', type: 'to_do', to_do: { rich_text: t('시안 3종'), checked: true } }],
    },
    { id: '5', type: 'numbered_list_item', numbered_list_item: { rich_text: t('하나') } },
    { id: '6', type: 'numbered_list_item', numbered_list_item: { rich_text: t('둘') } },
    { id: '7', type: 'divider', divider: {} },
    { id: '8', type: 'unsupported', unsupported: {} },
  ];
  assert.equal(
    notionBlocksToMarkdown(blocks),
    ['## 브랜드X', '[피그마](https://figma.com/x)', '- 로고 B안', '  - [x] 시안 3종', '1. 하나', '2. 둘', '---'].join('\n'),
  );
});

test('OAuth redirect_uri 허용 규칙', () => {
  assert.ok(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback'));
  assert.ok(isAllowedRedirectUri('http://localhost:6274/oauth/callback'));
  assert.ok(isAllowedRedirectUri('http://127.0.0.1:33418/callback'));
  assert.ok(isAllowedRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback'));
  assert.ok(!isAllowedRedirectUri('http://evil.example.com/cb'));
  assert.ok(!isAllowedRedirectUri('javascript:alert(1)'));
  assert.ok(!isAllowedRedirectUri('https://a.example/cb#frag'));
  assert.ok(!isAllowedRedirectUri('not a url'));
});

test('도구 입력 검증: 형 변환과 필수값', () => {
  const schema = {
    type: 'object' as const,
    properties: {
      project: { type: 'string' as const },
      supersedes: { type: 'integer' as const },
      size: { type: 'string' as const, enum: ['S', 'M', 'L'] },
      tags: { type: 'array' as const, items: { type: 'integer' as const } },
    },
    required: ['project'],
  };
  assert.deepEqual(validateArgs(schema, { project: 'P1', supersedes: 'D12', size: 'm', tags: ['1', 2], extra: 'x' }), {
    project: 'P1',
    supersedes: 12,
    size: 'M',
    tags: [1, 2],
  });
  assert.throws(() => validateArgs(schema, {}), /project: 필수/);
  assert.throws(() => validateArgs(schema, { project: 'a', size: 'XL' }), /S, M, L/);
});

test('로컬 경로만 되돌아가기 허용', () => {
  assert.equal(safeLocalPath('/projects/1'), '/projects/1');
  assert.equal(safeLocalPath('//evil.com'), '/');
  assert.equal(safeLocalPath('https://evil.com'), '/');
  assert.equal(safeLocalPath('/\\evil.com'), '/');
});
