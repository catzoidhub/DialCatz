/**
 * The CLI has no DialCatz data folder: what the app keeps in config.json (files picked for upload, kept tokens) is
 * held in memory for one run.
 */
const data = new Map<string, unknown>();
export const store = {
  extra: <T>(key: string): T | undefined => data.get(key) as T | undefined,
  setExtra: (key: string, value: unknown): void => void data.set(key, value),
};
export function dataDir(): string {
  throw new Error('The CLI has no data folder');
}
