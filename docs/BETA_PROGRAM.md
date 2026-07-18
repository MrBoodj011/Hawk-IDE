# Hawk Beta program

Beta validates real workflows before Stable promotion. Beta users receive
signed prereleases from tags such as `v0.2.0-beta.1`; they are never silently
moved to Stable.

## Cohorts

- application-security engineers reviewing owned repositories
- authorized bug-bounty researchers testing in declared program scope
- developers using Hawk AI diff/apply/revert workflows
- teams exercising cloud RBAC, sync, licenses, and billing test mode

## Entry checklist

- participant accepts Beta terms and responsible-use policy
- OS, hardware, testing role, and intended workflow are recorded
- no production-only data is required
- participant knows how to stop agents and remove capture pairing
- feedback and security-report channels are confirmed

## Success gates

- zero open critical/high security findings
- Windows, Linux, Intel macOS, and Apple Silicon release jobs green
- successful install/update/rollback on the supported test matrix
- no cross-tenant or source-code telemetry events
- crash-free session and task-completion targets published before recruitment
- at least one complete repository-to-evidence-to-report workflow per cohort
- signing, notarization, auto-update, companion review, legal, support, and
  deletion requests exercised end to end

Use the Beta feedback issue form for usability or reliability reports and the
private security-advisory channel for vulnerabilities.
