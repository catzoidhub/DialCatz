import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BridgeEntry } from '@catzoid/mcatzp-host';

/**
 * DialCatz's own bridge.json (Catzoid ecosystem): for now only the `mcatzp` entry, so MCatzP finds the channel. Written
 * in DialCatz's data folder (folder 0700, file 0600, atomically) whenever the switch moves; Uninstall removes it with
 * the folder. Without a file MCatzP says DialCatz is not installed, without an entry that it needs updating.
 */
export const bridgeFile = () => process.env.DIALCATZ_BRIDGE_FILE || join(app.getPath('userData'), 'bridge.json');

export function setBridgeMcatzp(mcatzp: BridgeEntry): void {
  try {
    const file = bridgeFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    else chmodSync(dir, 0o700);
    const doc = { schema: 1, app: 'DialCatz', version: app.getVersion(), updatedAt: Date.now(), mcatzp };
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    console.warn('bridge.json could not be written:', (e as Error).message);
  }
}
