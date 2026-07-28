import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  errorMessage,
  mcpHelp,
  parseMcpServerArgs,
  textResult,
  toolError,
} from './mcpServerSupport.js';

describe('Hawk MCP server support', () => {
  it('parses a workspace relative to the launcher directory', () => {
    const cwd = resolve('fixtures', 'launcher');
    expect(parseMcpServerArgs(['--workspace', '../project'], cwd)).toEqual({
      workspaceRoot: resolve(cwd, '../project'),
      showHelp: false,
    });
    expect(parseMcpServerArgs(['-h'], cwd)).toEqual({
      workspaceRoot: cwd,
      showHelp: true,
    });
  });

  it('rejects malformed and unknown startup options', () => {
    expect(() => parseMcpServerArgs(['--workspace'])).toThrow(/requires a path/);
    expect(() => parseMcpServerArgs(['--workspace', '--help'])).toThrow(/requires a path/);
    expect(() => parseMcpServerArgs(['--unsafe'])).toThrow(/Unknown Hawk MCP option/);
  });

  it('renders stable help and MCP text/error envelopes', () => {
    expect(mcpHelp('0.7.0')).toContain('hawk-ide-mcp 0.7.0');
    expect(mcpHelp('0.7.0')).toContain('${workspaceFolder}');
    expect(textResult('ready')).toEqual({
      content: [{ type: 'text', text: 'ready' }],
    });
    expect(toolError(new Error('blocked'))).toEqual({
      isError: true,
      content: [{ type: 'text', text: 'blocked' }],
    });
    expect(errorMessage('failed')).toBe('failed');
  });
});
