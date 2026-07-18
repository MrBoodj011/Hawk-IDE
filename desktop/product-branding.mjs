/**
 * Removes upstream product surfaces that do not belong in Hawk and applies the
 * local-first product identity. Kept separate so source preparation and local
 * portable validation use exactly the same rules.
 */
export function sanitizeHawkProduct(product, overrides = {}) {
  const branded = {
    ...product,
    ...overrides,
  };

  if (Array.isArray(branded.builtInExtensions)) {
    branded.builtInExtensions = branded.builtInExtensions.filter(
      (extension) => !String(extension?.name ?? '').toLowerCase().includes('copilot'),
    );
  }
  if (Array.isArray(branded.builtInExtensionsEnabledWithAutoUpdates)) {
    branded.builtInExtensionsEnabledWithAutoUpdates =
      branded.builtInExtensionsEnabledWithAutoUpdates.filter(
        (extensionId) => !String(extensionId).toLowerCase().includes('copilot'),
      );
  }

  for (const upstreamProductField of [
    'agentsTelemetryAppName',
    'onboardingKeymaps',
    'onboardingThemes',
    'sessionsWindowAllowedExtensions',
    'trustedExtensionAuthAccess',
    'voiceWsUrl',
  ]) {
    delete branded[upstreamProductField];
  }

  // Current Code-OSS imports its onboarding module during workbench bootstrap
  // and asserts that this compatibility object exists even when onboarding,
  // sign-in, Copilot downloads, and the built-in Chat UI are disabled. Keep the
  // object internal until upstream removes that eager assertion.

  branded.enableTelemetry = false;
  branded.showTelemetryOptOut = false;
  branded.openToWelcomeMainPage = false;
  return branded;
}
