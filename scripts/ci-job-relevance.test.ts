import { describe, expect, test } from "bun:test";
import { decideChangedFilesRelevance, decideRelevance, isProvablyIrrelevant } from "./ci-job-relevance";

describe("ci-job-relevance", () => {
	test("classifies markdown, docs, and .gjc paths as irrelevant", () => {
		expect(isProvablyIrrelevant("packages/coding-agent/CHANGELOG.md")).toBe(true);
		expect(isProvablyIrrelevant("docs/environment-variables.md")).toBe(true);
		expect(isProvablyIrrelevant(".gjc/plans/ralplan/example.md")).toBe(true);
		expect(isProvablyIrrelevant("scripts/ci-job-relevance.ts")).toBe(false);
	});

	test("skips expensive jobs for push changelog-only diffs", async () => {
		const seenBaseShas: string[] = [];
		const decision = await decideRelevance(
			{ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "abc123" },
			async (baseSha) => {
				seenBaseShas.push(baseSha);
				return ["packages/coding-agent/CHANGELOG.md", "packages/ai/CHANGELOG.md"];
			},
		);

		expect(seenBaseShas).toEqual(["abc123"]);
		expect(decision.relevant).toBe(false);
		expect(decision.reason).toContain("provably irrelevant");
	});

	test("keeps push source changes relevant", async () => {
		const decision = await decideRelevance(
			{ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "abc123" },
			async () => ["packages/coding-agent/src/main.ts"],
		);

		expect(decision).toEqual({
			relevant: true,
			reason: "relevant path changed: packages/coding-agent/src/main.ts",
		});
	});

	test("fails open for push events without a usable before SHA", async () => {
		const decision = await decideRelevance(
			{ GITHUB_EVENT_NAME: "push", GITHUB_EVENT_BEFORE: "0000000000000000000000000000000000000000" },
			async () => ["README.md"],
		);

		expect(decision).toEqual({
			relevant: true,
			reason: "GITHUB_EVENT_BEFORE missing or empty; running everything",
		});
	});

	test("still skips pull request docs-only diffs", () => {
		expect(decideChangedFilesRelevance(["docs/theme.md", "README.md"])).toEqual({
			relevant: false,
			reason: "all 2 changed path(s) are provably irrelevant (*.md, docs/, .gjc/)",
		});
	});
});
