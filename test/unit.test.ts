import test from 'node:test';
import assert from 'node:assert/strict';
import { html, raw } from '../src/lib/html.ts';
import { findDate, parseDateExpr, parseQuickAdd } from '../src/domain/quickadd.ts';
import { parseMemos } from '../src/domain/capture.ts';
import { notionBlocksToMarkdown, parseNotionId, type NotionBlock } from '../src/domain/imports.ts';
import { isAllowedRedirectUri } from '../src/auth/oauth.ts';
import { validateArgs } from '../src/mcp/schema.ts';
import { safeLocalPath } from '../src/lib/http.ts';
import { describeRepeat, findRepeat, nextOccurrence, normalizeRepeat, toRRule } from '../src/domain/repeat.ts';
import { foldLine, icsEscape } from '../src/domain/calendar.ts';
import { iconPng } from '../src/lib/png.ts';
import { classifyRules, parseJevResponse, jevRequest } from '../src/domain/router.ts';
import { normalizeUrl, suggestCategory, normalizeTags } from '../src/domain/references.ts';
import { decodeEntities, isPrivateHost, parseMeta } from '../src/integrations/pagemeta.ts';

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

test('빠른 추가: 프로젝트·분야·긴급·마감·반복을 뽑아낸다', () => {
  const projects = [
    { id: 1, name: '브랜드X' },
    { id: 2, name: '앱 MVP' },
  ];
  assert.deepEqual(parseQuickAdd('브랜드X 로고 시안 3개 금요일까지 #디자인 !', projects, TODAY), {
    title: '로고 시안 3개',
    projectId: 1,
    role: 'design',
    priority: 1,
    due_date: '2026-10-02',
    repeat: '',
  });
  assert.deepEqual(parseQuickAdd('견적서 보내기 내일', projects, TODAY), {
    title: '견적서 보내기',
    projectId: null,
    role: 'ops',
    priority: 2,
    due_date: '2026-10-01',
    repeat: '',
  });
  const c = parseQuickAdd('@앱 로그인 API 버그 수정 10/3', projects, TODAY);
  assert.equal(c.projectId, 2);
  assert.equal(c.title, '로그인 API 버그 수정');
  assert.equal(c.role, 'dev');
  assert.equal(c.due_date, '2026-10-03');
  assert.equal(parseQuickAdd('인스타 릴스 기획안', projects, TODAY).role, 'marketing');
  assert.equal(parseQuickAdd('IR PPT 장표 정리', projects, TODAY).role, 'docs');
  assert.equal(parseQuickAdd('rebuild script', [], TODAY).role, 'etc');
  assert.equal(findDate('금액 정리', TODAY), null);

  const weekly = parseQuickAdd('매주 월요일 주간 리포트 #마케팅', projects, TODAY);
  assert.deepEqual([weekly.title, weekly.repeat, weekly.due_date, weekly.role], ['주간 리포트', 'weekly:0', '2026-10-05', 'marketing']);
  const monthly = parseQuickAdd('매월 10일 세금계산서 발행', projects, TODAY);
  assert.deepEqual([monthly.title, monthly.repeat, monthly.due_date, monthly.role], ['세금계산서 발행', 'monthly:10', '2026-10-10', 'ops']);
  const notDay = parseQuickAdd('매주 월간 리포트 검토', [], TODAY);
  assert.equal(notDay.title, '월간 리포트 검토');
  assert.equal(notDay.repeat, 'weekly:2'); // 요일이 없으면 오늘 요일(수)
});

test('반복 규칙', () => {
  assert.equal(describeRepeat('weekly:0,2,4'), '매주 월·수·금');
  assert.equal(describeRepeat('monthly:31'), '매월 말일');
  assert.equal(nextOccurrence('daily', TODAY), '2026-10-01');
  assert.equal(nextOccurrence('weekdays', '2026-10-02'), '2026-10-05'); // 금 → 월
  assert.equal(nextOccurrence('weekly:0,3', TODAY), '2026-10-01'); // 수 다음 → 목
  assert.equal(nextOccurrence('monthly:31', '2026-02-01', true), '2026-02-28');
  assert.equal(nextOccurrence('monthly:10', '2026-10-10'), '2026-11-10');
  assert.equal(nextOccurrence('monthly:5', '2026-12-20'), '2027-01-05');
  assert.equal(toRRule('weekdays'), 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR');
  assert.equal(toRRule('monthly:31'), 'FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.equal(normalizeRepeat('매주 화·목', TODAY), 'weekly:1,3');
  assert.equal(normalizeRepeat('weekly', TODAY), 'weekly:2');
  assert.equal(normalizeRepeat('없음', TODAY), '');
  assert.equal(findRepeat('평일마다 스탠드업', TODAY)?.rule, 'weekdays');
  assert.throws(() => normalizeRepeat('가끔', TODAY), /반복 규칙/);
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

test('[Hub 메모] AI가 형식을 바꿔 써도 읽는다 (제목·목록·동의어·이모지)', () => {
  const text = `좋아요, 정리해 드릴게요!

## Hub 메모
**프로젝트**: 예약 앱 MVP
📝 대화 요약: 취소 정책을 24시간 전으로 정했다.
결정사항:
- 취소는 24시간 전까지 무료 — 이유: 공방 운영 부담
- 노쇼 3회면 예약 제한
다음 할 일:
1. 취소 API 설계 | 개발 | 금요일
2. 약관 문구 수정 #기획
완료한 일: T12
마지막 위치: 취소 API 스펙 초안 작성 중

도움이 되었길 바라요. 다른 것도 물어보세요!`;
  const [m] = parseMemos(text, TODAY);
  assert.ok(m);
  assert.equal(m.project, '예약 앱 MVP');
  assert.equal(m.summary, '취소 정책을 24시간 전으로 정했다.');
  assert.deepEqual(m.decisions.map((d) => [d.content, d.reason]), [
    ['취소는 24시간 전까지 무료', '공방 운영 부담'],
    ['노쇼 3회면 예약 제한', ''],
  ]);
  assert.deepEqual(m.tasks.map((t) => [t.title, t.role, t.due_date]), [
    ['취소 API 설계', 'dev', '2026-10-02'],
    ['약관 문구 수정', 'plan', null],
  ]);
  assert.deepEqual(m.done, [12]);
  assert.equal(m.resume, '취소 API 스펙 초안 작성 중'); // 빈 줄 뒤 잡담은 붙지 않음
});

test('[Hub 메모] 빈 양식(안내문 그대로)은 무시한다', () => {
  const template = `[Hub 메모]
프로젝트: 브랜드X
요약: 이번 대화 요약 2~3문장
결정: 결정 내용 | 이유: 이유 | 대체: D번호
할 일: 할 일 내용 | 역할(개발/기획/디자인/마케팅/문서·PPT/운영) | 마감 YYYY-MM-DD
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

test('캘린더(ICS): 이스케이프와 75바이트 줄 접기', () => {
  assert.equal(icsEscape('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const long = `SUMMARY:${'가'.repeat(60)}`;
  const folded = foldLine(long);
  for (const line of folded.split('\r\n')) assert.ok(Buffer.byteLength(line, 'utf8') <= 75, line);
  assert.equal(folded.replace(/\r\n /g, ''), long);
});

test('앱 아이콘 PNG', () => {
  const png = iconPng(192);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 192);
  assert.equal(png.readUInt32BE(20), 192);
});

test('AI 추천: 규칙 기반 분류', () => {
  const c = (s: string) => classifyRules(s);
  assert.equal(c('예약 앱 로그인 API 에러 원인 찾아서 코드 고쳐줘').category, 'code');
  assert.equal(c('브랜드X 런칭 인스타 카피 5개 써줘').category, 'writing');
  const r = c('요즘 비건 화장품 패키지 트렌드 조사해줘');
  assert.equal(r.category, 'research');
  assert.equal(r.needsWeb, true);
  assert.equal(c('로고 이미지 3가지 스타일로 만들어줘').category, 'image');
  assert.equal(c('다음 주 부산 KTX 예약해줘').category, 'agent');
  assert.equal(c('이 계약서 검토하고 요약해줘').category, 'analysis');
  assert.equal(c('뭐야?').category, 'quick');
});

test('AI 추천: Jev 요청 형식과 응답 해석', () => {
  const req = jevRequest('카피 써줘', 'jev-latest') as {
    questions: { category: { type: string; criteria: Record<string, string> }; complexity: { type: string; criteria: string[] }; needs_web: { type: string } };
  };
  assert.equal(req.questions.category.type, 'choice');
  assert.ok(req.questions.category.criteria.writing);
  assert.ok(req.questions.category.criteria.other, '해당 없음 선택지');
  assert.equal(req.questions.complexity.type, 'score');
  assert.equal(req.questions.complexity.criteria.length, 3);
  assert.equal(req.questions.needs_web.type, 'noul');
  // TypeSafe 문서의 응답 모양
  const a = parseJevResponse({
    model: 'jev-1.13.0',
    answers: {
      category: { type: 'choice', choice: 'code', confidence: 0.9, probabilities: { code: 0.9, writing: 0.1 } },
      needs_web: { type: 'noul', noul: 0.2 },
      complexity: { type: 'score', score: 2, confidence: 1, legend: { 0: '간단', 1: '보통', 2: '복잡' }, probabilities: { 0: 0, 1: 0, 2: 1 } },
    },
    usage: { input_tokens: 300, output_tokens: 0 },
  });
  assert.deepEqual([a?.category, a?.confidence, a?.needsWeb, a?.deep], ['code', 0.9, false, true]);
  const web = parseJevResponse({ answers: { category: { type: 'choice', choice: 'research', confidence: 0.7 }, needs_web: { type: 'noul', noul: 0.93 }, complexity: { type: 'score', score: 0.4 } } });
  assert.deepEqual([web?.category, web?.needsWeb, web?.deep], ['research', true, false]);
  // 모양이 조금씩 달라도 읽는다
  const b = parseJevResponse({ category: 'research', needs_web: 0.8, confidence: { category: 0.7 } });
  assert.deepEqual([b?.category, b?.confidence, b?.needsWeb], ['research', 0.7, true]);
  const c = parseJevResponse({ answers: { category: { probabilities: { planning: 0.6, code: 0.4 } } } });
  assert.equal(c?.category, 'planning');
  assert.equal(parseJevResponse({ answers: { category: 'other' } }), null);
  assert.equal(parseJevResponse('nope'), null);
});

test('레퍼런스: 주소 정리·카테고리 추천·태그', () => {
  const a = normalizeUrl('www.Dribbble.com/shots/123?utm_source=x&b=2&a=1#top');
  assert.equal(a.url, 'https://www.dribbble.com/shots/123?b=2&a=1');
  assert.equal(a.key, 'dribbble.com/shots/123?a=1&b=2');
  assert.equal(a.site, 'dribbble.com');
  assert.throws(() => normalizeUrl('ftp://x.com/a'), /http/);
  assert.equal(suggestCategory('https://dribbble.com/shots/1'), '디자인');
  assert.equal(suggestCategory('https://github.com/vercel/next.js'), '개발');
  assert.equal(suggestCategory('https://www.instagram.com/p/abc'), '마케팅');
  assert.equal(suggestCategory('https://docs.google.com/presentation/d/1'), '문서·PPT');
  assert.equal(suggestCategory('https://example.com', '랜딩페이지 UI 레퍼런스'), '디자인');
  assert.equal(suggestCategory('https://example.com', '그냥 글'), '기타');
  assert.equal(normalizeTags('#랜딩, 컬러  #랜딩 Minimal'), '랜딩 컬러 minimal');
});

test('링크 미리보기: 메타 태그 읽기와 내부 주소 차단', () => {
  const m = parseMeta(
    `<html><head><title>기본 제목</title><meta property="og:title" content="OG &amp; 제목"><meta name="description" content="설명입니다"><meta content="/img/a.png" property="og:image"></head></html>`,
    'https://site.example/page',
  );
  assert.deepEqual(m, { title: 'OG & 제목', description: '설명입니다', image: 'https://site.example/img/a.png', siteName: '' });
  assert.equal(parseMeta('<title> 그냥  제목 </title>', 'https://x.example').title, '그냥 제목');
  assert.equal(decodeEntities('&#54620;&#xAE00; &lt;b&gt;'), '한글 <b>');
  for (const h of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.10', '172.20.1.1', '169.254.1.1', '[::1]']) assert.ok(isPrivateHost(h), h);
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1']) assert.ok(!isPrivateHost(h), h);
});
