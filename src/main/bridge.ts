import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeEntry } from '@catzoid/mcatzp-host';

/**
 * DialCatz's own bridge.json (Catzoid ecosystem): the `mcatzp` entry, so MCatzP finds the channel, and `mocks` (#94),
 * the mock servers running now, so DevCatz can give each a domain of its own. Written in DialCatz's data folder (folder
 * 0700, file 0600, atomically) whenever either changes; Uninstall removes it with the folder. Without a file MCatzP
 * says DialCatz is not installed, without an entry that it needs updating.
 */
export const bridgeFile = () => process.env.DIALCATZ_BRIDGE_FILE || join(app.getPath('userData'), 'bridge.json');

/** A running mock server in bridge.json (#94). `slug`: a name fit for a host name ("shop-api"). */
export interface BridgeMock {
  name: string;
  slug: string;
  workspaceId: string;
  collectionId: string;
  url: string;
  port: number;
  startedAt: number;
  /** From a DevCatz site's spec file: the site's id and the file's path in it, as DevCatz sent it (forward slashes). */
  siteId?: string;
  specFile?: string;
}

let mcatzpEntry: BridgeEntry | undefined;
let mockEntries: BridgeMock[] = [];

function write(): void {
  try {
    const file = bridgeFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else chmodSync(dir, 0o700);
    const doc = { schema: 1, app: 'DialCatz', version: app.getVersion(), updatedAt: Date.now(), ...(mcatzpEntry ? { mcatzp: mcatzpEntry } : {}), mocks: mockEntries };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    console.warn('bridge.json could not be written:', (e as Error).message);
  }
}

export function setBridgeMcatzp(mcatzp: BridgeEntry): void {
  mcatzpEntry = mcatzp;
  write();
}

export function setBridgeMocks(mocks: BridgeMock[]): void {
  mockEntries = mocks;
  write();
}
