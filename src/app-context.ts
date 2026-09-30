import type { Db } from './db.ts';
import type { Config } from './config.ts';
import type { LoginLimiter } from './auth/session.ts';

export interface AppCtx {
  db: Db;
  config: Config;
  secret: string;
  limiter: LoginLimiter;
  version: string;
}

export const VERSION = '0.1.0';
