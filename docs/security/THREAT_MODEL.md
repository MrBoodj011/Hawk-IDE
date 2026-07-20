# Hawk local threat model

## Trust boundaries

1. Desktop and local daemon: trusted user device; untrusted workspace, traffic,
   tool output, extension content, and MCP servers.
2. LLM providers: user-selected third parties receiving only selected context.
3. Release plane: the private GitHub repository and optional Windows signing.
4. Capture companions: untrusted HTTP messages crossing a rotating local
   pairing-token boundary.

## Highest-risk scenarios and controls

| Threat | Primary controls |
| --- | --- |
| Malicious artifact substitution | private releases, SHA-256 checksums, optional Windows signature, pinned build inputs |
| Prompt/tool injection | permission gates, scoped missions, untrusted-output handling, MCP isolation, diff review |
| Provider-key exposure | environment-variable key indirection, local config, secret redaction, no Hawk cloud |
| Malicious capture content | localhost pairing token, size limits, sanitization, evidence redaction |
| Unsafe parallel execution | Docker isolation, resource budgets, approval gates, durable task state |
| Unsafe or misleading reproduction | expiring exact-plan hash, explicit approval, immutable source location, read-only filesystems, zero network, dropped capabilities, negative control, bounded runtime, no automatic verification |
| CI credential compromise | least-privilege workflow permissions and no secret values in artifacts |

## Personal validation

Before trusting Hawk on sensitive work, review extension boundaries, MCP
container isolation, diff/apply/revert integrity, capture pairing, secret
redaction, and the Windows artifact checksum on the machine that will run it.
