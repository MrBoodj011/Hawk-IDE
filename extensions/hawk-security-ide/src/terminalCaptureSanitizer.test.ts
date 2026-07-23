import { describe, expect, it } from 'vitest';
import {
  redactTerminalSecrets,
  sanitizeTerminalRecord,
  stripTerminalControlSequences,
} from './terminalCaptureSanitizer';

describe('terminal capture sanitizer', () => {
  it('removes CSI, OSC, control characters, and applies backspaces', () => {
    const value =
      '\u001b[31mFAIL\u001b[0m\r\n\u001b]0;private-title\u0007abc\bD\u0000\n';
    expect(stripTerminalControlSequences(value)).toBe('FAIL\r\nabD\n');
  });

  it('redacts common credentials in commands and output', () => {
    const value = [
      'API_KEY=sk-abcdefghijklmnopqrstuvwxyz',
      'Authorization: Bearer abc.def-123',
      'https://admin:password@example.com/private',
      'AWS_ACCESS_KEY_ID=AKIAABCDEFGHIJKLMNOP',
    ].join('\n');
    const redacted = redactTerminalSecrets(value);
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('abc.def-123');
    expect(redacted).not.toContain('admin:password');
    expect(redacted).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(redacted).toContain('[REDACTED');
  });

  it('keeps the bounded tail where compiler and test failures normally appear', () => {
    const result = sanitizeTerminalRecord(`start\n${'x'.repeat(600)}\nfinal error`, 256);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain('start');
    expect(result.text).toContain('final error');
    expect(result.text.length).toBeLessThanOrEqual(256);
  });
});
