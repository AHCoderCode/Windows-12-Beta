import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

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
sw = sw.replace(/const SHELL_ASSETS = \[[^\]]*\];/, declaration);
await writeFile(swPath, sw);
console.log('Prepared offline cache for ' + assets.length + ' local assets.');
