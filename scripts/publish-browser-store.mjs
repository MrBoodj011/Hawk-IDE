import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const packagePath = resolve(argument('--file') || '');
const publisherId = process.env.CHROME_WEBSTORE_PUBLISHER_ID || '';
const extensionId = process.env.CHROME_WEBSTORE_EXTENSION_ID || '';
const accessToken = process.env.CHROME_WEBSTORE_ACCESS_TOKEN || '';
const publish = process.argv.includes('--publish');

if (!argument('--file')) {
  throw new Error('Pass --file with the packaged Hawk Browser Companion ZIP.');
}
const info = await stat(packagePath);
if (!info.isFile() || info.size <= 0 || info.size > 250_000_000) {
  throw new Error('The browser store package is missing, empty, or unexpectedly large.');
}
if (!publisherId || !extensionId || !accessToken) {
  console.log(
    JSON.stringify(
      {
        ready: false,
        package: packagePath,
        bytes: info.size,
        missing: [
          !publisherId && 'CHROME_WEBSTORE_PUBLISHER_ID',
          !extensionId && 'CHROME_WEBSTORE_EXTENSION_ID',
          !accessToken && 'CHROME_WEBSTORE_ACCESS_TOKEN',
        ].filter(Boolean),
        note: 'No upload was attempted. Configure the owner account and its OAuth token first.',
      },
      null,
      2,
    ),
  );
  process.exitCode = 2;
} else {
  const body = await readFile(packagePath);
  const upload = await fetch(
    `https://chromewebstore.googleapis.com/upload/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:upload`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/zip',
      },
      body,
    },
  );
  const uploadBody = await upload.text();
  if (!upload.ok) throw new Error(`Chrome Web Store upload failed (${upload.status}): ${uploadBody}`);
  if (!publish) {
    console.log(uploadBody);
    console.log('Upload completed. Review it in the dashboard; --publish was not supplied.');
  } else {
    const submission = await fetch(
      `https://chromewebstore.googleapis.com/v2/publishers/${encodeURIComponent(publisherId)}/items/${encodeURIComponent(extensionId)}:publish`,
      { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const submissionBody = await submission.text();
    if (!submission.ok) {
      throw new Error(
        `Chrome Web Store submission failed (${submission.status}): ${submissionBody}`,
      );
    }
    console.log(submissionBody);
  }
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
