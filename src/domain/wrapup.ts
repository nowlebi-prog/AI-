import type { Db } from '../db.ts';
import { addDays, dateOf, formatDate, nowIso } from '../lib/time.ts';
import { currentDay, getTimezone } from './clock.ts';
import { createLog } from './decisions.ts';
import { getSetting, setSetting } from './profile.ts';
import { UserError, type Decision, type SessionLogWithProject, type TaskWithProject } from './types.ts';

/**
 * 하루 마감: 오늘 한 일 요약, 못 끝낸 일 넘기기, Hub에 저장한 것 정리,
 * 내 컴퓨터·드라이브 파일 정리(남길 것만 체크 → Grok Bot 요청문·휴지통 명령 만들기)
 */

// ─── 오늘 요약 ───────────────────────────────────────────────────

export interface DaySummary {
  day: string;
  done: TaskWithProject[];
  leftover: TaskWithProject[];
  tomorrow: TaskWithProject[];
  decisions: Array<Decision & { project_name: string }>;
  logs: SessionLogWithProject[];
  refs: Array<{ id: number; title: string; site: string; url: string; category: string; created_at: string }>;
  imports: Array<{ id: number; title: string; source: string; created_at: string }>;
  runs: Array<{ id: number; request: string; ai: string | null; status: string; created_at: string }>;
}

/** 앱 기준 '그날'의 시작·끝 (UTC ISO). 시간대가 +9면 전날 15시부터 */
function dayRangeIso(db: Db, day: string): { from: string; to: string } {
  const from = new Date(Date.parse(`${day}T00:00:00Z`) - 36 * 3_600_000).toISOString();
  const to = new Date(Date.parse(`${day}T00:00:00Z`) + 36 * 3_600_000).toISOString();
  void db;
  return { from, to };
}

function onDay<T extends Record<string, unknown>>(rows: T[], key: keyof T, day: string, tz: string): T[] {
  return rows.filter((r) => typeof r[key] === 'string' && dateOf(r[key] as string, tz) === day);
}

export function daySummary(db: Db, day: string = currentDay(db)): DaySummary {
  const tz = getTimezone(db);
  const { from, to } = dayRangeIso(db, day);
  const SELECT_T = 'SELECT t.*, p.name AS project_name FROM tasks t LEFT JOIN projects p ON p.id = t.project_id';
  const done = onDay(db.all<TaskWithProject & Record<string, unknown>>(`${SELECT_T} WHERE t.status = 'done' AND t.done_at >= ? AND t.done_at <= ? ORDER BY t.done_at`, from, to), 'done_at', day, tz);
  const leftover = db.all<TaskWithProject>(
    `${SELECT_T} WHERE t.status != 'done' AND t.waiting = '' AND t.due_date IS NOT NULL AND t.due_date <= ? AND (t.project_id IS NULL OR p.status = 'active')
     ORDER BY t.due_date, t.priority, t.id`,
    day,
  );
  const tomorrow = db.all<TaskWithProject>(
    `${SELECT_T} WHERE t.status != 'done' AND t.due_date = ? AND (t.project_id IS NULL OR p.status = 'active') ORDER BY t.priority, t.id`,
    addDays(day, 1),
  );
  const decisions = onDay(
    db.all<Decision & { project_name: string } & Record<string, unknown>>(
      'SELECT d.*, p.name AS project_name FROM decisions d JOIN projects p ON p.id = d.project_id WHERE d.created_at >= ? AND d.created_at <= ? ORDER BY d.created_at',
      from,
      to,
    ),
    'created_at',
    day,
    tz,
  );
  const logs = onDay(
    db.all<SessionLogWithProject & Record<string, unknown>>(
      'SELECT l.*, p.name AS project_name FROM session_logs l LEFT JOIN projects p ON p.id = l.project_id WHERE l.created_at >= ? AND l.created_at <= ? ORDER BY l.created_at',
      from,
      to,
    ),
    'created_at',
    day,
    tz,
  );
  const refs = onDay(
    db.all<DaySummary['refs'][number] & Record<string, unknown>>('SELECT id, title, site, url, category, created_at FROM refs WHERE created_at >= ? AND created_at <= ? ORDER BY created_at', from, to),
    'created_at',
    day,
    tz,
  );
  const imports = onDay(
    db.all<DaySummary['imports'][number] & Record<string, unknown>>('SELECT id, title, source, created_at FROM imports WHERE created_at >= ? AND created_at <= ? ORDER BY created_at', from, to),
    'created_at',
    day,
    tz,
  );
  const runs = onDay(
    db.all<DaySummary['runs'][number] & Record<string, unknown>>('SELECT id, request, ai, status, created_at FROM runs WHERE created_at >= ? AND created_at <= ? ORDER BY created_at', from, to),
    'created_at',
    day,
    tz,
  );
  return { day, done, leftover, tomorrow, decisions, logs, refs, imports, runs };
}

/** 마감 알림을 띄울 때인지: 설정한 시각이 지났고 오늘 아직 마감하지 않았으면 */
export function wrapupDue(db: Db, now: Date = new Date()): boolean {
  const setting = getSetting(db, 'wrapup_hour') ?? '18';
  if (setting === '' || setting === 'off') return false;
  const hour = Number(setting);
  if (!Number.isInteger(hour)) return false;
  if (getSetting(db, 'wrapup_done') === currentDay(db, now)) return false;
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: getTimezone(db), hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= hour || h < 5; // 자정 넘어 새벽까지는 계속 보여 준다
}

export function finishDay(db: Db, note: string, day: string = currentDay(db)): number | null {
  setSetting(db, 'wrapup_done', day);
  const text = note.trim();
  if (!text) return null;
  return createLog(db, { project_id: null, summary: `하루 마감 (${formatDate(day)}): ${text}` }, '나').id;
}

// ─── 파일 정리 ───────────────────────────────────────────────────

export interface DayFile {
  id: number;
  day: string;
  path: string;
  source: string;
  decision: '' | 'keep' | 'delete';
  created_at: string;
}

const PATH_RE = /^(?:\/|~\/|[a-zA-Z]:[\\/]|\\\\)/;

/** 붙여 넣은 목록(명령 결과, 탐색기 복사 등)에서 파일 경로만 뽑는다 */
export function parseFileList(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/^\s*(?:[-*•·]|\d+[.)]|\[[ xX]\])\s+/, '').trim();
    if (line.includes('\t')) line = line.split('\t')[0]?.trim() ?? '';
    line = line.replace(/^["'`]|["'`]$/g, '').trim();
    if (!line || !PATH_RE.test(line) || line.length > 1000) continue;
    if (!out.includes(line)) out.push(line);
    if (out.length >= 500) break;
  }
  return out;
}

export function addDayFiles(db: Db, paths: string[], source: string, day: string = currentDay(db)): { added: number; total: number } {
  let added = 0;
  db.tx(() => {
    for (const p of paths) {
      const r = db.run('INSERT OR IGNORE INTO day_files (day, path, source, created_at) VALUES (?, ?, ?, ?)', day, p, source, nowIso());
      added += r.changes;
    }
  });
  return { added, total: listDayFiles(db, day).length };
}

export function listDayFiles(db: Db, day: string = currentDay(db)): DayFile[] {
  return db.all<DayFile>('SELECT * FROM day_files WHERE day = ? ORDER BY path', day);
}

/** 체크한 것만 남기고 나머지는 삭제로 표시 */
export function decideDayFiles(db: Db, keepIds: number[], day: string = currentDay(db)): { keep: number; remove: number } {
  const files = listDayFiles(db, day);
  if (!files.length) throw new UserError('정리할 파일 목록이 없어요. 먼저 목록을 붙여 넣어 주세요');
  const keep = new Set(keepIds);
  db.tx(() => {
    for (const f of files) db.run('UPDATE day_files SET decision = ? WHERE id = ?', keep.has(f.id) ? 'keep' : 'delete', f.id);
  });
  return { keep: files.filter((f) => keep.has(f.id)).length, remove: files.filter((f) => !keep.has(f.id)).length };
}

export function clearDayFiles(db: Db, day: string = currentDay(db)): void {
  db.run('DELETE FROM day_files WHERE day = ?', day);
}

export interface CleanupPlan {
  day: string;
  total: number;
  keep: string[];
  remove: string[];
  decided: boolean;
}

export function cleanupPlan(db: Db, day: string = currentDay(db)): CleanupPlan {
  const files = listDayFiles(db, day);
  return {
    day,
    total: files.length,
    keep: files.filter((f) => f.decision === 'keep').map((f) => f.path),
    remove: files.filter((f) => f.decision === 'delete').map((f) => f.path),
    decided: files.length > 0 && files.every((f) => f.decision !== ''),
  };
}

/** Grok Bot(또는 파일에 접근할 수 있는 AI)에게 보낼 요청문 */
export function grokInstruction(plan: CleanupPlan): string {
  return [
    `오늘(${formatDate(plan.day)}) 작업 파일을 정리해 줘.`,
    '- 아래 [삭제할 파일]만 휴지통으로 옮겨 줘. 영구 삭제는 하지 마.',
    '- [남길 파일]과 목록에 없는 파일은 절대 건드리지 마.',
    '- 시작하기 전에 삭제할 파일이 실제로 있는지 확인해서 표로 보여 주고, 내가 "진행"이라고 하면 그때 실행해 줘.',
    '- 끝나면 옮긴 파일 수와 옮기지 못한 파일(이유 포함)을 알려 줘.',
    '',
    `[삭제할 파일 ${plan.remove.length}개]`,
    ...plan.remove.map((p) => `- ${p}`),
    '',
    `[남길 파일 ${plan.keep.length}개]`,
    ...(plan.keep.length ? plan.keep.map((p) => `- ${p}`) : ['- 없음']),
  ].join('\n');
}

/** Grok Bot이 Hub MCP에 연결돼 있을 때 보낼 짧은 요청 */
export const GROK_MCP_PROMPT =
  'Hub의 get_file_cleanup 도구로 오늘 파일 정리 목록을 받아서, 삭제할 파일만 휴지통으로 옮겨 줘. 실행 전에 목록을 표로 보여 주고 내가 "진행"이라고 하면 실행해 줘.';

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** '~/'로 시작하면 ~는 셸이 펼치게 따옴표 밖에 둔다 */
export function shPath(p: string): string {
  return p.startsWith('~/') ? `~/${shQuote(p.slice(2))}` : shQuote(p);
}

function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** 내 컴퓨터에서 직접 실행하는 '휴지통으로 옮기기' 명령 (복구 가능) */
export function trashScript(plan: CleanupPlan, os: 'mac' | 'windows'): string {
  if (os === 'mac') {
    return [
      `# Hub 하루 마감 (${plan.day}) — 삭제할 파일 ${plan.remove.length}개를 휴지통으로 옮겨요 (복구 가능)`,
      '# 터미널에 붙여 넣기 전에 목록을 한 번 더 확인하세요.',
      '# macOS 15 이상은 내장 trash 명령(되돌리기 가능)을 쓰고, 그 전 버전은 ~/.Trash로 옮겨요.',
      `hub_trash() { f="$1"; [ -e "$f" ] || { printf '없음: %s\\n' "$f"; return; }; if [ -x /usr/bin/trash ]; then /usr/bin/trash "$f" && printf '휴지통으로: %s\\n' "$f" || printf '옮기지 못함: %s\\n' "$f"; return; fi; b=$(basename "$f"); t="$HOME/.Trash/$b"; [ -e "$t" ] && t="$HOME/.Trash/$(date +%H%M%S)-$b"; mv -n -- "$f" "$t"; if [ -e "$f" ]; then printf '옮기지 못함: %s\\n' "$f"; else printf '휴지통으로: %s\\n' "$f"; fi; }`,
      ...plan.remove.map((p) => `hub_trash ${shPath(p)}`),
    ].join('\n');
  }
  // '~/…'는 PowerShell의 .NET 호출이 펼치지 않으니 사용자 폴더로 바꿔 준다
  const psPath = (p: string) => (/^~[\\/]/.test(p) ? `(Join-Path $env:USERPROFILE ${psQuote(p.slice(2))})` : psQuote(p));
  return [
    `# Hub 하루 마감 (${plan.day}) — 삭제할 파일 ${plan.remove.length}개를 휴지통으로 옮겨요 (복구 가능)`,
    '# PowerShell에 붙여 넣기 전에 목록을 한 번 더 확인하세요.',
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    ...plan.remove.map(
      (p) =>
        `$p = ${psPath(p)}; try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin'); Write-Host ("휴지통으로: " + $p) } catch { Write-Host ("옮기지 못함: " + $p) }`,
    ),
  ].join('\n');
}

/** 오늘 생긴 파일 목록을 뽑는 명령 (읽기만 함). 결과가 클립보드에 복사된다 */
export const LIST_COMMANDS = {
  // 수정 시각뿐 아니라 만든(받은) 시각도 본다 — 압축을 풀거나 복사한 파일은 수정 시각이 예전 그대로라서
  mac: 'find ~/Downloads ~/Desktop ~/Documents -maxdepth 3 -type f \\( -mtime -1 -o -Btime -1 \\) ! -name ".*" 2>/dev/null | pbcopy && echo "목록을 복사했어요. Hub에 붙여 넣으세요."',
  windows:
    '$d=(Get-Date).Date; Get-ChildItem "$env:USERPROFILE\\Downloads","$env:USERPROFILE\\Desktop","$env:USERPROFILE\\Documents" -File -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { ($_.LastWriteTime -ge $d -or $_.CreationTime -ge $d) -and -not $_.Name.StartsWith(".") } | ForEach-Object { $_.FullName } | Set-Clipboard; "목록을 복사했어요. Hub에 붙여 넣으세요."',
  ai: '오늘 다운로드·바탕화면·문서 폴더에 새로 생기거나 바뀐 파일 목록(전체 경로)을 뽑아서 Hub의 submit_files 도구로 보내 줘. 파일은 지우지 마.',
};

// ─── Hub에 오늘 저장한 것 정리 ──────────────────────────────────

export function deleteHubItems(db: Db, remove: { refs: number[]; imports: number[]; runs: number[] }): number {
  let n = 0;
  db.tx(() => {
    for (const id of remove.refs) n += db.run('DELETE FROM refs WHERE id = ?', id).changes;
    for (const id of remove.imports) n += db.run('DELETE FROM imports WHERE id = ?', id).changes;
    for (const id of remove.runs) n += db.run('DELETE FROM runs WHERE id = ?', id).changes;
  });
  return n;
}
