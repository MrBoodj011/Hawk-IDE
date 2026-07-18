import { createHash } from 'node:crypto';
import type { Config } from '../config/config.js';

export type TelemetryEventName =
  | 'app_started'
  | 'app_stopped'
  | 'command_completed'
  | 'command_failed'
  | 'agent_task_completed'
  | 'agent_task_failed'
  | 'desktop_crash'
  | 'update_checked'
  | 'update_installed';

export interface TelemetryOptions {
  endpoint: string;
  installationId: string;
  release: string;
  platform: string;
  enabled: boolean;
  crashReportingEnabled: boolean;
}

export class TelemetryClient {
  constructor(private readonly options: TelemetryOptions) {}

  static fromConfig(cfg: Config, release: string): TelemetryClient {
    return new TelemetryClient({
      endpoint: cfg.telemetry_endpoint,
      installationId: cfg.installation_id,
      release,
      platform: process.platform,
      enabled: cfg.telemetry_enabled,
      crashReportingEnabled: cfg.crash_reporting_enabled,
    });
  }

  async capture(
    event: TelemetryEventName,
    properties: Record<string, string | number | boolean> = {},
  ): Promise<boolean> {
    if (!this.options.enabled || !this.ready()) return false;
    return await this.send(event, sanitizeProperties(properties));
  }

  async captureCrash(error: unknown): Promise<boolean> {
    if (!this.options.crashReportingEnabled || !this.ready()) return false;
    const normalized = normalizeError(error);
    return await this.send('desktop_crash', {
      errorName: normalized.name,
      fingerprint: normalized.fingerprint,
    });
  }

  private ready(): boolean {
    return (
      this.options.installationId.length === 32 && this.options.endpoint.startsWith('https://')
    );
  }

  private async send(
    event: TelemetryEventName,
    properties: Record<string, string | number | boolean>,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await fetch(this.options.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hawk-Installation-Id': this.options.installationId,
        },
        body: JSON.stringify({
          event,
          release: this.options.release,
          platform: this.options.platform,
          properties,
        }),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function sanitizeProperties(
  properties: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
  const blocked =
    /(code|source|prompt|response|request|header|cookie|token|secret|path|url|email)/i;
  const clean: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties).slice(0, 30)) {
    if (blocked.test(key) || key.length > 50) continue;
    clean[key] = typeof value === 'string' ? value.slice(0, 200) : value;
  }
  return clean;
}

export function normalizeError(error: unknown): { name: string; fingerprint: string } {
  const name = error instanceof Error ? error.name.slice(0, 80) : 'NonError';
  const stack = error instanceof Error ? error.stack || error.message : String(error);
  const normalized = stack
    .split(/\r?\n/)
    .slice(0, 8)
    .map((line) =>
      line
        .replace(/[A-Za-z]:\\[^\s)]+/g, '<path>')
        .replace(/\/(?:Users|home|tmp|var)\/[^\s)]+/g, '<path>')
        .replace(/[0-9a-f]{16,}/gi, '<id>')
        .replace(/\d+:\d+/g, '<line>'),
    )
    .join('\n');
  return {
    name,
    fingerprint: createHash('sha256').update(`${name}\n${normalized}`).digest('hex').slice(0, 24),
  };
}
