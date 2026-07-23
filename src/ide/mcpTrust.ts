import { createHash, createPublicKey, verify } from 'node:crypto';
import type { DurableStore } from './durableStore.js';
import { IDE_PROTOCOL_VERSION, type McpTrustVerdict } from './protocol.js';

export interface McpSignedManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  command: string;
  args?: string[];
  capabilities: string[];
  network: 'none' | 'loopback' | 'restricted';
  allowedHosts?: string[];
  publisher: string;
  artifactSha256: string;
  publicKeyPem?: string;
  signatureBase64?: string;
}

interface TrustPin {
  name: string;
  publisher: string;
  artifactSha256: string;
  publicKeySha256?: string;
  approvedBy: string;
  approvedAt: string;
}

export class McpTrustPlatform {
  constructor(
    private readonly store: DurableStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async inspect(manifestValue: unknown, actualArtifactSha256: string): Promise<McpTrustVerdict> {
    const manifest = parseManifest(manifestValue);
    const findings: string[] = [];
    if (manifest.artifactSha256 !== actualArtifactSha256.toLowerCase())
      findings.push('Artifact digest does not match the signed manifest');
    if (/\r|\n|[;&|><`$]/.test(manifest.command))
      findings.push('Command contains shell control characters');
    if ((manifest.args ?? []).some((arg) => arg.length > 2_000 || /[\r\n]/.test(arg)))
      findings.push('An MCP argument violates the bounded argument policy');
    if (
      manifest.network === 'restricted' &&
      sanitizeHosts(manifest.allowedHosts ?? []).length === 0
    )
      findings.push('Restricted network access requires an explicit host allowlist');

    let signature: McpTrustVerdict['signature'] = 'missing';
    if (manifest.publicKeyPem && manifest.signatureBase64) {
      try {
        const valid = verify(
          null,
          Buffer.from(signingPayload(manifest)),
          createPublicKey(manifest.publicKeyPem),
          Buffer.from(manifest.signatureBase64, 'base64'),
        );
        signature = valid ? 'verified' : 'invalid';
        if (!valid) findings.push('Ed25519 manifest signature is invalid');
      } catch {
        signature = 'invalid';
        findings.push('Manifest public key or signature cannot be verified');
      }
    }

    const pin = await this.store.readJson<TrustPin>('mcp-trust-pins', safeName(manifest.name));
    if (pin && pin.publisher !== manifest.publisher)
      findings.push('Publisher changed after trust was established');
    if (pin && pin.artifactSha256 !== manifest.artifactSha256)
      findings.push('Artifact changed after trust was established and needs re-approval');
    if (
      pin?.publicKeySha256 &&
      manifest.publicKeyPem &&
      pin.publicKeySha256 !== hash(manifest.publicKeyPem)
    )
      findings.push('Publisher signing key changed after trust was established');

    const denied = findings.some((finding) =>
      /does not match|control characters|invalid|Publisher changed|signing key changed/.test(
        finding,
      ),
    );
    const trusted = !denied && signature === 'verified' && Boolean(pin);
    const verdict: McpTrustVerdict = {
      protocolVersion: IDE_PROTOCOL_VERSION,
      name: manifest.name,
      version: manifest.version,
      artifactSha256: manifest.artifactSha256,
      manifestFingerprint: hash(canonicalManifest(manifest)),
      trusted,
      signature,
      decision: denied ? 'deny' : trusted ? 'allow' : 'require-approval',
      findings,
      capabilities: manifest.capabilities,
      checkedAt: this.now().toISOString(),
    };
    await this.store.writeJson('mcp-trust-verdicts', verdict.manifestFingerprint, verdict);
    return verdict;
  }

  async approve(
    manifestValue: unknown,
    actualArtifactSha256: string,
    approvedBy: string,
    approved: boolean,
  ): Promise<McpTrustVerdict> {
    if (!approved) throw new Error('Operator approval is required to trust an MCP artifact');
    if (!approvedBy.trim()) throw new Error('MCP trust approval requires a reviewer');
    const manifest = parseManifest(manifestValue);
    const inspected = await this.inspect(manifest, actualArtifactSha256);
    if (inspected.decision === 'deny') throw new Error(inspected.findings.join('; '));
    if (inspected.signature !== 'verified')
      throw new Error('Only a valid Ed25519-signed MCP manifest can be pinned');
    const pin: TrustPin = {
      name: manifest.name,
      publisher: manifest.publisher,
      artifactSha256: manifest.artifactSha256,
      ...(manifest.publicKeyPem ? { publicKeySha256: hash(manifest.publicKeyPem) } : {}),
      approvedBy: approvedBy.trim().slice(0, 160),
      approvedAt: this.now().toISOString(),
    };
    await this.store.writeJson('mcp-trust-pins', safeName(manifest.name), pin);
    return await this.inspect(manifest, actualArtifactSha256);
  }

  async posture(): Promise<{
    protocolVersion: number;
    pins: number;
    verdicts: number;
    allowed: number;
    requireApproval: number;
    denied: number;
  }> {
    const pins = await this.store.listJson<TrustPin>('mcp-trust-pins');
    const verdicts = await this.store.listJson<McpTrustVerdict>('mcp-trust-verdicts');
    return {
      protocolVersion: IDE_PROTOCOL_VERSION,
      pins: pins.length,
      verdicts: verdicts.length,
      allowed: verdicts.filter((verdict) => verdict.decision === 'allow').length,
      requireApproval: verdicts.filter((verdict) => verdict.decision === 'require-approval').length,
      denied: verdicts.filter((verdict) => verdict.decision === 'deny').length,
    };
  }
}

export function signingPayload(manifest: McpSignedManifest): string {
  return canonicalManifest({
    schemaVersion: manifest.schemaVersion,
    name: manifest.name,
    version: manifest.version,
    command: manifest.command,
    args: manifest.args ?? [],
    capabilities: manifest.capabilities,
    network: manifest.network,
    allowedHosts: sanitizeHosts(manifest.allowedHosts ?? []),
    publisher: manifest.publisher,
    artifactSha256: manifest.artifactSha256,
  });
}

function parseManifest(value: unknown): McpSignedManifest {
  if (!value || typeof value !== 'object') throw new Error('MCP manifest must be an object');
  const input = value as Partial<McpSignedManifest>;
  if (input.schemaVersion !== 1) throw new Error('Unsupported MCP trust manifest version');
  if (!input.name?.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.name))
    throw new Error('Invalid MCP server name');
  if (!input.version?.trim() || input.version.length > 80) throw new Error('Invalid MCP version');
  if (!input.command?.trim() || input.command.length > 1_000)
    throw new Error('Invalid MCP command');
  if (!input.publisher?.trim() || input.publisher.length > 200)
    throw new Error('Invalid MCP publisher');
  if (!input.artifactSha256 || !/^[a-fA-F0-9]{64}$/.test(input.artifactSha256))
    throw new Error('MCP artifact SHA-256 is required');
  if (!['none', 'loopback', 'restricted'].includes(input.network ?? ''))
    throw new Error('Invalid MCP network policy');
  return {
    schemaVersion: 1,
    name: input.name,
    version: input.version,
    command: input.command,
    args: Array.isArray(input.args) ? input.args.map(String).slice(0, 100) : [],
    capabilities: [...new Set((input.capabilities ?? []).map(String))].slice(0, 100),
    network: input.network as McpSignedManifest['network'],
    allowedHosts: sanitizeHosts(input.allowedHosts ?? []),
    publisher: input.publisher,
    artifactSha256: input.artifactSha256.toLowerCase(),
    ...(input.publicKeyPem ? { publicKeyPem: input.publicKeyPem } : {}),
    ...(input.signatureBase64 ? { signatureBase64: input.signatureBase64 } : {}),
  };
}

function sanitizeHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter(Boolean))]
    .filter((host) => /^[a-z0-9.-]+(?::\d{1,5})?$/.test(host))
    .sort()
    .slice(0, 100);
}

function canonicalManifest(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalManifest).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalManifest(item)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 128);
}
