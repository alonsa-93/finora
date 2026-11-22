// Writes dist/SHA256SUMS.txt for the release artifacts (run by `npm run dist`). Publish it next to
// the installer; once a signing certificate exists, the sums must be computed AFTER signing.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const files = readdirSync(dist).filter((f) => /\.(exe|cdx\.json)$/i.test(f)).sort();
const lines = files.map((f) => `${createHash('sha256').update(readFileSync(join(dist, f))).digest('hex')}  ${f}`);
writeFileSync(join(dist, 'SHA256SUMS.txt'), `${lines.join('\n')}\n`, 'ascii');
console.log(lines.join('\n'));
