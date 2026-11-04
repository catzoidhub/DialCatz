import { expect, test } from 'bun:test';
import { cleanClients } from '../src/main/mcatzp/clients';

test('one entry per client, the earliest approval, and nobody removed', () => {
  const raw = [
    { name: 'claude-code', approvedAt: '2026-11-04T10:00:00.000Z' },
    { name: 'claude-code', approvedAt: '2026-11-04T08:00:00.000Z' },
    { name: 'zcode', approvedAt: '2026-11-04T09:00:00.000Z' },
    { name: 'claude-code', approvedAt: '2026-11-04T12:00:00.000Z' },
    { name: 'DoCatz test client', approvedAt: '2026-11-04T11:00:00.000Z' },
  ];
  expect(cleanClients(raw)).toEqual([
    { name: 'claude-code', approvedAt: '2026-11-04T08:00:00.000Z' },
    { name: 'zcode', approvedAt: '2026-11-04T09:00:00.000Z' },
    { name: 'DoCatz test client', approvedAt: '2026-11-04T11:00:00.000Z' },
  ]);
});

test('what is not a client, or no list at all, goes quietly', () => {
  expect(cleanClients([{ name: 'x' }, null, 'y', { name: 1, approvedAt: 'z' }])).toEqual([]);
  expect(cleanClients(undefined)).toEqual([]);
});
