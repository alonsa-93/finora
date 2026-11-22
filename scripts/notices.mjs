// Generates THIRD-PARTY-NOTICES.txt from the PRODUCTION dependency tree (npm ls --omit=dev), plus
// the bundled Rubik font. Shipped next to the app via build.extraFiles. Offline, no downloads.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = execSync('npm ls --omit=dev --all --parseable', { cwd: root, encoding: 'utf8' }); // constant command
const dirs = [...new Set(out.split(/\r?\n/).filter((d) => d && d !== root))].sort();
const parts = ['MoneyCash - third-party software notices', '='.repeat(60),
  'MoneyCash includes the following open-source components. Electron and Chromium notices are in',
  'LICENSE.electron.txt and LICENSES.chromium.html next to MoneyCash.exe.', ''];
const seen = new Set();
for (const d of dirs) {
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8')); } catch { continue; }
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id)) continue;
  seen.add(id);
  const lic = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || 'see package';
  const file = readdirSync(d).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f));
  parts.push('-'.repeat(60), `${id}  (${lic})`, pkg.homepage ? `${pkg.homepage}` : '', '');
  if (file) parts.push(readFileSync(join(d, file), 'utf8').trim(), '');
}
parts.push('-'.repeat(60), 'Rubik (web/assets/fonts)  (OFL-1.1)', '',
  readFileSync(join(root, 'web', 'assets', 'fonts', 'LICENSE-Rubik.txt'), 'utf8').trim(), '');
writeFileSync(join(root, 'THIRD-PARTY-NOTICES.txt'), parts.join('\n'), 'utf8');
console.log(`THIRD-PARTY-NOTICES.txt: ${seen.size} packages`);
