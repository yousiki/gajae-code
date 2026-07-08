interface ComparableReleaseVersion {
	major: number;
	minor: number;
	patch: number;
	forkRevision: number;
}

const FORK_RELEASE_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-yousiki\.(\d+))?$/;

/**
 * Compare public release versions in fork-release order. A fork release like
 * 0.9.1-yousiki.1 is newer than its upstream base 0.9.1, and fork revisions
 * on the same base increase monotonically.
 */
export function compareReleaseVersions(a: string, b: string): number {
	const parsedA = parseComparableReleaseVersion(a);
	const parsedB = parseComparableReleaseVersion(b);
	if (parsedA && parsedB) return compareParsedReleaseVersions(parsedA, parsedB);
	return Bun.semver.order(a, b);
}

export function isReleaseVersionNewer(candidateVersion: string, currentVersion: string): boolean {
	return compareReleaseVersions(candidateVersion, currentVersion) > 0;
}

function parseComparableReleaseVersion(version: string): ComparableReleaseVersion | undefined {
	const match = FORK_RELEASE_VERSION_RE.exec(version.trim());
	if (!match) return undefined;
	const forkRevision = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
	return {
		major: Number.parseInt(match[1], 10),
		minor: Number.parseInt(match[2], 10),
		patch: Number.parseInt(match[3], 10),
		forkRevision: Number.isSafeInteger(forkRevision) ? forkRevision : 0,
	};
}

function compareParsedReleaseVersions(a: ComparableReleaseVersion, b: ComparableReleaseVersion): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	return a.forkRevision - b.forkRevision;
}
