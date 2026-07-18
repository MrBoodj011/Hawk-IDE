# Hawk Responsible Use Policy

Hawk is built for defensive development, authorized penetration testing, and
bug-bounty programs. Every target must be tied to permission the operator can
verify.

## Required controls

- record the owner, program, target scope, exclusions, testing window, and
  emergency contact before active testing
- use the least intrusive scan template and a documented rate limit
- keep human approval enabled for active, destructive, credentialed, or
  high-volume actions
- minimize captured personal data and redact evidence before sharing
- stop immediately on service degradation, unintended access, or scope doubt
- disclose findings through the target's approved channel

## Prohibited activity

Hawk must not be used for unauthorized access, data theft, extortion, malware,
denial of service, credential abuse, indiscriminate internet scanning,
surveillance, sanctions evasion, or evasion of security controls for harmful
purposes.

## AI and MCP responsibility

Agents and MCP tools act under the user's authority. Parallel workers do not
expand scope. The user must review plans, diffs, requests, evidence, and
reports. Do not give an untrusted MCP server secrets or host access. Use
immutable images, quotas, approval gates, and isolated workspaces.

Suspected abuse may result in suspension of Hawk Cloud access and preservation
of the minimum records required for investigation or law.
