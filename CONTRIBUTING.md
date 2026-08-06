# Contributing to Hawk Security IDE

Thank you for helping improve Hawk. Keep contributions focused, reviewable, and safe to run.

## Before you start

- Use Hawk only on systems you own or are explicitly authorized to test.
- Open an issue before a large architectural change so the approach can be agreed first.
- Never commit credentials, customer data, exploit targets, private traffic, or generated evidence.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities in Hawk itself; do not disclose them in a public issue.

## Development

Hawk requires Node.js 24 and npm.

```bash
npm ci
npm run ci
```

For Docker orchestration changes, also run the strict soak test with a running Docker daemon:

```bash
docker pull node:20-alpine
npm run test:docker-soak -- --strict
```

Keep pull requests small, explain the user-visible impact, include tests for behavior changes, and update documentation when commands, policies, or interfaces change. By contributing, you agree that your work is licensed under the repository's Apache-2.0 license.

