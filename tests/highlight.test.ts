import { expect, test } from 'bun:test';
import { highlightShell, highlightYaml } from '../src/renderer/src/highlight';

const text = (h: string) => h.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const SRC = `# note
on:
  push:
    branches: ["main", 'x']
jobs:
  api:
    steps:
      - uses: actions/checkout@v4
      - name: Run <b>
        run: |
          npx --yes dialcatz@1 run ./api \\
            --collection 'A b' --var x="$DC_X" && echo 3 # done

        env:
          token: \${{ secrets.TOKEN }}
          n: 22
          ok: true # yes
  script:
    - |
      export a="$B"
  odd: : : "
`;

test('colouring changes no text, so the caret stays over what is typed', () => {
  expect(text(highlightYaml(SRC))).toBe(SRC);
  expect(text(highlightShell(SRC))).toBe(SRC);
});

test('YAML parts, and shell in a block only', () => {
  const h = highlightYaml(SRC);
  expect(h).toContain('<span class="hl-key">branches</span>');
  expect(h).toContain('<span class="hl-var">${{ secrets.TOKEN }}</span>');
  expect(h).toContain('<span class="hl-num">22</span>');
  expect(h).toContain('<span class="hl-fn">npx</span>');
  expect(h).toContain('<span class="hl-op">--collection</span>');
  expect(h).toContain('<span class="hl-kw">export</span>');
  expect(h).toContain('<span class="hl-key">env</span>');
  expect(h).not.toContain('<b>');
});
