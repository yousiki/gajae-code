import { describe, expect, it } from "bun:test";
import { compareReleaseVersions, isReleaseVersionNewer } from "../src/utils/release-version";

describe("release version ordering", () => {
	it("does not treat an upstream base release as newer than this fork revision", () => {
		expect(compareReleaseVersions("0.9.1", "0.9.1-yousiki.1")).toBeLessThan(0);
		expect(isReleaseVersionNewer("0.9.1", "0.9.1-yousiki.1")).toBe(false);
	});

	it("keeps fork revisions monotonic while allowing newer upstream bases", () => {
		expect(isReleaseVersionNewer("0.9.1-yousiki.2", "0.9.1-yousiki.1")).toBe(true);
		expect(isReleaseVersionNewer("0.9.2", "0.9.1-yousiki.99")).toBe(true);
	});
});
