import { randomUUID } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import { stableHash } from './scopePolicy.js';
import type { GovernedMemoryEntry, VerificationResult } from './smartTypes.js';

const SECRET_PATTERNS = [
  /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  /\bgh[opusr]_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

const POISON_PATTERNS = [
  /ignore (?:all |any )?(?:previous|prior|system) instructions/i,
  /reveal (?:the )?(?:system prompt|hidden instructions|secrets)/i,
  /disable (?:security|guardrails|policy|validation)/i,
  /send .{0,40} (?:token|secret|credential).{0,40} https?:\/\//i,
];

export class GovernedMemory {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async write(input: {
    layer: GovernedMemoryEntry['layer'];
    key: string;
    value: string;
    sourceUri: string;
    evidenceUris: string[];
    confidence: number;
    verified: boolean;
    reviewer: string;
    retentionDays?: number;
  }): Promise<GovernedMemoryEntry> {
    if (input.layer !== 'run' && !input.verified)
      throw new Error('Project and organization memory requires verified evidence');
    if (input.layer !== 'run') {
      const verifications = await this.store.listJson<VerificationResult>('verifications');
      const backedByVerifiedEvidence = verifications.some(
        (verification) =>
          verification.verified &&
          verification.evidenceUris.some((uri) => input.evidenceUris.includes(uri)),
      );
      if (!backedByVerifiedEvidence)
        throw new Error(
          'Project and organization memory requires evidence from a verified Hawk finding',
        );
    }
    if (!input.sourceUri.trim()) throw new Error('Memory requires a source URI');
    if (input.evidenceUris.length === 0)
      throw new Error('Memory requires at least one evidence URI');
    if (!input.key.trim() || !input.value.trim())
      throw new Error('Memory key and value are required');
    if (!input.reviewer.trim()) throw new Error('Memory reviewer is required');
    const combined = `${input.key}\n${input.value}`;
    if (SECRET_PATTERNS.some((pattern) => pattern.test(combined)))
      throw new Error('Memory rejected because it appears to contain a secret');
    if (POISON_PATTERNS.some((pattern) => pattern.test(combined)))
      throw new Error('Memory rejected by the prompt-injection guard');
    if (input.confidence < 0 || input.confidence > 1)
      throw new Error('Memory confidence must be between 0 and 1');
    const created = this.now();
    const retentionDays = Math.max(1, Math.min(input.retentionDays ?? 30, 3_650));
    const entry: GovernedMemoryEntry = {
      id: `memory-${randomUUID()}`,
      layer: input.layer,
      key: input.key.trim().slice(0, 200),
      value: input.value.trim().slice(0, 20_000),
      sourceUri: input.sourceUri.trim().slice(0, 2_000),
      evidenceUris: [...new Set(input.evidenceUris)].slice(0, 100),
      confidence: input.confidence,
      verified: input.verified,
      reviewer: input.reviewer.trim().slice(0, 160),
      createdAt: created.toISOString(),
      expiresAt: new Date(created.getTime() + retentionDays * 86_400_000).toISOString(),
      contentHash: stableHash({ key: input.key, value: input.value, source: input.sourceUri }),
    };
    await this.store.writeJson('memory', entry.id, entry);
    return entry;
  }

  async query(query: string, layer?: GovernedMemoryEntry['layer'], limit = 10) {
    const now = this.now().getTime();
    const tokens = tokenize(query);
    return (await this.store.listJson<GovernedMemoryEntry>('memory'))
      .filter((entry) => Date.parse(entry.expiresAt) > now)
      .filter((entry) => !layer || entry.layer === layer)
      .map((entry) => ({
        entry,
        score: tokens.reduce(
          (score, token) =>
            score +
            (entry.key.toLowerCase().includes(token) ? 3 : 0) +
            (entry.value.toLowerCase().includes(token) ? 1 : 0),
          0,
        ),
      }))
      .filter(({ score }) => tokens.length === 0 || score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.entry.confidence - a.entry.confidence ||
          b.entry.createdAt.localeCompare(a.entry.createdAt),
      )
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(({ entry }) => entry);
  }
}

function tokenize(value: string): string[] {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length > 2),
    ),
  ];
}
