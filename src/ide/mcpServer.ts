import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { importHawkHealthReport } from './hawkReport.js';
import { scanWorkspaceRoutes } from './routeScanner.js';
import { scanWorkspaceSecurity } from './staticAudit.js';

const SERVER_NAME = 'hawk-ide';
const SERVER_VERSION = '0.1.0';

interface ParsedArgs {
  workspaceRoot: string;
  showHelp: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = { workspaceRoot: process.cwd(), showHelp: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = () => argv[++index] ?? '';
    if (flag === '--workspace') args.workspaceRoot = resolve(next());
    if (flag === '--help' || flag === '-h') args.showHelp = true;
  }
  return args;
}

function printHelp(): void {
  process.stderr.write(`hawk-ide-mcp ${SERVER_VERSION}

Read-only MCP server for local Hawk Security IDE analysis.
It parses source files; it does not execute project code or send requests.

Usage:
  hawk-ide-mcp --workspace <path>

MCP configuration:
  {
    "mcpServers": {
      "hawk": {
        "command": "hawk-ide-mcp",
        "args": ["--workspace", "\${workspaceFolder}"]
      }
    }
  }
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.showHelp) {
    printHelp();
    return;
  }

  const mcp = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  mcp.registerTool(
    'ide_route_inventory',
    {
      title: 'IDE route inventory',
      description:
        'Passively index Express, Fastify, and Next.js routes in the local workspace. This reads source text only and never starts the application.',
      inputSchema: {
        path_contains: z.string().optional().describe('Optional substring filter for route paths.'),
      },
    },
    async (input) => {
      const inventory = await scanWorkspaceRoutes(args.workspaceRoot);
      const query = input.path_contains?.toLowerCase();
      const routes = query
        ? inventory.routes.filter((route) => route.path.toLowerCase().includes(query))
        : inventory.routes;
      return textResult(JSON.stringify({ sourceFiles: inventory.sourceFiles, routes }, null, 2));
    },
  );
  mcp.registerTool(
    'hawk_supply_chain_health',
    {
      title: 'Hawk supply-chain health',
      description:
        'Read the sanitized local .hawk/health.json import created from a Hawk health report. This never contacts GitHub and does not expose credentials or raw alert payloads.',
      inputSchema: {},
    },
    async () => {
      try {
        const report = importHawkHealthReport(
          JSON.parse(await readFile(join(args.workspaceRoot, '.hawk', 'health.json'), 'utf8')),
        );
        return textResult(JSON.stringify(report, null, 2));
      } catch (err) {
        return textResult(
          JSON.stringify({
            available: false,
            message: `No local Hawk health report: ${errorMessage(err)}`,
          }),
        );
      }
    },
  );
  mcp.registerTool(
    'ide_static_audit',
    {
      title: 'IDE local static audit',
      description:
        'Run a passive, redacted code audit for high-signal insecure patterns. Results are suspected signals requiring manual validation, not confirmed vulnerabilities.',
      inputSchema: {
        severity: z
          .enum(['critical', 'high', 'medium', 'low', 'info'])
          .optional()
          .describe('Optional exact severity filter.'),
      },
    },
    async (input) => {
      const report = await scanWorkspaceSecurity(args.workspaceRoot);
      const severity = input.severity;
      const findings = severity
        ? report.findings.filter((finding) => finding.severity === severity)
        : report.findings;
      return textResult(
        JSON.stringify(
          {
            scannedAt: report.scannedAt,
            sourceFiles: report.sourceFiles,
            validationRequired: true,
            findings,
          },
          null,
          2,
        ),
      );
    },
  );

  await mcp.connect(new StdioServerTransport());
  await new Promise<void>(() => undefined);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

main().catch((err: unknown) => {
  process.stderr.write(`[hawk-ide-mcp] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
