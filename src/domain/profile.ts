import type { Db } from '../db.ts';
import { nowIso } from '../lib/time.ts';
import { PROPOSAL_KINDS, type ProposalKind } from './types.ts';

export interface Profile {
  name: string;
  about: string;
  preferences: string;
  updated_at: string | null;
}

export function getProfile(db: Db): Profile {
  const row = db.get<Profile>('SELECT name, about, preferences, updated_at FROM profile WHERE id = 1');
  return row ?? { name: '', about: '', preferences: '', updated_at: null };
}

export function saveProfile(db: Db, p: { name: string; about: string; preferences: string }): void {
  db.run(
    `INSERT INTO profile (id, name, about, preferences, updated_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET name = excluded.name, about = excluded.about,
       preferences = excluded.preferences, updated_at = excluded.updated_at`,
    p.name.trim(),
    p.about.trim(),
    p.preferences.trim(),
    nowIso(),
  );
}

export function getSetting(db: Db, key: string): string | undefined {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key,
    value,
  );
}

export function getAutoApprove(db: Db): Set<ProposalKind> {
  const raw = getSetting(db, 'auto_approve');
  if (!raw) return new Set();
  try {
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return new Set();
    return new Set(list.filter((k): k is ProposalKind => (PROPOSAL_KINDS as readonly string[]).includes(String(k))));
  } catch {
    return new Set();
  }
}

export function setAutoApprove(db: Db, kinds: ProposalKind[]): void {
  setSetting(db, 'auto_approve', JSON.stringify(kinds));
}
