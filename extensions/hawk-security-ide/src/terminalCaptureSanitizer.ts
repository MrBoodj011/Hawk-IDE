const SECRET_ASSIGNMENT =
  /\b(api[_-]?key|authorization|cookie|credential|password|secret|token)\b\s*[:=]\s*["']?[^\s"',;}]+/gi;
const AUTH_HEADER = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const PROVIDER_TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,})\b/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const CREDENTIAL_URL = /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi;

export function sanitizeTerminalChunk(value: string): string {
  return redactTerminalSecrets(stripTerminalControlSequences(String(value ?? '')));
}

export function sanitizeTerminalRecord(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const cleaned = redactTerminalSecrets(stripTerminalControlSequences(String(value ?? '')))
    .replace(/\r\n?/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  const limit = Math.max(256, Math.floor(maxChars));
  if (cleaned.length <= limit) return { text: cleaned, truncated: false };
  return {
    text: cleaned.slice(cleaned.length - limit),
    truncated: true,
  };
}

export function redactTerminalSecrets(value: string): string {
  return value
    .replace(AUTH_HEADER, '[REDACTED_AUTH]')
    .replace(JWT, '[REDACTED_JWT]')
    .replace(PROVIDER_TOKEN, '[REDACTED_TOKEN]')
    .replace(AWS_KEY, '[REDACTED_AWS_KEY]')
    .replace(CREDENTIAL_URL, '$1[REDACTED]@')
    .replace(SECRET_ASSIGNMENT, '$1=[REDACTED]');
}

export function stripTerminalControlSequences(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current >= 0x40 && current <= 0x7e) break;
          index += 1;
        }
        continue;
      }
      if (next === 0x5d) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      index += 1;
      continue;
    }
    if (code === 0x08) {
      output = output.slice(0, -1);
      continue;
    }
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
      output += value[index];
    }
  }
  return output;
}
