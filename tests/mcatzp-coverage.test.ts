import { expect, test } from 'bun:test';
import { MCATZP_COVERAGE } from '../src/main/mcatzp/coverage';
import { allActions } from '../src/main/mcatzp/registry';

const names = new Set(allActions().map((a) => a.name));

test('every tool the coverage file names exists', () => {
  for (const [method, place] of Object.entries(MCATZP_COVERAGE)) {
    const m = /^tool: (.+?)(?: \(|$)/.exec(place);
    if (!m) continue;
    for (const tool of m[1].split(', ')) expect(`${method} → ${names.has(tool) ? tool : `no tool ${tool}`}`).toBe(`${method} → ${tool}`);
  }
});

test('every place is one the coverage file knows', () => {
  expect(Object.entries(MCATZP_COVERAGE).filter(([, place]) => !/^(tool: |later: (change|destructive)|not a tool|never: |ask the user)/.test(place))).toEqual([]);
});

test('tool names are unique and every input refuses unknown fields', () => {
  const all = allActions();
  expect(new Set(all.map((a) => a.name)).size).toBe(all.length);
  for (const a of all) expect(`${a.name}: ${(a.input as { additionalProperties?: boolean }).additionalProperties}`).toBe(`${a.name}: false`);
});

test('a destructive tool never offers "allow for this session"', () => {
  for (const a of allActions()) if (a.tier === 'destructive') expect(`${a.name}: ${!!a.allowSession}`).toBe(`${a.name}: false`);
});

// "Allow for this session" holds per tool, whatever the call: these carry secrets, or run with them.
test('sending a request and writing a script always ask', () => {
  for (const name of ['send_request', 'send_new_request', 'run_collection', 'websocket_connect', 'websocket_send', 'set_scripts']) expect(`${name}: ${!!allActions().find((a) => a.name === name)?.allowSession}`).toBe(`${name}: false`);
});
