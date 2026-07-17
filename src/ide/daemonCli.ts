#!/usr/bin/env node

import { resolve } from 'node:path';
import { startIdeDaemon } from './daemon.js';
import { IDE_PROTOCOL_VERSION } from './protocol.js';

interface DaemonFlags {
  workspaceRoot: string;
  port: number;
  token: string;
  showHelp: boolean;
}

function parseFlags(argv: string[]): DaemonFlags {
  const flags: DaemonFlags = {
    workspaceRoot: process.cwd(),
    port: 0,
    token: '',
    showHelp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index] ?? '';
    switch (flag) {
      case '--workspace':
        flags.workspaceRoot = resolve(next());
        break;
      case '--port': {
        const port = Number.parseInt(next(), 10);
        if (Number.isFinite(port) && port >= 0 && port < 65536) flags.port = port;
        break;
      }
      case '--token':
        flags.token = next();
        break;
      case '--help':
      case '-h':
        flags.showHelp = true;
        break;
    }
  }
  return flags;
}

function printHelp(): void {
  process.stdout.write(`PentesterFlow IDE local daemon

Usage:
  pentesterflow-ide-daemon [flags]

Flags:
  --workspace <path>  Workspace to index (default: current directory)
  --port <number>     Loopback TCP port; 0 selects a free port (default: 0)
  --token <value>     Pre-shared client token; generated when omitted
  -h, --help          Show this help
`);
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.showHelp) {
    printHelp();
    return;
  }
  const daemon = await startIdeDaemon({
    workspaceRoot: flags.workspaceRoot,
    port: flags.port,
    token: flags.token || undefined,
  });
  process.stdout.write(
    `${JSON.stringify({
      protocolVersion: IDE_PROTOCOL_VERSION,
      url: daemon.url,
      token: daemon.token,
      workspaceRoot: flags.workspaceRoot,
    })}\n`,
  );
  const shutdown = async (): Promise<void> => {
    await daemon.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((err: unknown) => {
  process.stderr.write(
    `pentesterflow-ide-daemon: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
