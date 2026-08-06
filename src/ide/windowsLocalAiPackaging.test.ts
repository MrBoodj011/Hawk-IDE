import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Windows embedded Hawk Local AI packaging', () => {
  it('bundles a verified standalone runtime without launching another installer', async () => {
    const [prepare, installer, msi, workflow, license] = await Promise.all([
      source('desktop/windows/prepare-embedded-ollama.ps1'),
      source('desktop/windows/package-installer.ps1'),
      source('desktop/windows/package-msi.ps1'),
      source('.github/workflows/desktop-release.yml'),
      source('desktop/windows/OLLAMA-LICENSE.txt'),
    ]);

    expect(prepare).toContain("$_.name -eq 'ollama-windows-amd64.zip'");
    expect(prepare).toContain("$downloadUri.Host -ne 'github.com'");
    expect(prepare).toContain("$digest -notmatch '^sha256:");
    expect(prepare).toContain('Get-AuthenticodeSignature -LiteralPath $executable');
    expect(prepare).toContain("$signature.Status -ne 'Valid'");
    expect(prepare).toContain("Join-Path $runtimeRoot 'ollama'");
    expect(license).toContain('MIT License');

    for (const packageScript of [installer, msi]) {
      expect(packageScript).toContain('resources\\hawk-local-ai\\ollama\\ollama.exe');
      expect(packageScript).not.toContain('OllamaSetup.exe');
    }
    expect(installer).not.toContain('nsExec::');

    const prepareIndex = workflow.indexOf('prepare-embedded-ollama.ps1');
    const archiveIndex = workflow.indexOf('Compress-Archive', prepareIndex);
    const installerIndex = workflow.indexOf('package-installer.ps1', prepareIndex);
    expect(prepareIndex).toBeGreaterThan(0);
    expect(archiveIndex).toBeGreaterThan(prepareIndex);
    expect(installerIndex).toBeGreaterThan(prepareIndex);
  });
});

async function source(path: string): Promise<string> {
  return await readFile(resolve(path), 'utf8');
}
