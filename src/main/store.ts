import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DialCatz's settings: one JSON file in the app's data folder, written
 * atomically. Secrets inside are safeStorage-encrypted by their owners.
 */

export function dataDir(...parts: string[]): string {
  const dir = app.getPath('userData');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const out = join(dir, ...parts);
  if (parts.length && !existsSync(out) && !/\.[a-z0-9]+$/i.test(parts[parts.length - 1])) mkdirSync(out, { recursive: true });
  return out;
}

interface Data {
  extra?: Record<string, unknown>;
}

class Store {
  private data: Data;
  private file: string;

  constructor() {
    this.file = dataDir('config.json');
    this.data = {};
    try {
      if (existsSync(this.file)) this.data = JSON.parse(readFileSync(this.file, 'utf8')) as Data;
    } catch (e) {
      console.error('config.json could not be read:', e);
    }
  }

  extra<T>(key: string): T | undefined {
    return this.data.extra?.[key] as T | undefined;
  }

  setExtra(key: string, value: unknown): void {
    this.data.extra = { ...(this.data.extra ?? {}), [key]: value };
    this.save();
  }

  private save(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.file);
  }
}

export const store = new Store();
