import { resolve } from 'node:path';

export interface McpServerArgs {
  workspaceRoot: string;
  showHelp: boolean;
}

export function parseMcpServerArgs(
  argv: string[],
  currentDirectory = process.cwd(),
): McpServerArgs {
  const args: McpServerArgs = {
    workspaceRoot: resolve(currentDirectory),
    showHelp: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--workspace') {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--workspace requires a path');
      }
      args.workspaceRoot = resolve(currentDirectory, value);
      index += 1;
      continue;
    }
    if (flag === '--help' || flag === '-h') {
      args.showHelp = true;
      continue;
    }
    throw new Error(`Unknown Hawk MCP option: ${flag}`);
  }
  return args;
}

export function mcpHelp(version: string): string {
  return `hawk-ide-mcp ${version}

Local Hawk Security IDE analysis and isolated worker orchestration.
Passive tools only parse source files. Parallel worker tools require an
explicit call, use an existing local Docker image, mount the workspace
read-only, and disable container network unless external access is explicitly
approved.

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
`;
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function toolError(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: errorMessage(error) }],
  };
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
