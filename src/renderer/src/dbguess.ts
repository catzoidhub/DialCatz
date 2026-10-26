/**
 * "Check in DBCatz": which table a call most likely touched, from its URL — the resource in the path, snake_case
 * (`/api/v1/order-items/42` → `order_items`, row id = 42). For a create call without an id in the path, the new
 * row's id comes from the JSON answer (`id`, `data.id`). A guess the user can correct per request.
 */
const ID = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{24})$/i;
const SKIP = /^(api|v\d+(\.\d+)*|rest|graphql|admin|public|internal|latest)$/i;
/** Words after an id that are actions on that row, not a table of their own. */
const ACTIONS = new Set(['restore', 'publish', 'unpublish', 'approve', 'reject', 'cancel', 'activate', 'deactivate', 'archive', 'unarchive', 'confirm', 'verify', 'toggle', 'duplicate', 'clone', 'export', 'download', 'upload', 'attach', 'detach', 'sync', 'send', 'resend', 'reset', 'lock', 'unlock', 'close', 'open', 'complete', 'refund', 'status', 'show', 'edit']);

const snake = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-.\s]+/g, '_')
    .toLowerCase();

export interface TableGuess {
  table: string;
  col?: string;
  val?: string;
}

export function guessTable(url: string, method: string, body?: string | null): TableGuess | null {
  let path: string[];
  try {
    path = new URL(url).pathname
      .split('/')
      .map((p) => decodeURIComponent(p).trim())
      .filter((p) => p && !SKIP.test(p));
  } catch {
    return null;
  }
  // the last resource and the id right after it
  let table = '';
  let val: string | undefined;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    if (ID.test(p)) {
      if (table) val = p;
      continue;
    }
    if (val !== undefined && ACTIONS.has(p.toLowerCase())) break;
    if (!/^[A-Za-z][\w.-]*$/.test(p)) continue;
    table = p;
    val = undefined;
  }
  if (!table) return null;
  if (val === undefined && /^(POST|PUT|PATCH)$/i.test(method) && body) {
    try {
      const j = JSON.parse(body) as Record<string, unknown> | null;
      const id = j?.id ?? (j?.data as Record<string, unknown> | undefined)?.id;
      if ((typeof id === 'number' || typeof id === 'string') && ID.test(String(id))) val = String(id);
    } catch {
      /* not JSON */
    }
  }
  return { table: snake(table), ...(val !== undefined ? { col: 'id', val } : {}) };
}
