#!/usr/bin/env bun
/**
 * Conservative changed-path relevance gate for expensive CI jobs.
 *
 * Emits `relevant=true|false` to $GITHUB_OUTPUT. `relevant=false` is produced
 * for pull_request runs with a known base SHA, and push runs with a known
 * before SHA, when EVERY changed path is provably irrelevant (markdown, docs/,
 * .gjc/). Any other event, missing data, or error fails open to
 * `relevant=true` so validation is never weakened by ambiguity.
 */

import { $ } from "bun";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const repoRoot = path.join(import.meta.dir, "..");

export interface Decision {
	relevant: boolean;
	reason: string;
}

export function isProvablyIrrelevant(changedPath: string): boolean {
	return changedPath.endsWith(".md") || changedPath.startsWith("docs/") || changedPath.startsWith(".gjc/");
}

export interface RelevanceEnv {
	GITHUB_EVENT_NAME?: string;
	GITHUB_BASE_SHA?: string;
	GITHUB_EVENT_BEFORE?: string;
	GITHUB_OUTPUT?: string;
}

type ChangedFilesLoader = (baseSha: string) => Promise<string[]>;

const zeroShaRe = /^0+$/;

function baseShaForEvent(env: RelevanceEnv): Decision & { baseSha?: string } {
	const eventName = env.GITHUB_EVENT_NAME ?? "";

	if (eventName === "pull_request") {
		const baseSha = env.GITHUB_BASE_SHA;
		if (!baseSha) {
			return { relevant: true, reason: "GITHUB_BASE_SHA missing; running everything" };
		}
		return { relevant: true, reason: "pull_request base SHA found", baseSha };
	}

	if (eventName === "push") {
		const beforeSha = env.GITHUB_EVENT_BEFORE;
		if (!beforeSha || zeroShaRe.test(beforeSha)) {
			return { relevant: true, reason: "GITHUB_EVENT_BEFORE missing or empty; running everything" };
		}
		return { relevant: true, reason: "push before SHA found", baseSha: beforeSha };
	}

	return { relevant: true, reason: `event '${eventName || "unknown"}' is not pull_request or push; running everything` };
}

export function decideChangedFilesRelevance(files: readonly string[]): Decision {
	if (files.length === 0) {
		return { relevant: true, reason: "empty diff against base; running everything" };
	}

	const relevantFiles = files.filter(file => !isProvablyIrrelevant(file));
	if (relevantFiles.length > 0) {
		return { relevant: true, reason: `relevant path changed: ${relevantFiles[0]}` };
	}

	return {
		relevant: false,
		reason: `all ${files.length} changed path(s) are provably irrelevant (*.md, docs/, .gjc/)`,
	};
}

async function changedFiles(baseSha: string): Promise<string[]> {
	await $`git fetch --no-tags --depth=1 origin ${baseSha}`.cwd(repoRoot).quiet().nothrow();
	const result = await $`git diff --name-only ${baseSha} HEAD`.cwd(repoRoot).quiet();
	return result.stdout.toString().split("\n").filter(Boolean);
}

export async function decideRelevance(
	env: RelevanceEnv = process.env,
	loadChangedFiles: ChangedFilesLoader = changedFiles,
): Promise<Decision> {
	const base = baseShaForEvent(env);
	if (!base.baseSha) {
		return { relevant: base.relevant, reason: base.reason };
	}

	const files = await loadChangedFiles(base.baseSha);
	return decideChangedFilesRelevance(files);
}

async function main(): Promise<void> {
	let decision: Decision;
	try {
		decision = await decideRelevance();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		decision = { relevant: true, reason: `relevance check failed (${message}); running everything` };
	}

	console.log(`ci-job-relevance: relevant=${decision.relevant} (${decision.reason})`);

	if (process.env.GITHUB_OUTPUT) {
		await fs.appendFile(process.env.GITHUB_OUTPUT, `relevant=${decision.relevant}\n`);
	}
}

if (import.meta.main) {
	await main();
}
