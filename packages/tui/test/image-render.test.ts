import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Image } from "@gajae-code/tui/components/image";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	isWindowsTerminalPreviewSixelSupported,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@gajae-code/tui/terminal-capabilities";

type MutableTerminalInfo = {
	imageProtocol: ImageProtocol | null;
};

const terminal = TERMINAL as unknown as MutableTerminalInfo;
const BASE64_DUMMY = "AA==";
const SQUARE_DIMENSIONS = { widthPx: 100, heightPx: 100 };
const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

function parseKittyParam(sequence: string, key: "c" | "r"): number | null {
	const match = sequence.match(new RegExp(`${key}=(\\d+)`));
	if (!match) return null;
	return Number.parseInt(match[1], 10);
}

function parseITermWidth(sequence: string): string | null {
	const match = sequence.match(/width=([^;:]+)/);
	return match?.[1] ?? null;
}

describe("terminal image rendering", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = null;
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
	});

	it("fits Kitty images within max width and max height while preserving aspect ratio", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(2);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(2);
	});

	it("uses intrinsic image size when no bounds are provided", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS);

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "c")).toBe(10);
		expect(parseKittyParam(result?.sequence ?? "", "r")).toBe(10);
	});

	it("reduces iTerm2 width when max height is the limiting bound", () => {
		terminal.imageProtocol = ImageProtocol.Iterm2;
		const result = renderImage(BASE64_DUMMY, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(parseITermWidth(result?.sequence ?? "")).toBe("2");
		expect(result?.sequence).toContain("height=auto");
	});

	it("encodes SIXEL output when protocol is SIXEL", () => {
		terminal.imageProtocol = ImageProtocol.Sixel;
		const result = renderImage(BASE64_ONE_PIXEL_PNG, SQUARE_DIMENSIONS, {
			maxWidthCells: 10,
			maxHeightCells: 2,
		});

		expect(result).not.toBeNull();
		expect(result?.rows).toBe(2);
		expect(result?.sequence.startsWith("\x1bP")).toBe(true);
	});

	it("Image component forwards maxHeightCells to terminal rendering", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10, maxHeightCells: 2 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);

		expect(lines).toHaveLength(2);
		expect(lines[1]).toContain("\x1b[1A");
		expect(lines[1]).toContain("c=2");
		expect(lines[1]).toContain("r=2");
	});

	it("Image component releases source base64 after successful protocol render", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{ maxWidthCells: 10 },
			SQUARE_DIMENSIONS,
		);

		const lines = image.render(20);

		expect(lines[lines.length - 1]).toContain("\x1b_G");
		expect(image.retainedBase64DataForTest).toBeUndefined();
	});

	it("Image component refetches released base64 when an invalidated render needs re-encoding", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		let refetchCount = 0;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => text },
			{
				maxWidthCells: 10,
				refetch: () => {
					refetchCount++;
					return BASE64_DUMMY;
				},
			},
			SQUARE_DIMENSIONS,
		);

		image.render(20);
		image.invalidate();
		const lines = image.render(12);

		expect(refetchCount).toBe(1);
		expect(lines[lines.length - 1]).toContain("\x1b_G");
		expect(image.retainedBase64DataForTest).toBeUndefined();
	});

	it("Image component falls back gracefully after invalidation when released base64 cannot be refetched", () => {
		terminal.imageProtocol = ImageProtocol.Kitty;
		const image = new Image(
			BASE64_DUMMY,
			"image/png",
			{ fallbackColor: text => `fallback:${text}` },
			{ maxWidthCells: 10, filename: "sample.png" },
			SQUARE_DIMENSIONS,
		);

		image.render(20);
		image.invalidate();
		const lines = image.render(12);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("fallback:");
		expect(lines[0]).toContain("sample.png");
	});
});

describe("Windows Terminal Preview SIXEL detection", () => {
	it("requires Windows platform, WT session, and known version 1.22+", () => {
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"win32",
			),
		).toBe(true);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.21.0.0" },
				"win32",
			),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported({ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal" }, "win32"),
		).toBe(false);
		expect(
			isWindowsTerminalPreviewSixelSupported(
				{ WT_SESSION: "1", TERM_PROGRAM: "Windows_Terminal", TERM_PROGRAM_VERSION: "1.22.2362.0" },
				"linux",
			),
		).toBe(false);
	});
});
