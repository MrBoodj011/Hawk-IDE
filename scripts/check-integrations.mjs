import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');
const browser = resolve(root, 'integrations', 'browser');
const burp = resolve(root, 'integrations', 'burp');
const manifest = JSON.parse(await readFile(resolve(browser, 'manifest.json'), 'utf8'));
const rootPackage = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const extensionPackage = JSON.parse(
  await readFile(resolve(root, 'extensions', 'hawk-security-ide', 'package.json'), 'utf8'),
);

assert(manifest.manifest_version === 3, 'browser companion must use Manifest V3');
assert(manifest.background?.service_worker === 'background.js', 'browser service worker is missing');
assert(Array.isArray(manifest.host_permissions), 'browser host permissions are missing');
assert(
  manifest.host_permissions.includes('<all_urls>'),
  'browser companion must declare capture host access',
);
assert(manifest.version === rootPackage.version, 'browser companion version must match Hawk');
assert(extensionPackage.version === rootPackage.version, 'IDE extension version must match Hawk');

const browserFiles = new Set([
  'background.js',
  'content.js',
  'page-hook.js',
  'popup.html',
  'popup.js',
  'options.html',
  'options.js',
  'styles.css',
  'icons/hawk-16.png',
  'icons/hawk-32.png',
  'icons/hawk-48.png',
  'icons/hawk-128.png',
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
assert(
  gradle.includes(`version = "${rootPackage.version}"`),
  'Burp companion version must match Hawk',
);
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
