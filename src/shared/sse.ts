/**
 * Reads an open SSE body as events (the WHATWG rules: `field: value` lines, a blank line ends an event, `:` lines are
 * comments, data lines join with \n) and hands each one to `onEvent`. Fed text as it arrives, in pieces of any size.
 */
export function parseSse(onEvent: (e: { event: string; data: string; id?: string; retry?: number }) => void): (chunk: string) => void {
  let buf = '';
  let data: string[] = [];
  let event = '';
  let id: string | undefined;
  let retry: number | undefined;
  const dispatch = () => {
    if (data.length || event) onEvent({ event: event || 'message', data: data.join('\n'), ...(id !== undefined ? { id } : {}), ...(retry !== undefined ? { retry } : {}) });
    data = [];
    event = '';
    retry = undefined;
  };
  return (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.search(/\r\n|\r|\n/)) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + (buf[nl] === '\r' && buf[nl + 1] === '\n' ? 2 : 1));
      if (line === '') dispatch();
      else if (line.startsWith(':')) continue;
      else {
        const c = line.indexOf(':');
        const field = c < 0 ? line : line.slice(0, c);
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '');
        if (field === 'data') data.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') id = value;
        else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
      }
    }
  };
}
