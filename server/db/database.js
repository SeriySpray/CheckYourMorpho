import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG } from '../config.js';
import { SCHEMA_SQL } from './schema.js';

let dbInstance = null;

export function getDatabase() {
  if (dbInstance) {
    return dbInstance;
  }

  const dir = path.dirname(CONFIG.db.path);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  dbInstance = new DatabaseSync(CONFIG.db.path);
  
  // Safe migrations for newly added columns if table already existed from an older schema
  try { dbInstance.exec("ALTER TABLE vaults ADD COLUMN version TEXT DEFAULT 'v1';"); } catch {}
  try { dbInstance.exec("ALTER TABLE vaults ADD COLUMN liquidity_usd REAL DEFAULT 0;"); } catch {}
  try { dbInstance.exec("ALTER TABLE vaults ADD COLUMN is_listed INTEGER DEFAULT 0;"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN is_listed INTEGER DEFAULT 1;"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN oracle_type TEXT DEFAULT 'ChainlinkOracleV2';"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN bad_debt_usd REAL DEFAULT 0;"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN realized_bad_debt_usd REAL DEFAULT 0;"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN warnings_count INTEGER DEFAULT 0;"); } catch {}
  try { dbInstance.exec("ALTER TABLE markets ADD COLUMN warnings_json TEXT;"); } catch {}

  // Apply schema and pragmas
  dbInstance.exec(SCHEMA_SQL);

  return dbInstance;
}

export function closeDatabase() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
