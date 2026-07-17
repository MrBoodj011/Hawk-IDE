# Hawk desktop update service

The worker translates the versioned `update.json` attached to a Hawk GitHub
Release into the native Code-OSS update API and privately proxies installer
downloads. This lets a private GitHub repository ship signed desktop updates
without exposing a repository token to clients.

Required Worker secret:

- `GITHUB_TOKEN`: fine-grained read-only access to releases in the Hawk repo.

Set the desktop build secret `HAWK_UPDATE_URL` to the deployed Worker origin,
without `/api/update`. Signed builds then use the native Code-OSS update state
machine on Windows and macOS. Linux users receive the latest AppImage download.
