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
| Malicious artifact substitution | private releases, SHA-256 checksums, required Windows signature on production updates, pinned build inputs, downgrade/redirect checks |
| Prompt/tool injection | permission gates, scoped missions, untrusted-output handling, MCP isolation, diff review |
| Provider-key exposure | environment-variable key indirection, local config, secret redaction, no Hawk cloud |
| Malicious capture content | localhost socket + Host validation, pairing token, size limits, sanitization, no-store JSON responses, evidence redaction |
| Persistence path attack | workspace-bound `.hawk` paths, symlink/junction refusal, private state files, exact preimage checks, artifact-tree validation |
| Unsafe parallel execution | Docker isolation, resource budgets, approval gates, digest-pinned images, durable task state, recovery leases |
| Unsafe or misleading reproduction | expiring exact-plan hash, explicit approval, immutable source location, read-only filesystems, zero network, dropped capabilities, negative control, bounded runtime, no automatic verification |
| Replay scope or header injection | exact normalized host and port, rejection of URL userinfo/path/query/fragment authority tricks, forbidden forwarding headers, CR/LF rejection, no redirects, approval hash bound to credential bytes |
| Restricted-egress bypass | authenticated proxy, exact normalized host/port allowlist, HTTP method allowlist, absolute HTTP URL only, bounded headers/timeouts/connections, wildcard suffix lookalike tests |
| Debug data leakage | explicit export approval, normalized routes without queries, bounded in-memory traces, secret-shaped metadata rejection, no source/prompts/bodies/tokens/absolute workspace path, SHA-256 manifest |
| State rollback or unsafe migration | versioned readers, future-version rejection, conservative defaults, legacy Docker bridge migrated to no-network |
| CI credential compromise | least-privilege workflow permissions and no secret values in artifacts |

## Personal validation

Before trusting Hawk on sensitive work, review extension boundaries, MCP
container isolation, diff/apply/revert integrity, capture pairing, secret
redaction, and the Windows artifact checksum on the machine that will run it.
