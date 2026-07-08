import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import {
	normalizeFileDependencySpec,
	normalizePublishScope,
	normalizePublishTag,
	packages as publishPackages,
	publishPackageNameForScope,
	resolvePublishDependency,
	sourcePackageNameForPublishScope,
} from "./ci-release-publish";
import {
	isForkReleaseVersion,
	nextForkReleaseVersion,
	parseForkReleaseVersion,
	upstreamBaseVersionOf,
	validateForkReleaseVersion,
} from "./release";

interface PackageManifest {
	name: string;
	version: string;
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	private?: boolean;
	repository?: {
		type?: string;
		url?: string;
		directory?: string;
	};
	bugs?: {
		url?: string;
	};
	optionalDependencies?: Record<string, string>;
	files?: string[];
	os?: string[];
	cpu?: string[];
	libc?: string[];
}

const repoRoot = path.join(import.meta.dir, "..");

async function readManifest(relativePath: string): Promise<PackageManifest> {
	return (await Bun.file(path.join(repoRoot, relativePath, "package.json")).json()) as PackageManifest;
}

describe("unscoped gajae-code package publication", () => {
	test("manifest exposes gjc and depends on the scoped CLI package", async () => {
		const aliasManifest = await readManifest("packages/gajae-code");
		const codingAgentManifest = await readManifest("packages/coding-agent");

		expect(aliasManifest.private).toBeUndefined();
		expect(aliasManifest.name).toBe("gajae-code");
		// The fork release script may bump every public package to an
		// upstream-version-plus-fork-revision form like 0.9.1-yousiki.1.
		// The wrapper and scoped CLI must still agree on the upstream base.
		expect(aliasManifest.version).toMatch(/^\d+\.\d+\.\d+(?:-yousiki\.\d+)?$/);
		expect(upstreamBaseVersionOf(aliasManifest.version)).toBe(upstreamBaseVersionOf(codingAgentManifest.version));
		expect(aliasManifest.bin).toEqual({ gjc: "bin/gjc.js" });
		expect(aliasManifest.dependencies?.["@gajae-code/coding-agent"]).toBe("catalog:");
		const wrapper = await Bun.file(path.join(repoRoot, "packages/gajae-code/bin/gjc.js")).text();
		expect(wrapper).toContain('import { runCli } from "@gajae-code/coding-agent/cli";');
		expect(wrapper).toContain("await runCli(process.argv.slice(2));");
	});

	test("release dependency normalization collapses repeated file prefixes", () => {
		expect(normalizeFileDependencySpec("file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:../packages/ai")).toBe("file:../packages/ai");
		expect(normalizeFileDependencySpec("file:file:file:///tmp/gajae-code/packages/ai")).toBe(
			"file:///tmp/gajae-code/packages/ai",
		);
		expect(normalizeFileDependencySpec("catalog:")).toBe("catalog:");
	});

	test("release publish tag defaults to latest for fork prereleases", () => {
		expect(normalizePublishTag()).toBe("latest");
		expect(normalizePublishTag("next")).toBe("next");
		expect(() => normalizePublishTag("")).not.toThrow();
		expect(() => normalizePublishTag("bad tag")).toThrow("Invalid GJC_PUBLISH_TAG");
	});

	test("fork publish scope rewrites package names and aliases workspace dependencies", async () => {
		const previousScope = process.env.GJC_PUBLISH_SCOPE;
		const codingAgentManifest = await readManifest("packages/coding-agent");
		const nativePlatformManifest = await readManifest("packages/natives-linux-x64");

		try {
			process.env.GJC_PUBLISH_SCOPE = "@yousiki-gajae-code";

			expect(normalizePublishScope("yousiki-gajae-code")).toBe("@yousiki-gajae-code");
			expect(publishPackageNameForScope("gajae-code")).toBe("@yousiki-gajae-code/gajae-code");
			expect(publishPackageNameForScope("@gajae-code/coding-agent")).toBe("@yousiki-gajae-code/coding-agent");
			expect(await resolvePublishDependency("@gajae-code/coding-agent", "catalog:")).toBe(
				`npm:@yousiki-gajae-code/coding-agent@${codingAgentManifest.version}`,
			);
			expect(await resolvePublishDependency("@gajae-code/natives-linux-x64", "workspace:*")).toBe(
				`npm:@yousiki-gajae-code/natives-linux-x64@${nativePlatformManifest.version}`,
			);
			expect(sourcePackageNameForPublishScope("@yousiki-gajae-code/natives-linux-x64", "@yousiki-gajae-code")).toBe(
				"@gajae-code/natives-linux-x64",
			);
			expect(sourcePackageNameForPublishScope("@yousiki-gajae-code/gajae-code", "@yousiki-gajae-code")).toBe(
				"gajae-code",
			);
			expect(await resolvePublishDependency("chalk", "catalog:")).toBe("^5.6.2");
		} finally {
			if (previousScope === undefined) {
				delete process.env.GJC_PUBLISH_SCOPE;
			} else {
				process.env.GJC_PUBLISH_SCOPE = previousScope;
			}
		}
	});

	test("published package repository metadata matches the fork for npm trusted publishing", async () => {
		for (const pkg of publishPackages) {
			const manifest = await readManifest(pkg.dir);
			expect(manifest.repository?.url).toBe("git+https://github.com/yousiki/gajae-code.git");
			expect(manifest.bugs?.url).toBe("https://github.com/yousiki/gajae-code/issues");
		}
	});

	test("release publish order publishes the alias after its scoped dependency", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();
		const codingAgentIndex = releaseScript.indexOf('dir: "packages/coding-agent"');
		const aliasIndex = releaseScript.indexOf('dir: "packages/gajae-code"');

		expect(codingAgentIndex).toBeGreaterThan(-1);
		expect(aliasIndex).toBeGreaterThan(codingAgentIndex);
	});

	test("native platform packages publish before the stable loader package", () => {
		const publishDirs = publishPackages.map((pkg) => pkg.dir);
		const nativesIndex = publishDirs.indexOf("packages/natives");
		const platformDirs = [
			"packages/natives-darwin-arm64",
			"packages/natives-linux-x64",
		];


		expect(nativesIndex).toBeGreaterThan(-1);
		for (const dir of platformDirs) {
			const platformIndex = publishDirs.indexOf(dir);
			expect(platformIndex).toBeGreaterThan(-1);
			expect(platformIndex).toBeLessThan(nativesIndex);
		}
	});

	test("release entrypoint primes workspace names before mutating manifests", async () => {
		const releaseScript = await Bun.file(path.join(repoRoot, "scripts/ci-release-publish.ts")).text();
		const primeIndex = releaseScript.indexOf("await primePublishMetadata();");
		const publishLoopIndex = releaseScript.lastIndexOf("for (const pkg of packages)");

		expect(primeIndex).toBeGreaterThan(-1);
		expect(publishLoopIndex).toBeGreaterThan(primeIndex);
	});

	test("stable natives package delegates binaries to optional platform packages", async () => {
		const manifest = await readManifest("packages/natives");
		expect(manifest.files).toEqual([
			"native/index.js",
			"native/index.d.ts",
			"native/loader-state.js",
			"native/loader-state.d.ts",
			"native/embedded-addon.js",
			"README.md",
		]);
		expect(manifest.files?.some((entry) => entry === "native" || entry.endsWith(".node"))).toBe(false);
		expect(manifest.optionalDependencies).toEqual({
			"@gajae-code/natives-darwin-arm64": "workspace:*",
			"@gajae-code/natives-linux-x64": "workspace:*",
		});

	});

	test("published native platform package manifests constrain host os and cpu", async () => {
		const cases: Array<[string, string, string]> = [
			["packages/natives-darwin-arm64", "darwin", "arm64"],
			["packages/natives-linux-x64", "linux", "x64"],
		];

		for (const [dir, os, cpu] of cases) {
			const manifest = await readManifest(dir);
			expect(manifest.os).toEqual([os]);
			expect(manifest.cpu).toEqual([cpu]);
			expect(manifest.files).toEqual(["native", "README.md"]);
		}
	});

	test("retired native platform packages are private", async () => {
		for (const dir of ["packages/natives-darwin-x64", "packages/natives-linux-arm64", "packages/natives-win32-x64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.private).toBe(true);
		}
	});


	test("release publish dry-run does not rewrite source manifests", async () => {
		const manifestPaths = [
			"packages/natives/package.json",
			"packages/coding-agent/package.json",
			"packages/stats/package.json",
		];
		const before = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		const proc = Bun.spawn(["bun", "scripts/ci-release-publish.ts", "--dry-run"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [exitCode, stdout, stderr] = await Promise.all([
			proc.exited,
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("DRY RUN stage pi_natives.linux-x64 into packages/natives-linux-x64/native");
		expect(stdout).not.toContain("Building Tailwind CSS");
		const after = await Promise.all(manifestPaths.map(async (relativePath) => await Bun.file(path.join(repoRoot, relativePath)).text()));
		expect(after).toEqual(before);
	});

	describe("fork release versioning", () => {
		test("accepts only upstream-version plus yousiki revision", () => {
			expect(isForkReleaseVersion("0.9.1-yousiki.1")).toBe(true);
			expect(isForkReleaseVersion("v0.9.1-yousiki.1")).toBe(true);
			expect(isForkReleaseVersion("0.9.1")).toBe(false);
			expect(isForkReleaseVersion("0.9.1-fork.1")).toBe(false);
			expect(parseForkReleaseVersion("v0.9.1-yousiki.2")).toEqual({
				version: "0.9.1-yousiki.2",
				upstreamVersion: "0.9.1",
				revision: 2,
			});
		});

		test("derives the next fork revision from matching release tags", () => {
			expect(nextForkReleaseVersion("0.9.1", [])).toBe("0.9.1-yousiki.1");
			expect(
				nextForkReleaseVersion("0.9.1", [
					"v0.9.1",
					"v0.9.1-yousiki.1",
					"v0.9.1-yousiki.3",
					"v0.9.2-yousiki.9",
				]),
			).toBe("0.9.1-yousiki.4");
		});

		test("requires the current upstream base and the next consecutive fork revision", () => {
			expect(validateForkReleaseVersion("0.9.1-yousiki.1", "0.9.1", [])).toMatchObject({
				version: "0.9.1-yousiki.1",
				upstreamVersion: "0.9.1",
				revision: 1,
			});
			expect(validateForkReleaseVersion("0.9.1-yousiki.2", "0.9.1-yousiki.1", ["v0.9.1-yousiki.1"]))
				.toMatchObject({
					version: "0.9.1-yousiki.2",
					upstreamVersion: "0.9.1",
					revision: 2,
				});
			expect(() => validateForkReleaseVersion("0.9.2-yousiki.1", "0.9.1", [])).toThrow("current package base");
			expect(() => validateForkReleaseVersion("0.9.1-yousiki.3", "0.9.1", ["v0.9.1-yousiki.1"])).toThrow(
				"expected 0.9.1-yousiki.2",
			);
		});
	});
});

describe("release bump set equals publish set", () => {
	test("every non-private packages/* manifest is published, and every published dir is non-private", async () => {
		const { Glob } = await import("bun");

		// release.ts bumps the version of EVERY non-private packages/*/package.json.
		const bumpableDirs = new Set<string>();
		const glob = new Glob("packages/*/package.json");
		for await (const rel of glob.scan(repoRoot)) {
			const manifest = (await Bun.file(path.join(repoRoot, rel)).json()) as PackageManifest;
			if (manifest.private === true) continue;
			bumpableDirs.add(path.dirname(rel));
		}

		// ci-release-publish.ts publishes exactly the dirs in its exported `packages` array.
		const publishDirs = new Set<string>(publishPackages.map((pkg) => pkg.dir));

		expect(bumpableDirs.size).toBeGreaterThan(0);
		// Any non-private package that release.ts bumps but the publisher omits would
		// ship a 0.x tag whose npm version never advances. Any published dir that is
		// private would be skipped at publish time. Both break one-release-truth.
		expect([...publishDirs].sort()).toEqual([...bumpableDirs].sort());
	});
});

describe("native release binary coverage", () => {
	test("release workflow only ships macOS arm64 and Linux x64 artifacts", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		expect(workflow).toContain("{ os: macos-26, platform: darwin, arch: arm64 }");
		expect(workflow).toContain("target_id: darwin-arm64");
		expect(workflow).toContain("os: ubuntu-26.04,");
		expect(workflow).toContain("target_id: linux-x64");
		expect(workflow).toContain("pattern: pi-natives-${{ matrix.platform }}-${{ matrix.arch }}*-h${{ needs.rust-hash.outputs.hash }}");

		expect(workflow).not.toContain("target_id: darwin-x64");
		expect(workflow).not.toContain("target_id: linux-arm64");
		expect(workflow).not.toContain("target_id: win32-x64");
		expect(workflow).not.toContain("binary_path: packages/coding-agent/binaries/gjc-darwin-x64");
		expect(workflow).not.toContain("binary_path: packages/coding-agent/binaries/gjc-linux-arm64");
		expect(workflow).not.toContain("binary_path: packages/coding-agent/binaries/gjc-windows-x64.exe");
		expect(workflow).not.toContain("ubuntu-22.04");
		expect(workflow).not.toContain("ubuntu-24.04-arm");
		expect(workflow).not.toContain("ubuntu-26.04-arm");
		expect(workflow).not.toContain("windows-latest");
	});


	test("linux native platform packages declare their glibc requirement", async () => {
		// The linux native addons are built against *-unknown-linux-gnu targets
		// only (see the ci.yml build matrix), so the platform packages must set
		// "libc" to keep npm/bun from installing a glibc-linked .node on musl
		// systems (e.g. Alpine), where dlopen fails with raw relocation errors.
		for (const dir of ["packages/natives-linux-x64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toEqual(["glibc"]);
		}

		// libc is a linux-only selector; other platform packages must not set it.
		for (const dir of ["packages/natives-darwin-arm64", "packages/natives-darwin-x64", "packages/natives-win32-x64"]) {
			const manifest = await readManifest(dir);
			expect(manifest.libc).toBeUndefined();
		}
	});

	test("release workflow publishes npm packages under the fork scope with trusted publishing", async () => {
		const workflow = await Bun.file(path.join(repoRoot, ".github/workflows/ci.yml")).text();

		expect(workflow).toContain('GJC_PUBLISH_SCOPE: "@yousiki-gajae-code"');
		expect(workflow).toContain("id-token: write");
		expect(workflow).toContain("run: npm install -g npm@^11.5.1");
		expect(workflow).toContain("run: bun run ci:release:publish");
		expect(workflow).not.toContain("NPM_TOKEN");
		expect(workflow).not.toContain("NODE_AUTH_TOKEN");
		expect(workflow).not.toContain("Configure npm auth");
	});

	test("installer explains missing release assets with fallback guidance", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install.sh")).text();

		expect(installer).toContain("No prebuilt GJC binary was found for ${PLATFORM}-${ARCH} in ${LATEST}.");
		expect(installer).toContain("Re-run this installer with --source");
		expect(installer).toContain("Expected asset URL: $BINARY_URL");
	});

	test("install tarball smoke includes linux x64 optional natives package", async () => {
		const installer = await Bun.file(path.join(repoRoot, "scripts/install-tests/run-ci.sh")).text();
		expect(installer).toContain("stage_linux_x64_optional_package");
		expect(installer).toContain("for pkg in utils natives-linux-x64 natives ai agent tui stats coding-agent gajae-code");
		expect(installer).toContain("@gajae-code/natives-linux-x64");
		expect(installer).toContain("gajae-code-natives-[0-9]*.tgz");
	});
});
