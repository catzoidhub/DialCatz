import type { ActionDef } from '@catzoid/mcatzp-host';
import type { DialCatzApi } from '@shared/types';
import { readActions } from './actions';

/** Every tool with everything shared, for the reference and the coverage test. Nothing here runs: the API is never called. */
export function allActions(): ActionDef[] {
  const never = () => {
    throw new Error('The registry is only listed here');
  };
  const api = new Proxy({}, { get: () => never }) as DialCatzApi;
  return readActions(api, { workspace: () => true, values: true, responses: true, git: true }, { tabs: never, tabResponse: never });
}
