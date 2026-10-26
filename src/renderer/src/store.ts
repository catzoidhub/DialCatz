/** Small per-window preferences in localStorage (open tabs, the last workspace, pane sizes); never secrets. */
const PREFIX = 'dialcatz:';

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(PREFIX + key);
      return v === null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set<T>(key: string, value: T): void {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
      /* full or blocked: only a convenience */
    }
  },
};
