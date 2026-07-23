import { createHash } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';

const root = resolve('.');
const first = await buildSnapshot();
const second = await buildSnapshot();
if (JSON.stringify(first) !== JSON.stringify(second)) {
  const names = [...new Set([...Object.keys(first), ...Object.keys(second)])];
  const changed = names.filter((name) => first[name] !== second[name]);
  throw new Error(`Build is not reproducible. Changed artifacts: ${changed.join(', ')}`);
}
process.stdout.write(`${JSON.stringify({ reproducible: true, artifacts: Object.keys(first).length })}\n`);

async function buildSnapshot() {
  await rm(resolve(root, 'dist'), { recursive: true, force: true });
  await execa('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });
  const files = await walk(resolve(root, 'dist'));
  const output = {};
  for (const file of files) {
    const relative = file.slice(resolve(root, 'dist').length + 1).replace(/\\/g, '/');
    output[relative] = createHash('sha256').update(await readFile(file)).digest('hex');
  }
  return output;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const values = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) values.push(...(await walk(path)));
    else if (entry.isFile() && !entry.name.endsWith('.map')) values.push(path);
  }
  return values.sort();
}
