import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, shell } from 'electron';
import type { DbCatzConnection, DbCatzTarget } from '@shared/types';

/**
 * DialCatz → DBCatz ("Check in DBCatz"): after a call, open the table it touched in DBCatz. DBCatz writes its own
 * bridge.json (schema 1, read-only for us): its saved connections and the DevCatz services it lists (svc:<id>),
 * without passwords. The table opens through a read-only link:
 *   dbcatz://open?conn=<id>&db=<db>&table=<table>&col=<column>&val=<value>
 * DBCatz validates it again and builds the row filter itself; nothing in the link changes data.
 * DIALCATZ_DBCATZ_DIR points at another DBCatz data folder for tests.
 */

const DATA = process.env.DIALCATZ_DBCATZ_DIR || (process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support', 'DBCatz') : join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'DBCatz'));

interface Bridge {
  schema: number;
  connections?: Partial<DbCatzConnection>[];
}

const ENGINES = ['mysql', 'mariadb', 'postgres', 'sqlite', 'redis', 'valkey', 'mongodb', 'elasticsearch'];

/** DBCatz is on this computer: it answers dbcatz:// links, or has left its data folder. */
export function installed(): boolean {
  try {
    if (app.getApplicationNameForProtocol('dbcatz://')) return true;
  } catch {
    /* not on every platform */
  }
  return existsSync(join(DATA, 'bridge.json')) || existsSync(join(DATA, 'config.json'));
}

/** The connections DBCatz shares (empty with an older DBCatz that writes no bridge.json). */
export function connections(): { bridge: boolean; connections: DbCatzConnection[] } {
  let b: Bridge | null = null;
  try {
    b = JSON.parse(readFileSync(join(DATA, 'bridge.json'), 'utf8')) as Bridge;
  } catch {
    return { bridge: false, connections: [] };
  }
  if (b?.schema !== 1 || !Array.isArray(b.connections)) return { bridge: false, connections: [] };
  const list = b.connections
    .filter((c) => typeof c?.id === 'string' && c.id && typeof c.name === 'string')
    .map((c) => ({
      id: String(c.id),
      name: String(c.name),
      engine: ENGINES.includes(String(c.engine)) ? (c.engine as DbCatzConnection['engine']) : String(c.engine) === 'postgresql' ? 'postgres' : 'mysql',
      host: typeof c.host === 'string' ? c.host : null,
      port: typeof c.port === 'number' ? c.port : null,
      database: typeof c.database === 'string' && c.database ? c.database : null,
      source: c.source === 'devcatz' ? ('devcatz' as const) : ('saved' as const),
    }))
    .sort((a, b) => (a.source === b.source ? a.name.localeCompare(b.name) : a.source === 'saved' ? -1 : 1));
  return { bridge: true, connections: list };
}

const plainText = (v: unknown, max: number) => {
  const s = String(v ?? '').trim();
  return s.length <= max && !/[\u0000-\u001f\u007f]/.test(s) ? s : '';
};

/** The dbcatz:// link for a target, every part checked. */
export function link(t: DbCatzTarget): string {
  const conn = plainText(t?.conn, 200);
  if (!/^[\w:.@-]+$/.test(conn)) throw new Error('Choose a DBCatz connection');
  const q = new URLSearchParams({ conn });
  const db = plainText(t.db, 128);
  if (db) q.set('db', db);
  const table = plainText(t.table, 128);
  if (table) q.set('table', table);
  const col = plainText(t.col, 64);
  const val = plainText(t.val, 200);
  if (table && col && val && /^[A-Za-z_][\w$]*$/.test(col)) {
    q.set('col', col);
    q.set('val', val);
  }
  return `dbcatz://open?${q.toString()}`;
}

export async function open(t: DbCatzTarget): Promise<void> {
  if (!installed()) throw new Error('DBCatz is not installed on this computer');
  await shell.openExternal(link(t));
}
