import type { Db } from '../db.ts';
import type { AuthInfo, Scope } from '../auth/tokens.ts';
import { activityReport } from '../domain/activity.ts';
import { overviewBrief, projectBrief, taskLine, clip, type BriefSize } from '../domain/brief.ts';
import { recordSession } from '../domain/capture.ts';
import { listProjects, resolveProject, type ProjectChanges } from '../domain/projects.ts';
import { propose, proposeMessage, type TaskPayload } from '../domain/proposals.ts';
import { parseDateExpr } from '../domain/quickadd.ts';
import { createReference, listReferences, suggestCategory } from '../domain/references.ts';
import { normalizeRepeat } from '../domain/repeat.ts';
import { fetchDoc, search } from '../domain/search.ts';
import { listTasks, requireTask, type TaskChanges } from '../domain/tasks.ts';
import {
  PROJECT_FIELDS,
  PROJECT_STATUS_LABEL,
  ROLES,
  ROLE_LABEL,
  UserError,
  toPriority,
  toRole,
  toTaskStatus,
  type ProjectField,
  type ProjectStatus,
  type Role,
} from '../domain/types.ts';
import { addDayFiles, cleanupPlan, grokInstruction, parseFileList } from '../domain/wrapup.ts';
import { fetchPageMeta } from '../integrations/pagemeta.ts';
import { formatAgo } from '../lib/time.ts';
import { validateArgs, type ObjectSchema } from './schema.ts';

export interface ToolContext {
  db: Db;
  auth: AuthInfo;
  baseUrl: string;
  today: string;
  tz: string;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  scope: Scope;
  inputSchema: ObjectSchema;
  run: (args: Record<string, unknown>, ctx: ToolContext) => string | Promise<string>;
}

const PROJECT_REF = { type: 'string', description: '프로젝트 이름 또는 번호 (예: "브랜드X", "P3")', maxLength: 200 } as const;
// AI가 '디자인', '긴급'처럼 한국어로 보내도 받아 준다
const ROLE_PROP = {
  type: 'string',
  enum: [...ROLES],
  description: '작업 분야: dev(개발) plan(기획) design(디자인) marketing(마케팅) docs(문서·PPT) ops(운영) etc(기타)',
  normalize: (v: string) => toRole(v),
} as const;
const PRIORITY_PROP = {
  type: 'string',
  enum: ['high', 'normal', 'low'],
  description: '우선순위',
  normalize: (v: string) => {
    const p = toPriority(v);
    return p ? ({ 1: 'high', 2: 'normal', 3: 'low' } as const)[p] : null;
  },
} as const;
const DUE_PROP = { type: 'string', description: '마감일. YYYY-MM-DD 또는 "내일", "금요일", "다음 주 월요일", "10/3" 같은 표현. "없음"이면 마감 제거', maxLength: 50 } as const;
const REPEAT_PROP = { type: 'string', description: '반복: "매일", "평일마다", "매주 월·수", "매월 10일", "매월 말일", "없음"', maxLength: 50 } as const;
const DIRECT_PROP = {
  type: 'boolean',
  description:
    '사용자가 이 대화에서 "추가해 줘", "완료 처리해 줘", "바꿔 줘"처럼 직접 시킨 변경이면 true → 바로 반영돼요. AI가 대화 내용을 보고 스스로 정리한 것이면 false(기본) → 인박스 승인 대기',
} as const;

function parseDue(v: unknown, today: string): string | null | undefined {
  if (v === undefined) return undefined;
  const s = String(v).trim();
  if (!s || /^(없음|none|null)$/i.test(s)) return null;
  const d = parseDateExpr(s, today);
  if (!d) throw new UserError(`마감일을 이해하지 못했어요: '${s}'. YYYY-MM-DD 형식으로 알려 주세요.`);
  return d;
}

export const TOOLS: ToolDef[] = [
  {
    name: 'list_projects',
    title: '프로젝트 목록',
    description: 'Hub에 등록된 프로젝트 목록을 봅니다. 대화 주제가 어느 프로젝트인지 모를 때 먼저 호출하세요.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['active', 'all'], description: 'active(진행 중만, 기본값) 또는 all' } },
    },
    run(args, ctx) {
      const all = listProjects(ctx.db, 'all');
      const list = args.status === 'all' ? all : all.filter((p) => p.status === 'active');
      if (!list.length) return all.length ? '진행 중인 프로젝트가 없어요. status="all"로 전체를 볼 수 있어요.' : '등록된 프로젝트가 없어요.';
      return list
        .map((p) => {
          const bits = [`[P${p.id}] ${p.name}`];
          if (p.status !== 'active') bits.push(PROJECT_STATUS_LABEL[p.status]);
          const kind = toRole(p.kind);
          if (kind && kind !== 'etc') bits.push(`분야: ${ROLE_LABEL[kind]}`);
          if (p.summary) bits.push(clip(p.summary, 80));
          if (p.stage) bits.push(`단계: ${p.stage}`);
          bits.push(`열린 할 일 ${p.open_tasks}`, `최근 활동 ${formatAgo(p.last_activity)}`);
          return `- ${bits.join(' · ')}`;
        })
        .join('\n');
    },
  },
  {
    name: 'get_brief',
    title: '브리핑 받기',
    description:
      '프로젝트의 최신 맥락(프로젝트 카드, 마지막 위치, 유효한 결정, 열린 할 일, 최근 세션)을 마크다운으로 받습니다. ' +
      '새 대화에서 프로젝트 이야기를 시작하면 가장 먼저 호출하세요. project를 비우면 전체 요약(진행 중인 프로젝트, 오늘 챙길 것)을 줍니다.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_REF,
        size: { type: 'string', enum: ['S', 'M', 'L'], description: 'S(짧게) / M(기본) / L(자세히, 레퍼런스 포함)' },
      },
    },
    run(args, ctx) {
      const size = (args.size as BriefSize | undefined) ?? 'M';
      const opts = { size, mode: 'mcp' as const, today: ctx.today, tz: ctx.tz };
      if (args.project === undefined || String(args.project).trim() === '') return overviewBrief(ctx.db, opts);
      const p = resolveProject(ctx.db, args.project);
      return projectBrief(ctx.db, p.id, opts);
    },
  },
  {
    name: 'list_tasks',
    title: '할 일 조회',
    description: '할 일을 조건별로 조회합니다. 기본값은 진행 중인 프로젝트의 열린 할 일(완료 제외)이에요.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_REF,
        status: { type: 'string', enum: ['open', 'todo', 'doing', 'waiting', 'done', 'all'], description: 'open(완료 제외, 기본값), waiting(대기 중)' },
        role: ROLE_PROP,
        due: { type: 'string', enum: ['today', 'overdue', 'week'], description: '오늘 마감 / 지난 마감 / 7일 이내' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
    run(args, ctx) {
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : undefined;
      const tasks = listTasks(ctx.db, {
        projectId,
        status: (args.status as 'open' | undefined) ?? 'open',
        role: args.role as Role | undefined,
        due: args.due as 'today' | undefined,
        today: ctx.today,
        limit: (args.limit as number | undefined) ?? 50,
      });
      if (!tasks.length) return '조건에 맞는 할 일이 없어요.';
      return tasks.map((t) => taskLine(t, ctx.today, projectId === undefined)).join('\n');
    },
  },
  {
    name: 'recent_activity',
    title: '최근 활동',
    description: '최근 N일 동안 완료한 할 일, 새 결정, 새 할 일, AI 세션을 모아 봅니다. "이번 주에 뭐 했지?", 주간 리뷰, 다른 AI와 한 작업 이어받기에 쓰세요.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 60, description: '기본 7일' }, project: PROJECT_REF },
    },
    run(args, ctx) {
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : undefined;
      return activityReport(ctx.db, { days: (args.days as number | undefined) ?? 7, projectId });
    },
  },
  {
    name: 'search',
    title: '검색',
    description:
      'Hub 전체(프로젝트, 결정, 할 일, 세션 기록, 레퍼런스 링크, 가져온 문서)를 키워드로 검색합니다. 결과의 id로 fetch를 호출하면 전체 내용을 볼 수 있어요.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '검색어 (띄어쓰기로 여러 개)', maxLength: 200 } },
      required: ['query'],
    },
    run(args, ctx) {
      const hits = search(ctx.db, String(args.query), ctx.baseUrl);
      return JSON.stringify({ results: hits.map((h) => ({ id: h.id, title: h.title, url: h.url, text: h.text })) });
    },
  },
  {
    name: 'fetch',
    title: '항목 전체 보기',
    description:
      'search 결과나 브리핑에 나온 항목의 전체 내용을 가져옵니다. id 예: "project:1", "decision:12", "task:5", "log:7", "ref:3", "import:2" (또는 P1, D12, T5, R3).',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '항목 ID', maxLength: 50 } },
      required: ['id'],
    },
    run(args, ctx) {
      return JSON.stringify(fetchDoc(ctx.db, String(args.id), ctx));
    },
  },
  {
    name: 'find_references',
    title: '레퍼런스 찾기',
    description: '저장해 둔 레퍼런스 링크를 찾습니다. "그때 본 그 사이트 어디였지?"처럼 기억나는 단어, 카테고리(디자인·개발·마케팅·기획·문서·PPT 등), 프로젝트로 찾을 수 있어요.',
    scope: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '기억나는 단어 (제목·메모·태그·주소)', maxLength: 200 },
        category: { type: 'string', description: '카테고리', maxLength: 30 },
        project: PROJECT_REF,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
    run(args, ctx) {
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : undefined;
      const refs = listReferences(ctx.db, {
        q: args.query as string | undefined,
        category: args.category as string | undefined,
        projectId,
        limit: (args.limit as number | undefined) ?? 15,
      });
      if (!refs.length) return '찾는 레퍼런스가 없어요.';
      return refs
        .map((r) => {
          const bits = [`[R${r.id}] ${r.title || r.site}`, r.category, r.url];
          if (r.tags) bits.push(r.tags.split(' ').map((t) => `#${t}`).join(' '));
          if (r.project_name) bits.push(`P${r.project_id} ${r.project_name}`);
          if (r.note) bits.push(`메모: ${clip(r.note, 100)}`);
          return `- ${bits.join(' · ')}`;
        })
        .join('\n');
    },
  },
  {
    name: 'save_reference',
    title: '레퍼런스 저장',
    description: '링크를 Hub 레퍼런스에 저장합니다(바로 반영). 제목·설명은 자동으로 가져오고 카테고리는 비우면 추천해요. 같은 링크가 있으면 새로 만들지 않아요.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '링크', maxLength: 2000 },
        title: { type: 'string', description: '제목 (비우면 페이지에서 가져옴)', maxLength: 300 },
        category: { type: 'string', description: '카테고리 (디자인, 개발, 마케팅, 기획, 문서·PPT, 영감, 도구, 기타 또는 자유롭게)', maxLength: 30 },
        tags: { type: 'string', description: '태그 (띄어쓰기로 구분)', maxLength: 300 },
        note: { type: 'string', description: '왜 저장하는지, 어디에 쓸지', maxLength: 4000 },
        project: PROJECT_REF,
      },
      required: ['url'],
    },
    async run(args, ctx) {
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : null;
      const url = String(args.url);
      const meta = await fetchPageMeta(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      const title = (args.title as string | undefined) || meta?.title || '';
      const { ref, created } = createReference(
        ctx.db,
        {
          url,
          title,
          description: meta?.description ?? '',
          image_url: meta?.image ?? '',
          category: (args.category as string | undefined) || suggestCategory(url, title),
          tags: args.tags as string | undefined,
          note: args.note as string | undefined,
          project_id: projectId,
        },
        ctx.auth.source,
      );
      return created
        ? `레퍼런스에 저장했어요: [R${ref.id}] ${ref.title || ref.site} (${ref.category})`
        : `이미 저장된 링크예요: [R${ref.id}] ${ref.title || ref.site} (${ref.category}) — 비어 있던 정보만 채웠어요`;
    },
  },
  {
    name: 'get_file_cleanup',
    title: '파일 정리 목록',
    description:
      '하루 마감에서 사용자가 고른 파일 정리 목록(삭제할 파일·남길 파일)을 받습니다. 파일을 지우기 전에 반드시 목록을 사용자에게 보여 주고 확인을 받으세요. 삭제할 파일만 휴지통으로 옮기고, 남길 파일은 건드리지 마세요.',
    scope: 'read',
    inputSchema: { type: 'object', properties: { day: { type: 'string', description: 'YYYY-MM-DD (기본: 오늘)', maxLength: 10 } } },
    run(args, ctx) {
      const day = typeof args.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.day) ? args.day : ctx.today;
      const plan = cleanupPlan(ctx.db, day);
      if (!plan.total) {
        return `${day}에 정리할 파일 목록이 없어요. 사용자가 Hub의 하루 마감 화면에서 파일 목록을 올리고 남길 파일을 골라야 해요.`;
      }
      if (!plan.decided) return '사용자가 아직 남길 파일을 다 고르지 않았어요. Hub 하루 마감 화면에서 "정리 목록 만들기"를 누르면 준비돼요.';
      return grokInstruction(plan);
    },
  },
  {
    name: 'submit_files',
    title: '오늘 파일 목록 보내기',
    description:
      '오늘 새로 생기거나 바뀐 파일 경로 목록을 Hub 하루 마감 화면으로 보냅니다(파일은 지우지 않아요). 사용자가 Hub에서 남길 파일을 체크하면 정리 목록이 만들어져요.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: { files: { type: 'array', description: '전체 경로 목록', items: { type: 'string', maxLength: 1000 } } },
      required: ['files'],
    },
    run(args, ctx) {
      const paths = parseFileList(((args.files as string[] | undefined) ?? []).join('\n'));
      if (!paths.length) throw new UserError('파일 경로가 없어요. 전체 경로(/Users/…, C:\\… 등)로 보내 주세요');
      const r = addDayFiles(ctx.db, paths, ctx.auth.source, ctx.today);
      return `하루 마감 화면에 파일 ${r.added}개를 올렸어요 (오늘 전체 ${r.total}개). 사용자가 Hub에서 남길 파일을 체크하면 정리 목록이 만들어져요: ${ctx.baseUrl}/wrapup#files`;
    },
  },
  {
    name: 'propose_decision',
    title: '결정 제안',
    description:
      '대화에서 정해진 중요한 결정을 Hub에 제안합니다. 사용자가 인박스에서 승인하면 반영돼요(사용자가 직접 기록을 시켰으면 direct=true). ' +
      '이전 결정을 바꾸는 경우 supersedes에 그 결정 번호(D12면 12)를 넣으세요.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_REF,
        content: { type: 'string', description: '결정 내용 (한두 문장)', maxLength: 2000 },
        reason: { type: 'string', description: '이유 (선택)', maxLength: 2000 },
        supersedes: { type: 'integer', description: '대체할 이전 결정 번호 (선택)' },
        direct: DIRECT_PROP,
      },
      required: ['project', 'content'],
    },
    run(args, ctx) {
      const p = resolveProject(ctx.db, args.project);
      const content = String(args.content).trim();
      const r = propose(
        ctx.db,
        {
          kind: 'decision',
          projectId: p.id,
          payload: { content, reason: String(args.reason ?? '').trim(), supersedes: (args.supersedes as number | undefined) ?? null },
        },
        ctx.auth.source,
        { direct: args.direct === true },
      );
      return proposeMessage(r, `[${p.name}] 결정 "${clip(content, 80)}"${r.applied && r.resultId ? ` → D${r.resultId}` : ''}`);
    },
  },
  {
    name: 'propose_task',
    title: '할 일 제안',
    description:
      '새 할 일을 제안하거나(task_id 없이 title로), 기존 할 일의 완료·진행·마감·대기 등 변경을 제안합니다(task_id 포함). ' +
      '사용자가 직접 시킨 변경이면 direct=true로 바로 반영돼요. 같은 제목의 열린 할 일이 있으면 새로 만들지 않아요.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'integer', description: '변경할 기존 할 일 번호 (T5면 5). 새 할 일이면 비워 두세요.' },
        project: PROJECT_REF,
        title: { type: 'string', description: '할 일 제목', maxLength: 300 },
        role: ROLE_PROP,
        priority: PRIORITY_PROP,
        due: DUE_PROP,
        repeat: REPEAT_PROP,
        status: { type: 'string', enum: ['todo', 'doing', 'done'], description: '상태 (변경 시)', normalize: (v: string) => toTaskStatus(v) },
        waiting: { type: 'string', description: '다른 사람·일을 기다리는 중이면 무엇을 기다리는지 (예: "클라이언트 피드백"). 빈 문자열이면 대기 해제', maxLength: 200 },
        note: { type: 'string', description: '메모 (선택)', maxLength: 2000 },
        direct: DIRECT_PROP,
      },
    },
    run(args, ctx) {
      const due = parseDue(args.due, ctx.today);
      const repeat = args.repeat !== undefined ? normalizeRepeat(String(args.repeat), ctx.today) : undefined;
      const direct = { direct: args.direct === true };
      if (args.task_id !== undefined) {
        const task = requireTask(ctx.db, args.task_id as number);
        const changes: TaskChanges = {};
        if (args.title !== undefined) changes.title = String(args.title);
        if (args.role !== undefined) changes.role = toRole(args.role) ?? 'etc';
        if (args.priority !== undefined) changes.priority = toPriority(args.priority) ?? 2;
        if (due !== undefined) changes.due_date = due;
        if (repeat !== undefined) changes.repeat = repeat;
        if (args.status !== undefined) changes.status = toTaskStatus(args.status) ?? 'todo';
        if (args.waiting !== undefined) changes.waiting = String(args.waiting);
        if (args.note !== undefined) changes.note = String(args.note);
        if (args.project !== undefined) changes.project_id = resolveProject(ctx.db, args.project).id;
        if (!Object.keys(changes).length) throw new UserError('바꿀 내용을 하나 이상 넣어 주세요 (status, due, title 등)');
        const r = propose(ctx.db, { kind: 'task_update', projectId: task.project_id, payload: { task_id: task.id, changes } }, ctx.auth.source, direct);
        return proposeMessage(r, `[T${task.id}] "${clip(task.title, 60)}" 변경`);
      }
      if (args.title === undefined) throw new UserError('새 할 일이면 title이 필요해요');
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : null;
      const payload: TaskPayload = {
        title: String(args.title).trim(),
        role: toRole(args.role) ?? 'etc',
        priority: toPriority(args.priority) ?? 2,
        due_date: due ?? null,
        note: String(args.note ?? '').trim(),
        repeat: repeat ?? '',
        waiting: String(args.waiting ?? '').trim(),
      };
      const r = propose(ctx.db, { kind: 'task', projectId, payload }, ctx.auth.source, direct);
      return proposeMessage(r, `할 일 "${clip(payload.title, 60)}"${r.applied && r.resultId ? ` → T${r.resultId}` : ''}`);
    },
  },
  {
    name: 'propose_project',
    title: '프로젝트 제안',
    description:
      '새 프로젝트를 제안하거나(project 없이 name으로), 기존 프로젝트 카드 수정을 제안합니다(project 지정). 바꿀 필드만 넣으세요. ' +
      '새 프로젝트는 decisions·tasks를 함께 넣으면 한 번에 승인돼요(노션 정리에 편해요).',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        project: { ...PROJECT_REF, description: '수정할 기존 프로젝트 (새 프로젝트면 비워 두세요)' },
        name: { type: 'string', description: '프로젝트 이름 (새 프로젝트는 필수, 기존 프로젝트는 이름 변경 시)', maxLength: 80 },
        kind: { ...ROLE_PROP, description: '주 작업 분야 (dev, plan, design, marketing, docs, ops)' },
        summary: { type: 'string', description: '한 줄 소개', maxLength: 500 },
        goal: { type: 'string', description: '목표', maxLength: 2000 },
        audience: { type: 'string', description: '타깃', maxLength: 2000 },
        stage: { type: 'string', description: '현재 단계', maxLength: 500 },
        constraints: { type: 'string', description: '제약 (예산, 일정, 기술 등)', maxLength: 2000 },
        scope: { type: 'string', description: '작업 범위', maxLength: 4000 },
        links: { type: 'string', description: '관련 링크 (줄바꿈으로 구분)', maxLength: 2000 },
        status: { type: 'string', enum: ['active', 'paused', 'done'], description: '프로젝트 상태 (변경 시)' },
        decisions: {
          type: 'array',
          description: '새 프로젝트와 함께 기록할 결정들 (선택)',
          items: { type: 'object', properties: { content: { type: 'string', maxLength: 2000 }, reason: { type: 'string', maxLength: 2000 } }, required: ['content'] },
        },
        tasks: {
          type: 'array',
          description: '새 프로젝트와 함께 만들 할 일들 (선택)',
          items: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 300 }, role: ROLE_PROP, priority: PRIORITY_PROP, due: DUE_PROP, repeat: REPEAT_PROP },
            required: ['title'],
          },
        },
        direct: DIRECT_PROP,
      },
    },
    run(args, ctx) {
      const fields: Partial<Record<ProjectField, string>> = {};
      for (const f of PROJECT_FIELDS) if (args[f] !== undefined) fields[f] = String(args[f]);
      const direct = { direct: args.direct === true };
      if (args.project !== undefined) {
        if (args.decisions !== undefined || args.tasks !== undefined) {
          throw new UserError('기존 프로젝트에는 decisions·tasks를 함께 넣을 수 없어요. propose_decision, propose_task를 쓰세요.');
        }
        const p = resolveProject(ctx.db, args.project);
        const changes: ProjectChanges = { ...fields };
        if (args.name !== undefined) changes.name = String(args.name);
        if (args.status !== undefined) changes.status = args.status as ProjectStatus;
        if (args.kind !== undefined) changes.kind = String(args.kind);
        if (!Object.keys(changes).length) throw new UserError('바꿀 필드를 하나 이상 넣어 주세요');
        const r = propose(ctx.db, { kind: 'project_update', projectId: p.id, payload: { changes } }, ctx.auth.source, direct);
        return proposeMessage(r, `[P${p.id}] ${p.name} 카드 수정 (${Object.keys(changes).join(', ')})`);
      }
      if (args.name === undefined) throw new UserError('새 프로젝트면 name이 필요해요. 기존 프로젝트를 고치려면 project를 넣어 주세요.');
      const name = String(args.name).trim();
      const decisions = ((args.decisions as Array<Record<string, unknown>> | undefined) ?? []).map((d) => ({
        content: String(d.content ?? '').trim(),
        reason: String(d.reason ?? '').trim(),
      }));
      const tasks: TaskPayload[] = ((args.tasks as Array<Record<string, unknown>> | undefined) ?? []).map((t) => ({
        title: String(t.title ?? '').trim(),
        role: toRole(t.role) ?? 'etc',
        priority: toPriority(t.priority) ?? 2,
        due_date: parseDue(t.due, ctx.today) ?? null,
        note: '',
        repeat: t.repeat !== undefined ? normalizeRepeat(String(t.repeat), ctx.today) : '',
      }));
      const kind = args.kind !== undefined ? String(args.kind) : '';
      const r = propose(
        ctx.db,
        { kind: 'project', projectId: null, payload: { name, fields: { ...fields }, kind, decisions, tasks } },
        ctx.auth.source,
        direct,
      );
      const extra = [decisions.length ? `결정 ${decisions.length}` : '', tasks.length ? `할 일 ${tasks.length}` : ''].filter(Boolean).join(', ');
      return proposeMessage(r, `새 프로젝트 "${name}"${extra ? ` (${extra})` : ''}${r.applied && r.resultId ? ` → P${r.resultId}` : ''}`);
    },
  },
  {
    name: 'log_session',
    title: '세션 기록',
    description:
      '대화를 마칠 때 호출해 이번 대화를 기록합니다. summary(요약)와 resume_note(어디까지 했는지)는 바로 저장되고, ' +
      '함께 넘긴 decisions·tasks·done_task_ids는 인박스 제안으로 올라가요. 다른 AI나 새 창에서도 이 기록으로 이어서 작업할 수 있어요.',
    scope: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        project: PROJECT_REF,
        summary: { type: 'string', description: '이번 대화 요약 (2~5문장)', maxLength: 5000 },
        resume_note: { type: 'string', description: '다음에 이어서 할 지점 한 줄 (예: "시안 2까지 완료, 3번 컬러 검토 중")', maxLength: 1000 },
        decisions: {
          type: 'array',
          description: '이번 대화에서 정해진 결정들 (선택)',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string', maxLength: 2000 },
              reason: { type: 'string', maxLength: 2000 },
              supersedes: { type: 'integer' },
            },
            required: ['content'],
          },
        },
        tasks: {
          type: 'array',
          description: '새로 생긴 할 일들 (선택)',
          items: {
            type: 'object',
            properties: { title: { type: 'string', maxLength: 300 }, role: ROLE_PROP, priority: PRIORITY_PROP, due: DUE_PROP, repeat: REPEAT_PROP },
            required: ['title'],
          },
        },
        done_task_ids: { type: 'array', description: '완료된 할 일 번호들 (T5면 5)', items: { type: 'integer' } },
      },
      required: ['summary'],
    },
    run(args, ctx) {
      const projectId = args.project !== undefined ? resolveProject(ctx.db, args.project).id : null;
      const decisions = ((args.decisions as Array<Record<string, unknown>> | undefined) ?? []).map((d) => ({
        content: String(d.content ?? '').trim(),
        reason: String(d.reason ?? '').trim(),
        supersedes: (d.supersedes as number | undefined) ?? null,
      }));
      const tasks = ((args.tasks as Array<Record<string, unknown>> | undefined) ?? []).map((t) => ({
        title: String(t.title ?? '').trim(),
        role: toRole(t.role),
        priority: toPriority(t.priority),
        due_date: parseDue(t.due, ctx.today) ?? null,
        repeat: t.repeat !== undefined ? normalizeRepeat(String(t.repeat), ctx.today) : '',
      }));
      const res = recordSession(
        ctx.db,
        {
          projectId,
          summary: String(args.summary ?? ''),
          resume: String(args.resume_note ?? ''),
          decisions,
          tasks,
          doneTaskIds: (args.done_task_ids as number[] | undefined) ?? [],
        },
        ctx.auth.source,
      );
      const lines = [`세션을 기록했어요${res.logId ? ` (L${res.logId})` : ''}.`];
      if (res.resumeSaved) lines.push('마지막 위치를 저장했어요.');
      const dup = res.proposals.filter((p) => p.result.duplicate);
      const applied = res.proposals.filter((p) => p.result.applied);
      const pending = res.proposals.filter((p) => !p.result.applied && !p.result.duplicate);
      if (pending.length) lines.push(`인박스에 제안 ${pending.length}건을 올렸어요: ${pending.map((p) => p.label).join(' / ')}`);
      if (applied.length) lines.push(`자동 승인으로 ${applied.length}건 반영: ${applied.map((p) => p.label).join(' / ')}`);
      if (dup.length) lines.push(`이미 있어서 건너뜀 ${dup.length}건: ${dup.map((p) => p.label).join(' / ')}`);
      if (res.errors.length) lines.push(`처리 못 한 항목: ${res.errors.join(' / ')}`);
      return lines.join('\n');
    },
  },
];

export function toolsFor(scopes: Set<Scope>): ToolDef[] {
  return TOOLS.filter((t) => scopes.has(t.scope));
}

export async function runTool(name: string, rawArgs: unknown, ctx: ToolContext): Promise<string> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) throw new UserError(`알 수 없는 도구예요: ${name}`);
  if (!ctx.auth.scopes.has(tool.scope)) {
    throw new UserError(`이 연결에는 '${tool.scope === 'write' ? '제안' : '읽기'}' 권한이 없어요. Hub 설정에서 권한을 확인해 주세요.`);
  }
  const args = validateArgs(tool.inputSchema, rawArgs);
  return await tool.run(args, ctx);
}

export function toolListing(scopes: Set<Scope>): Array<Record<string, unknown>> {
  return toolsFor(scopes).map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations:
      t.scope === 'read'
        ? { title: t.title, readOnlyHint: true, openWorldHint: false }
        : { title: t.title, readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: t.name === 'save_reference' },
  }));
}
