import type { ActionDef } from '@catzoid/mcatzp-host';
import type { DialCatzApi } from '@shared/types';
import { readActions } from './actions';
import { changeActions } from './changes';

/** Every tool with everything shared, for the reference and the coverage test. Nothing here runs: the API is never called. */
export function allActions(): ActionDef[] {
  const never = () => {
    throw new Error('The registry is only listed here');
  };
  const api = new Proxy({}, { get: () => never }) as DialCatzApi;
  const scopes = { workspace: () => true, values: true, responses: true, git: true, changes: true };
  return [...readActions(api, scopes, { tabs: never, tabResponse: never, runState: never }), ...changeActions(api, scopes, never, never)];
}
