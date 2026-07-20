/** Small SemVer comparator used by the private release feed updater. */
export function normalizeReleaseVersion(value: string): string {
  return value
    .trim()
    .replace(/^v/i, '')
    .replace(/-dev.*$/i, '');
}

/** Accept only release tags that can safely become a local update directory. */
export function isValidReleaseVersion(value: string): boolean {
  const withoutPrefix = value.trim().replace(/^v/i, '');
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(withoutPrefix);
}

export function compareReleaseVersions(left: string, right: string): number {
  const parse = (value: string): { numbers: number[]; prerelease: string[] } => {
    const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return { numbers: [0, 0, 0], prerelease: [] };
    return {
      numbers: [Number(match[1]), Number(match[2]), Number(match[3])],
      prerelease: match[4]?.split('.') ?? [],
    };
  };

  const leftParts = parse(normalizeReleaseVersion(left));
  const rightParts = parse(normalizeReleaseVersion(right));
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts.numbers[index] ?? 0) - (rightParts.numbers[index] ?? 0);
    if (difference !== 0) return difference;
  }

  // SemVer gives a normal release precedence over its prerelease, then
  // compares dot-separated identifiers numerically/lexically.
  if (leftParts.prerelease.length === 0 && rightParts.prerelease.length > 0) return 1;
  if (leftParts.prerelease.length > 0 && rightParts.prerelease.length === 0) return -1;
  for (
    let index = 0;
    index < Math.max(leftParts.prerelease.length, rightParts.prerelease.length);
    index += 1
  ) {
    const leftIdentifier = leftParts.prerelease[index];
    const rightIdentifier = rightParts.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumber = /^\d+$/.test(leftIdentifier) ? Number(leftIdentifier) : undefined;
    const rightNumber = /^\d+$/.test(rightIdentifier) ? Number(rightIdentifier) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}
