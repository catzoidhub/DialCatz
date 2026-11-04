import type { McatzpSettings } from '@shared/types';

/**
 * Approved clients as stored: well-formed, one per name, the earliest approval kept. An older MCatzP host saved one more
 * for every connection that shared a pairing answer. Nobody is removed here: taking a client away is the user's Revoke.
 */
export function cleanClients(raw: unknown): McatzpSettings['clients'] {
  const out = new Map<string, McatzpSettings['clients'][number]>();
  for (const c of Array.isArray(raw) ? raw : []) {
    if (typeof c?.name !== 'string' || typeof c?.approvedAt !== 'string') continue;
    const seen = out.get(c.name);
    if (!seen || c.approvedAt < seen.approvedAt) out.set(c.name, { name: c.name, approvedAt: c.approvedAt });
  }
  return [...out.values()];
}
