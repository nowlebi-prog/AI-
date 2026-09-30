import type { Db } from '../db.ts';
import { todayIn } from '../lib/time.ts';
import { getSetting } from './profile.ts';

/** 앱 전체에서 쓰는 '오늘'. 시간대와 하루 시작 시각(새벽 작업용)을 반영한다. */

export function getTimezone(db: Db): string {
  return getSetting(db, 'timezone') || 'Asia/Seoul';
}

/** 0~6시. 예: 4면 새벽 4시 전까지는 전날로 친다 */
export function getDayStartHour(db: Db): number {
  const n = Number(getSetting(db, 'day_start_hour') ?? '0');
  return Number.isInteger(n) && n >= 0 && n <= 6 ? n : 0;
}

export function currentDay(db: Db, now: Date = new Date()): string {
  return todayIn(getTimezone(db), new Date(now.getTime() - getDayStartHour(db) * 3_600_000));
}
