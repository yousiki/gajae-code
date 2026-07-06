import {
	getImageDimensions,
	type ImageDimensions,
	imageFallback,
	renderImage,
	TERMINAL,
} from "../terminal-capabilities";
import type { Component } from "../tui";

export interface ImageTheme {
	fallbackColor: (str: string) => string;
}

export interface ImageOptions {
	maxWidthCells?: number;
	maxHeightCells?: number;
	filename?: string;
	refetch?: () => string;
}

export class Image implements Component {
	#base64Data?: string;
	#mimeType: string;
	#dimensions: ImageDimensions;
	#theme: ImageTheme;
	#options: ImageOptions;

	#cachedLines?: string[];
	#cachedWidth?: number;

	constructor(
		base64Data: string,
		mimeType: string,
		theme: ImageTheme,
		options: ImageOptions = {},
		dimensions?: ImageDimensions,
	) {
		this.#base64Data = base64Data;
		this.#mimeType = mimeType;
		this.#theme = theme;
		this.#options = options;
		this.#dimensions = dimensions || getImageDimensions(base64Data, mimeType) || { widthPx: 800, heightPx: 600 };
	}

	invalidate(): void {
		this.#cachedLines = undefined;
		this.#cachedWidth = undefined;
	}

	get retainedBase64DataForTest(): string | undefined {
		return this.#base64Data;
	}

	#fallbackLines(): string[] {
		const fallback = imageFallback(this.#mimeType, this.#dimensions, this.#options.filename);
		return [this.#theme.fallbackColor(fallback)];
	}

	#getBase64Data(): string | undefined {
		if (this.#base64Data) return this.#base64Data;
		const refetched = this.#options.refetch?.();
		if (refetched) this.#base64Data = refetched;
		return this.#base64Data;
	}

	render(width: number): string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}

		const cap = this.#options.maxWidthCells;
		const maxWidth = cap != null && cap > 0 ? Math.min(width - 2, cap) : width - 2;

		let lines: string[];

		if (TERMINAL.imageProtocol) {
			const base64Data = this.#getBase64Data();
			if (!base64Data) {
				lines = this.#fallbackLines();
			} else {
				const result = renderImage(base64Data, this.#dimensions, {
					maxWidthCells: maxWidth,
					maxHeightCells: this.#options.maxHeightCells,
				});

				if (result) {
					// Return `rows` lines so TUI accounts for image height
					// First (rows-1) lines are empty (TUI clears them)
					// Last line: move cursor back up, then output image sequence
					lines = [];
					for (let i = 0; i < result.rows - 1; i++) {
						lines.push("");
					}
					// Move cursor up to first row, then output image
					const moveUp = result.rows > 1 ? `\x1b[${result.rows - 1}A` : "";
					lines.push(moveUp + result.sequence);
					this.#base64Data = undefined;
				} else {
					lines = this.#fallbackLines();
				}
			}
		} else {
			lines = this.#fallbackLines();
		}

		this.#cachedLines = lines;
		this.#cachedWidth = width;

		return lines;
	}
}
