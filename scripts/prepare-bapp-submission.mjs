import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

const jar = resolve(argument('--file') || '');
const output = resolve(argument('--output') || 'artifacts/bapp-submission.json');
const sourceUrl = argument('--source-url') || 'https://github.com/MrBoodj011/hawk';
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version;
if (!argument('--file')) throw new Error('Pass --file with the Hawk Burp Companion JAR.');
const info = await stat(jar);
if (!info.isFile() || info.size <= 0 || info.size > 100_000_000 || !jar.endsWith('.jar')) {
  throw new Error('The Hawk Burp Companion JAR is missing, empty, too large, or invalid.');
}
if (basename(jar).toLowerCase() !== `hawk-burp-companion-${expectedVersion}.jar`) {
  throw new Error(`Expected hawk-burp-companion-${expectedVersion}.jar from the current source.`);
}
const parsedSource = new URL(sourceUrl);
if (parsedSource.protocol !== 'https:' || parsedSource.hostname !== 'github.com') {
  throw new Error('The BApp reviewer source must be an HTTPS GitHub URL.');
}
const submissionText = await readFile('integrations/burp/BAPP_SUBMISSION.md', 'utf8');
if (!submissionText.includes('Hawk Burp Companion') || submissionText.length < 500) {
  throw new Error('The BApp submission description is incomplete.');
}
const sha256 = createHash('sha256').update(await readFile(jar)).digest('hex');
const result = {
  schemaVersion: 1,
  product: 'Hawk Burp Companion',
  version: expectedVersion,
  artifact: jar,
  bytes: info.size,
  sha256,
  sourceUrl: parsedSource.toString(),
  submissionText: 'integrations/burp/BAPP_SUBMISSION.md',
  officialSubmissionUrl:
    'https://github.com/PortSwigger/extension-portal/issues/new?template=bapp-submission.yml',
  readyForManualReview: true,
  note: 'PortSwigger owns review and publication. This pack does not claim store approval.',
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
