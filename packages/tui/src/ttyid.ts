import * as natives from "@gajae-code/natives";

// The `@gajae-code/natives` loader validates only the package version sentinel,
// not that each individual export exists, so an older cached `.node` may not
// expose `getTtyPath`. Treat it as optional and fall back to `null` when it is
// unavailable, mirroring the previous non-fatal behavior.
const nativeGetTtyPath = (natives as { getTtyPath?: () => string | null }).getTtyPath;

/**
 * Resolve the TTY device path for stdin (fd 0) via the native binding.
 *
 * Returns the device path (e.g. `/dev/pts/3`) on Linux/macOS, or `null` on
 * Windows, non-TTY stdin (pipe/socket), or when the native export is
 * unavailable. The native implementation owns the OS call; this wrapper keeps
 * the lookup non-fatal.
 */
export function getTtyPath(): string | null {
	if (typeof nativeGetTtyPath !== "function") {
		return null;
	}
	try {
		return nativeGetTtyPath();
	} catch {
		return null;
	}
}
/**
 * Get a stable identifier for the current terminal.
 * Uses the TTY device path (e.g., /dev/pts/3), falling back to environment
 * variables for terminal multiplexers or terminal emulators.
 * Returns null if no terminal can be identified (e.g., piped input).
 */
export function getTerminalId(): string | null {
	// Inside tmux the stdin TTY path is unstable (it tracks the attached
	// client, not the pane), which spawns duplicate sessions and breaks
	// /resume. Prefer the stable per-pane TMUX_PANE identifier instead.
	if (process.env.TMUX && process.env.TMUX_PANE) {
		return `tmux-${process.env.TMUX_PANE}`;
	}

	// TTY device path — most reliable, unique per terminal tab
	if (process.stdin.isTTY) {
		try {
			const ttyPath = getTtyPath();
			if (ttyPath?.startsWith("/dev/")) {
				return ttyPath.slice(5).replace(/\//g, "-"); // /dev/pts/3 -> pts-3
			}
		} catch {}
	}

	// Fallback to terminal-specific env vars
	const kittyId = process.env.KITTY_WINDOW_ID;
	if (kittyId) return `kitty-${kittyId}`;

	const tmuxPane = process.env.TMUX_PANE;
	if (tmuxPane) return `tmux-${tmuxPane}`;

	const terminalSessionId = process.env.TERM_SESSION_ID; // macOS Terminal.app
	if (terminalSessionId) return `apple-${terminalSessionId}`;

	const wtSession = process.env.WT_SESSION; // Windows Terminal
	if (wtSession) return `wt-${wtSession}`;

	return null;
}
