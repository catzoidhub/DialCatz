// Prepends a note to the generated DialCatz Den API types (bun run gen:den).
import { readFileSync, writeFileSync } from 'node:fs';

const file = 'src/main/den-api.ts';
const note = '// Generated from DialCatz Den\'s openapi.yaml by `bun run gen:den` (openapi-typescript). Do not edit by hand.\n\n';
const src = readFileSync(file, 'utf8');
if (!src.startsWith('// Generated')) writeFileSync(file, note + src);
