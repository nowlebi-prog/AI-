import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db.ts';
import { currentDay } from './domain/clock.ts';
import { setSetting } from './domain/profile.ts';
import { nowIso } from './lib/time.ts';

/** 하루 한 번 data/backups/hub-YYYY-MM-DD.db 로 백업하고 최근 7개만 남긴다 */

export const KEEP_BACKUPS = 7;
const NAME = /^hub-\d{4}-\d{2}-\d{2}\.db$/;

export function backupDir(dataDir: string): string {
  return join(dataDir, 'backups');
}

export function listBackups(dataDir: string): Array<{ name: string; size: number }> {
  const dir = backupDir(dataDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => NAME.test(n))
    .sort()
    .reverse()
    .map((name) => ({ name, size: statSync(join(dir, name)).size }));
}

export function isBackupName(name: string): boolean {
  return NAME.test(name);
}

export function runDailyBackup(db: Db, dataDir: string): string | null {
  const dir = backupDir(dataDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `hub-${currentDay(db)}.db`);
  if (existsSync(file)) return null;
  db.backupTo(file);
  setSetting(db, 'last_backup_at', nowIso());
  for (const old of listBackups(dataDir).slice(KEEP_BACKUPS)) rmSync(join(dir, old.name), { force: true });
  return file;
}
