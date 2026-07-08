import { isEnoent, logger } from "@gajae-code/utils";
import CHANGELOG_TEXT from "../../CHANGELOG.md" with { type: "text" };

export interface ChangelogEntry {
	major: number;
	minor: number;
	patch: number;
	version: string;
	forkRevision: number;
	content: string;
}

interface ChangelogVersion {
	major: number;
	minor: number;
	patch: number;
	version: string;
	forkRevision: number;
}

const CHANGELOG_HEADING_VERSION_RE = /##\s+\[?((\d+)\.(\d+)\.(\d+)(?:-yousiki\.(\d+))?)\]?/;
const PACKAGE_VERSION_RE = /^v?((\d+)\.(\d+)\.(\d+)(?:-yousiki\.(\d+))?)$/;

function versionFromMatch(match: RegExpMatchArray): ChangelogVersion {
	const forkRevision = match[5] === undefined ? 0 : Number.parseInt(match[5], 10);
	return {
		version: match[1],
		major: Number.parseInt(match[2], 10),
		minor: Number.parseInt(match[3], 10),
		patch: Number.parseInt(match[4], 10),
		forkRevision: Number.isSafeInteger(forkRevision) ? forkRevision : 0,
	};
}

function parsePackageVersion(version: string): ChangelogVersion {
	const match = PACKAGE_VERSION_RE.exec(version.trim());
	if (!match) return { version: "0.0.0", major: 0, minor: 0, patch: 0, forkRevision: 0 };
	return versionFromMatch(match);
}

/**
 * Parse changelog entries from a CHANGELOG.md text body.
 * Scans for ## lines and collects content until next ## or EOF.
 * Pure and synchronous so it can be reused by the embedded display path.
 */
export function parseChangelogContent(content: string): ChangelogEntry[] {
	const lines = content.split("\n");
	const entries: ChangelogEntry[] = [];

	let currentLines: string[] = [];
	let currentVersion: ChangelogVersion | null = null;

	for (const line of lines) {
		// Check if this is a version header (## [x.y.z] ...)
		if (line.startsWith("## ")) {
			// Save previous entry if exists
			if (currentVersion && currentLines.length > 0) {
				entries.push({
					...currentVersion,
					content: currentLines.join("\n").trim(),
				});
			}

			// Try to parse version from this line
			const versionMatch = line.match(CHANGELOG_HEADING_VERSION_RE);
			if (versionMatch) {
				currentVersion = versionFromMatch(versionMatch);
				currentLines = [line];
			} else {
				// Reset if we can't parse version
				currentVersion = null;
				currentLines = [];
			}
		} else if (currentVersion) {
			// Collect lines for current version
			currentLines.push(line);
		}
	}

	// Save last entry
	if (currentVersion && currentLines.length > 0) {
		entries.push({
			...currentVersion,
			content: currentLines.join("\n").trim(),
		});
	}

	return entries;
}

/**
 * Parse changelog entries from a CHANGELOG.md file on disk.
 * Returns [] on ENOENT; logs and returns [] on other read/parse errors.
 */
export async function parseChangelog(changelogPath: string): Promise<ChangelogEntry[]> {
	try {
		const content = await Bun.file(changelogPath).text();
		return parseChangelogContent(content);
	} catch (error) {
		if (isEnoent(error)) {
			return [];
		}
		logger.error(`Warning: Could not parse changelog: ${error}`);
		return [];
	}
}

/**
 * Return changelog entries from the CHANGELOG.md that shipped with this binary.
 *
 * The text is embedded at build time via `with { type: "text" }`, so the
 * displayed changelog is deterministic across compiled binaries, source-tree
 * dev runs, and `GJC_PACKAGE_DIR` / `PI_PACKAGE_DIR` overrides (which scope to
 * optional package assets like docs/examples and do not influence the
 * binary-identity changelog).
 */
export function getDisplayChangelogEntries(): ChangelogEntry[] {
	return parseChangelogContent(CHANGELOG_TEXT);
}

export function getInstalledVersionChangelogEntry(
	entries: readonly ChangelogEntry[],
	installedVersion: string,
): ChangelogEntry | undefined {
	const parsed = parsePackageVersion(installedVersion);
	return (
		entries.find(entry => entry.version === parsed.version) ??
		entries.find(
			entry => entry.major === parsed.major && entry.minor === parsed.minor && entry.patch === parsed.patch,
		) ??
		entries[0]
	);
}

/**
 * Compare versions. Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 */
export function compareVersions(v1: ChangelogEntry, v2: ChangelogEntry): number {
	if (v1.major !== v2.major) return v1.major - v2.major;
	if (v1.minor !== v2.minor) return v1.minor - v2.minor;
	if (v1.patch !== v2.patch) return v1.patch - v2.patch;
	return v1.forkRevision - v2.forkRevision;
}

/**
 * Get entries newer than lastVersion
 */
export function getNewEntries(entries: ChangelogEntry[], lastVersion: string): ChangelogEntry[] {
	const last = {
		...parsePackageVersion(lastVersion),
		content: "",
	};

	return entries.filter(entry => compareVersions(entry, last) > 0);
}

// Re-export getChangelogPath from paths.ts for convenience
export { getChangelogPath } from "../config";
