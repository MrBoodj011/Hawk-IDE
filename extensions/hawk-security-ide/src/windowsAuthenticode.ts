import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WindowsAuthenticodeIdentity {
  status: string;
  subject: string;
  thumbprint: string;
}

/**
 * Require a Windows-trusted Authenticode chain before Hawk can launch an
 * update. SHA-256 binds the file to the private release; this independently
 * binds it to a trusted Windows publisher.
 */
export async function verifyWindowsAuthenticode(
  path: string,
  expectedPublisher = '',
): Promise<WindowsAuthenticodeIdentity> {
  if (process.platform !== 'win32') {
    throw new Error('Authenticode verification is only available on Windows.');
  }
  const script = [
    '$signature = Get-AuthenticodeSignature -LiteralPath $args[0]',
    '[PSCustomObject]@{',
    '  Status = [string]$signature.Status',
    '  Subject = [string]$signature.SignerCertificate.Subject',
    '  Thumbprint = [string]$signature.SignerCertificate.Thumbprint',
    '} | ConvertTo-Json -Compress',
  ].join('; ');
  const result = await execFileAsync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script, path],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  const parsed = JSON.parse(result.stdout.trim()) as Partial<WindowsAuthenticodeIdentity> & {
    Status?: string;
    Subject?: string;
    Thumbprint?: string;
  };
  const identity = {
    status: parsed.status ?? parsed.Status ?? '',
    subject: parsed.subject ?? parsed.Subject ?? '',
    thumbprint: parsed.thumbprint ?? parsed.Thumbprint ?? '',
  } satisfies WindowsAuthenticodeIdentity;
  if (identity.status !== 'Valid' || !identity.subject || !identity.thumbprint) {
    throw new Error(
      `Hawk update has no Windows-trusted Authenticode signature (${identity.status || 'Unknown'}).`,
    );
  }
  const publisher = expectedPublisher.trim();
  if (publisher && !identity.subject.toLowerCase().includes(publisher.toLowerCase())) {
    throw new Error(
      `Hawk update publisher "${identity.subject}" does not match "${publisher}".`,
    );
  }
  return identity;
}
