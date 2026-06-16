//! Native terminal OS primitives: TTY device-path resolution and Windows
//! virtual-terminal console input mode.
//!
//! These replace ad-hoc `bun:ffi` / `readlink` OS calls in product TypeScript
//! (`packages/tui/src/ttyid.ts`, `packages/tui/src/terminal.ts`). The native
//! layer owns *only* the OS call boundary; TypeScript keeps orchestration,
//! fallback policy, and terminal lifecycle. All failures are non-fatal.
//!
//! # Platform
//! - `get_tty_path`: Linux reads `/proc/self/fd/0`; other Unix uses `ttyname(3)`;
//!   Windows / other return `None`.
//! - `enable_windows_vt_input` / `set_console_input_mode`: Windows console-mode
//!   helpers; no-ops off Windows.

use napi_derive::napi;

/// Result of enabling Windows virtual-terminal input mode.
///
/// `applied` is `true` when the console mode was read successfully (whether or
/// not a change was actually needed). `previous_mode` carries the original
/// console mode so the caller can restore it via [`set_console_input_mode`].
/// Off Windows, or on any failure, `applied` is `false` and `previous_mode`
/// is `0`.
#[napi(object)]
pub struct WindowsVtInputResult {
	pub applied:       bool,
	pub previous_mode: u32,
}

/// Resolve the TTY device path for stdin (fd 0).
///
/// Mirrors the previous TypeScript behavior exactly:
/// - **Linux**: `read_link("/proc/self/fd/0")`, returned only when it points
///   under `/dev/` (non-TTY / pipe / socket targets become `None`).
/// - **Other Unix**: `ttyname(3)` on fd 0.
/// - **Windows / other**: `None`.
///
/// Never panics; OS failures and non-UTF8 paths return `None`.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn get_tty_path() -> Option<String> {
	get_tty_path_impl()
}

#[cfg(target_os = "linux")]
fn get_tty_path_impl() -> Option<String> {
	let target = std::fs::read_link("/proc/self/fd/0").ok()?;
	let path = target.to_str()?;
	if path.starts_with("/dev/") {
		Some(path.to_owned())
	} else {
		None
	}
}

#[cfg(all(unix, not(target_os = "linux")))]
fn get_tty_path_impl() -> Option<String> {
	use std::ffi::CStr;

	// SAFETY: `ttyname` returns either null or a pointer to a static/thread-local
	// buffer owned by libc. We copy the bytes out into an owned `String` before
	// returning and make no further libc calls in between, so the pointer stays
	// valid for the read.
	unsafe {
		let ptr = libc::ttyname(0);
		if ptr.is_null() {
			return None;
		}
		Some(CStr::from_ptr(ptr).to_string_lossy().into_owned())
	}
}

#[cfg(not(unix))]
const fn get_tty_path_impl() -> Option<String> {
	None
}

/// Enable `ENABLE_VIRTUAL_TERMINAL_INPUT` on the Windows stdin console.
///
/// Returns the original console mode so the caller can restore it on teardown
/// via [`set_console_input_mode`]. No-op off Windows (`applied = false`). All
/// failures are non-fatal and reported as `applied = false`.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn enable_windows_vt_input() -> WindowsVtInputResult {
	enable_windows_vt_input_impl()
}

/// Restore a previously captured Windows stdin console mode.
///
/// No-op off Windows or when the stdin console handle is unavailable. Any
/// failure is swallowed (best-effort restore).
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn set_console_input_mode(previous_mode: u32) {
	set_console_input_mode_impl(previous_mode);
}

#[cfg(windows)]
fn enable_windows_vt_input_impl() -> WindowsVtInputResult {
	use windows_sys::Win32::{
		Foundation::INVALID_HANDLE_VALUE,
		System::Console::{
			ENABLE_VIRTUAL_TERMINAL_INPUT, GetConsoleMode, GetStdHandle, STD_INPUT_HANDLE,
			SetConsoleMode,
		},
	};

	let fail = WindowsVtInputResult { applied: false, previous_mode: 0 };

	// SAFETY: standard Win32 console calls. The stdin handle is validated against
	// null / INVALID_HANDLE_VALUE before use, `mode` is a live local that
	// `GetConsoleMode` writes through, and the result of each call is checked.
	unsafe {
		let handle = GetStdHandle(STD_INPUT_HANDLE);
		if handle.is_null() || handle == INVALID_HANDLE_VALUE {
			return fail;
		}
		let mut mode: u32 = 0;
		if GetConsoleMode(handle, &mut mode) == 0 {
			return fail;
		}
		let previous_mode = mode;
		let vt_mode = previous_mode | ENABLE_VIRTUAL_TERMINAL_INPUT;
		if vt_mode == previous_mode {
			return WindowsVtInputResult { applied: true, previous_mode };
		}
		if SetConsoleMode(handle, vt_mode) == 0 {
			return fail;
		}
		WindowsVtInputResult { applied: true, previous_mode }
	}
}

#[cfg(not(windows))]
const fn enable_windows_vt_input_impl() -> WindowsVtInputResult {
	WindowsVtInputResult { applied: false, previous_mode: 0 }
}

#[cfg(windows)]
fn set_console_input_mode_impl(previous_mode: u32) {
	use windows_sys::Win32::{
		Foundation::INVALID_HANDLE_VALUE,
		System::Console::{GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode},
	};

	// SAFETY: standard Win32 console calls. The stdin handle is validated before
	// use and the `SetConsoleMode` result is intentionally ignored (best-effort
	// restore during teardown).
	unsafe {
		let handle = GetStdHandle(STD_INPUT_HANDLE);
		if handle.is_null() || handle == INVALID_HANDLE_VALUE {
			return;
		}
		let _ = SetConsoleMode(handle, previous_mode);
	}
}

#[cfg(not(windows))]
const fn set_console_input_mode_impl(_previous_mode: u32) {}

#[cfg(all(test, unix))]
mod tests {
	use super::*;

	#[test]
	fn get_tty_path_non_tty_is_none_or_dev() {
		// In the test harness stdin is not an interactive TTY, so the result is
		// either None or, if a device is attached, a /dev/ path. It must never
		// be a non-/dev path and must never panic.
		match get_tty_path() {
			None => {}
			Some(path) => assert!(path.starts_with("/dev/"), "unexpected tty path: {path}"),
		}
	}

	#[cfg(not(windows))]
	#[test]
	fn windows_vt_helpers_are_noop_off_windows() {
		let result = enable_windows_vt_input();
		assert!(!result.applied);
		assert_eq!(result.previous_mode, 0);
		// Must not panic.
		set_console_input_mode(result.previous_mode);
	}
}
