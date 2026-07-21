import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const packagePath = resolve(argument('--file') || '');
const publisherId = process.env.CHROME_WEBSTORE_PUBLISHER_ID || '';
const extensionId = process.env.CHROME_WEBSTORE_EXTENSION_ID || '';
const publish = process.argv.includes('--publish');
const validateOnly = process.argv.includes('--validate-only');

if (!argument('--file')) {
  throw new Error('Pass --file with the packaged Hawk Browser Companion ZIP.');
}
const info = await stat(packagePath);
if (!info.isFile() || info.size <= 0 || info.size > 250_000_000) {
  throw new Error('The browser store package is missing, empty, or unexpectedly large.');
}
const refreshConfigured = [
  'CHROME_WEBSTORE_CLIENT_ID',
  'CHROME_WEBSTORE_CLIENT_SECRET',
  'CHROME_WEBSTORE_REFRESH_TOKEN',
].every((name) => Boolean(process.env[name]));
const credentialConfigured = Boolean(process.env.CHROME_WEBSTORE_ACCESS_TOKEN) || refreshConfigured;
const missing = [
  !publisherId && 'CHROME_WEBSTORE_PUBLISHER_ID',
  !extensionId && 'CHROME_WEBSTORE_EXTENSION_ID',
  !credentialConfigured &&
    'CHROME_WEBSTORE_ACCESS_TOKEN or CLIENT_ID + CLIENT_SECRET + REFRESH_TOKEN',
].filter(Boolean);

if (validateOnly || missing.length) {
  console.log(
    JSON.stringify(
      {
        ready: missing.length === 0,
        package: packagePath,
        bytes: info.size,
        missing,
        note: 'Validation only: no upload or store submission was attempted.',
      },
      null,
      2,
    ),
  );
  if (!validateOnly && missing.length) process.exitCode = 2;
} else {
  const accessToken = await resolveAccessToken();
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

async function resolveAccessToken() {
  if (process.env.CHROME_WEBSTORE_ACCESS_TOKEN) {
    return process.env.CHROME_WEBSTORE_ACCESS_TOKEN;
  }
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.CHROME_WEBSTORE_CLIENT_ID || '',
      client_secret: process.env.CHROME_WEBSTORE_CLIENT_SECRET || '',
      refresh_token: process.env.CHROME_WEBSTORE_REFRESH_TOKEN || '',
      grant_type: 'refresh_token',
    }),
  });
  const payload = await tokenResponse.json().catch(() => ({}));
  if (!tokenResponse.ok || typeof payload.access_token !== 'string') {
    throw new Error(`Chrome OAuth refresh failed (${tokenResponse.status}).`);
  }
  return payload.access_token;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
