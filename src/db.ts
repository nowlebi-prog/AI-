import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Param = string | number | bigint | boolean | null | undefined | Uint8Array;

function norm(p: Param): string | number | bigint | null | Uint8Array {
  if (p === undefined) return null;
  if (typeof p === 'boolean') return p ? 1 : 0;
  return p;
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE profile (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT '',
    about TEXT NOT NULL DEFAULT '',
    preferences TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );

  CREATE TABLE projects (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done')),
    summary TEXT NOT NULL DEFAULT '',
    goal TEXT NOT NULL DEFAULT '',
    audience TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL DEFAULT '',
    constraints TEXT NOT NULL DEFAULT '',
    scope TEXT NOT NULL DEFAULT '',
    links TEXT NOT NULL DEFAULT '',
    resume_note TEXT NOT NULL DEFAULT '',
    resume_note_at TEXT,
    resume_note_source TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX projects_name_unique ON projects (name COLLATE NOCASE);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'etc' CHECK (role IN ('dev', 'plan', 'design', 'marketing', 'ops', 'etc')),
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1, 2, 3)),
    due_date TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '나',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT
  );
  CREATE INDEX tasks_project ON tasks (project_id, status);
  CREATE INDEX tasks_due ON tasks (status, due_date);

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '나',
    superseded_by INTEGER REFERENCES decisions (id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX decisions_project ON decisions (project_id, created_at);

  CREATE TABLE session_logs (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX session_logs_project ON session_logs (project_id, created_at);

  CREATE TABLE proposals (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('decision', 'task', 'task_update', 'project', 'project_update')),
    project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    payload TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    result_id INTEGER,
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );
  CREATE INDEX proposals_status ON proposals (status, created_at);

  CREATE TABLE imports (
    id INTEGER PRIMARY KEY,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    scopes TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_secret_hash TEXT,
    client_name TEXT NOT NULL,
    label TEXT,
    redirect_uris TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE oauth_codes (
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE oauth_tokens (
    id INTEGER PRIMARY KEY,
    client_id TEXT NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
    access_hash TEXT NOT NULL UNIQUE,
    refresh_hash TEXT UNIQUE,
    scopes TEXT NOT NULL,
    access_expires_at TEXT NOT NULL,
    refresh_expires_at TEXT,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE mcp_calls (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    client TEXT NOT NULL,
    method TEXT NOT NULL,
    tool TEXT,
    ok INTEGER NOT NULL,
    error TEXT,
    duration_ms INTEGER NOT NULL
  );
  `,
  // v2: 대기·반복 할 일, 작업 분야 확장(역할 제약은 코드에서 검증), 프로젝트 분야,
  //     AI 변경 기록(되돌리기), AI 실행 기록, 레퍼런스
  `
  CREATE TABLE tasks_v2 (
    id INTEGER PRIMARY KEY,
    project_id INTEGER REFERENCES projects (id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'etc',
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'done')),
    priority INTEGER NOT NULL DEFAULT 2 CHECK (priority IN (1, 2, 3)),
    due_date TEXT,
    note TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '나',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    done_at TEXT,
    waiting TEXT NOT NULL DEFAULT '',
    repeat TEXT NOT NULL DEFAULT '',
    next_task_id INTEGER
  );
  INSERT INTO tasks_v2 (id, project_id, title, role, status, priority, due_date, note, source, created_at, updated_at, done_at)
    SELECT id, project_id, title, role, status, priority, due_date, note, source, created_at, updated_at, done_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_v2 RENAME TO tasks;
  CREATE INDEX tasks_project ON tasks (project_id, status);
  CREATE INDEX tasks_due ON tasks (status, due_date);

  ALTER TABLE projects ADD COLUMN kind TEXT NOT NULL DEFAULT '';

  CREATE TABLE refs (
    id INTEGER PRIMARY KEY,
    url TEXT NOT NULL,
    url_key TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '기타',
    tags TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT '나',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX refs_category ON refs (category, created_at);

  CREATE TABLE day_files (
    id INTEGER PRIMARY KEY,
    day TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT '나',
    decision TEXT NOT NULL DEFAULT '' CHECK (decision IN ('', 'keep', 'delete')),
    created_at TEXT NOT NULL,
    UNIQUE (day, path)
  );

  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    source TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_id INTEGER,
    project_id INTEGER,
    summary TEXT NOT NULL,
    before TEXT,
    via TEXT NOT NULL,
    undone_at TEXT
  );
  CREATE INDEX activity_at ON activity (at);

  CREATE TABLE runs (
    id INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL,
    project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL,
    request TEXT NOT NULL,
    plan TEXT NOT NULL,
    ai TEXT,
    model TEXT,
    mode TEXT,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'running', 'done', 'handed_off', 'failed')),
    prompt TEXT,
    response TEXT,
    error TEXT,
    result TEXT,
    finished_at TEXT
  );
  CREATE INDEX runs_created ON runs (created_at);
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  all<T>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params.map(norm)) as T[];
  }

  get<T>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params.map(norm)) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params.map(norm));
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  private depth = 0;

  /** 트랜잭션. 중첩 호출은 바깥 트랜잭션에 합쳐진다. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.raw.exec('BEGIN IMMEDIATE');
    this.depth++;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth--;
    }
  }

  private migrate(): void {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    const current = Number(row?.user_version ?? 0);
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v] ?? '');
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  /** 일관된 스냅샷을 파일로 저장 (백업용) */
  backupTo(path: string): void {
    this.stmt('VACUUM INTO ?').run(path);
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
