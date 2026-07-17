import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface DockerDesktopStatus {
  available: boolean;
  status?: string;
  error?: string;
}

export class DockerDesktopController {
  async status(): Promise<DockerDesktopStatus> {
    try {
      const { stdout } = await execFileAsync('docker', ['desktop', 'status', '--format', 'json'], {
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true,
      });
      const value = stdout.trim();
      return { available: true, status: value || 'unknown' };
    } catch (err) {
      return { available: false, error: errorMessage(err) };
    }
  }

  async start(): Promise<DockerDesktopStatus> {
    const { stdout } = await execFileAsync('docker', ['desktop', 'start', '--detach'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    if (platform() === 'win32') {
      const programFiles = process.env.ProgramFiles;
      const executable = programFiles
        ? join(programFiles, 'Docker', 'Docker', 'Docker Desktop.exe')
        : '';
      if (executable && existsSync(executable)) {
        const desktop = spawn(executable, [], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        desktop.unref();
      }
    }
    return { available: true, status: stdout.trim() || 'start requested' };
  }

  async stop(force = false): Promise<DockerDesktopStatus> {
    const args = ['desktop', 'stop', '--detach'];
    if (force) args.push('--force');
    const { stdout } = await execFileAsync('docker', args, {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    });
    return { available: true, status: stdout.trim() || 'stop requested' };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
