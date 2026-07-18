# Hawk desktop update service

The worker translates the versioned `update.json` attached to a Hawk GitHub
Release into the native Code-OSS update API and privately proxies installer
downloads. This lets a private GitHub repository ship signed desktop updates
without exposing a repository token to clients.

The same Worker serves two isolated release channels:

- `stable`: numbered, non-prerelease tags such as `v1.2.3`
- `beta`: signed GitHub prereleases such as `v1.3.0-beta.2` or `v1.3.0-rc.1`

Native Code-OSS builds use the `stable` quality for Stable and `insider`
quality for Beta; the Worker maps `insider` to the Hawk Beta channel.

Required Worker secret:

- `GITHUB_TOKEN`: fine-grained read-only access to releases in the Hawk repo.

Set the desktop build secret `HAWK_UPDATE_URL` to the deployed Worker origin,
without `/api/update`. Signed builds then use the native Code-OSS update state
machine on Windows and macOS. Linux users receive the latest AppImage download.
