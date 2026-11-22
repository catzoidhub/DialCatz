// bun scripts/build-cli.mjs — bundles the CLI (#101) into one file Node 20+ runs: dist-cli/dialcatz.mjs.
// It shares the app's own code (requests, scripts' runtime, importers, the spec check); what the app keeps in
// Electron's data folder is swapped for an in-memory stand-in (cli/store-stub.ts).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const out = join(root, 'dist-cli');
mkdirSync(out, { recursive: true });

const r = await Bun.build({
  entrypoints: [join(root, 'cli/index.ts')],
  target: 'node',
  format: 'esm',
  minify: { syntax: true, whitespace: false, identifiers: false },
  define: { __VERSION__: JSON.stringify(version) },
  plugins: [
    {
      name: 'dialcatz-cli',
      setup(b) {
        b.onResolve({ filter: /^@shared\// }, (a) => ({ path: join(root, 'src/shared', `${a.path.slice('@shared/'.length)}.ts`) }));
        // The app's settings store lives in Electron's data folder.
        b.onResolve({ filter: /^\.\/store$/ }, (a) => (a.importer.includes(`${join('src', 'main')}`) ? { path: join(root, 'cli/store-stub.ts') } : undefined));
        b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: resolve(dirname(a.importer), a.path.slice(0, -4)), namespace: 'raw' }));
        b.onLoad({ filter: /.*/, namespace: 'raw' }, (a) => ({ contents: `export default ${JSON.stringify(readFileSync(a.path, 'utf8'))};`, loader: 'js' }));
        b.onResolve({ filter: /^electron$/ }, () => {
          throw new Error('The CLI must not import electron: something in cli/ pulled in an app-only module');
        });
      },
    },
  ],
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
const file = join(out, 'dialcatz.mjs');
writeFileSync(file, `#!/usr/bin/env node\n${await r.outputs[0].text()}`);
chmodSync(file, 0o755);
console.log(`dist-cli/dialcatz.mjs ${(readFileSync(file).length / 1024).toFixed(0)} KB (DialCatz CLI ${version})`);
