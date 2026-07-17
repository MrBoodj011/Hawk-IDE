import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const browser = resolve(root, 'integrations', 'browser');
const burp = resolve(root, 'integrations', 'burp');
const manifest = JSON.parse(await readFile(resolve(browser, 'manifest.json'), 'utf8'));

assert(manifest.manifest_version === 3, 'browser companion must use Manifest V3');
assert(manifest.background?.service_worker === 'background.js', 'browser service worker is missing');
assert(Array.isArray(manifest.host_permissions), 'browser host permissions are missing');
assert(
  manifest.host_permissions.includes('<all_urls>'),
  'browser companion must declare capture host access',
);

const browserFiles = new Set([
  'background.js',
  'content.js',
  'page-hook.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'styles.css',
]);
for (const file of browserFiles) await assertFile(resolve(browser, file));
for (const file of ['background.js', 'content.js', 'page-hook.js', 'popup.js', 'options.js']) {
  new vm.Script(await readFile(resolve(browser, file), 'utf8'), {
    filename: `integrations/browser/${file}`,
  });
}

const gradle = await readFile(resolve(burp, 'build.gradle.kts'), 'utf8');
assert(gradle.includes('montoya-api'), 'Burp companion must compile against the Montoya API');
assert(gradle.includes('sourceCompatibility = "21"'), 'Burp companion must pin Java 21');
const source = await readFile(resolve(burp, 'src', 'main', 'java', 'Extension.java'), 'utf8');
for (const contract of [
  'implements BurpExtension',
  'registerHttpHandler',
  'registerSuiteTab',
  'registerUnloadingHandler',
  'X-Hawk-Token',
]) {
  assert(source.includes(contract), `Burp companion is missing ${contract}`);
}

process.stdout.write('Hawk browser and Burp companion contracts are valid.\n');

async function assertFile(path) {
  const info = await stat(path);
  assert(info.isFile() && info.size > 0, `missing or empty integration file: ${path}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
