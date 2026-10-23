import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const root = 'dist';
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const paths = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await walk(path));
    else paths.push(path);
  }
  return paths;
}
const assets = (await walk(root))
  .map((path) => '/' + relative(root, path).split(sep).join('/'))
  .filter((path) => path !== '/sw.js');
const swPath = join(root, 'sw.js');
let sw = await readFile(swPath, 'utf8');
const declaration = 'const SHELL_ASSETS = ' + JSON.stringify(Array.from(new Set(['/', ...assets]))) + ';';
if (!/const SHELL_ASSETS = \[[^\]]*\];/.test(sw)) {
  throw new Error('Could not find the service-worker shell asset declaration.');
}
// Fingerprint shipped app assets so each content-changing build receives a fresh cache.
// The service worker removes older AeroShell shell caches when the new one activates.
const digest = createHash('sha256');
for (const asset of [...assets].sort()) {
  digest.update(asset);
  digest.update(await readFile(join(root, asset.slice(1))));
}
const cacheName = 'aeroshell-shell-' + digest.digest('hex').slice(0, 12);
if (!/const CACHE_NAME = '[^']+';/.test(sw)) {
  throw new Error('Could not find the service-worker cache name declaration.');
}
sw = sw.replace(/const CACHE_NAME = '[^']+';/, `const CACHE_NAME = '${cacheName}';`);
sw = sw.replace(/const SHELL_ASSETS = \[[^\]]*\];/, declaration);
await writeFile(swPath, sw);
console.log('Prepared offline cache for ' + assets.length + ' local assets.');
