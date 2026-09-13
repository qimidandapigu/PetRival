import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const paths = [];
function walk(dir) { for (const e of readdirSync(dir, { withFileTypes: true })) { if (['.git', 'data', 'node_modules', '.artifacts', 'sites-app', 'dist', '.wrangler', '.sites-runtime'].includes(e.name) || e.name === '.env') continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p); else paths.push(p); } }
walk('.'); let failures = 0;
for (const file of paths) {
  if (file.endsWith('.mjs')) {
    const check = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (check.status) { process.stderr.write(check.stderr); failures++; }
  }
  if (!/\.(mjs|html|css|md|json|example|gitignore)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|sk-[A-Za-z0-9_-]{24,})\b/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) { console.error(`Possible secret in ${file}`); failures++; }
}
console.log(`Checked ${paths.length} files: syntax and basic secret-pattern scan. ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
