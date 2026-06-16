# Full-Native Candidate Map

- Status: active (within-policy offload sweep)
- Machine-readable map: [`full-native-candidate-map.json`](./full-native-candidate-map.json)
- Source spec: [`.gjc/specs/deep-interview-full-native-offload-sweep.md`](../.gjc/specs/deep-interview-full-native-offload-sweep.md)
- Consensus plan: `.gjc/plans/ralplan/2026-06-15-1442-003e/pending-approval.md`

## Governing policy

This map ranks **within-policy** TypeScript→Rust offload candidates only. Every candidate must satisfy the existing Rust boundary and gate rules:

- [`native-ffi-optimization-policy.md`](./native-ffi-optimization-policy.md) — the six-gate rule for speculative algorithmic ports.
- [`porting-to-natives.md`](./porting-to-natives.md) — when/how to add a native binding.
- [`natives-binding-contract.md`](./natives-binding-contract.md) — N-API binding contract.
- [`scripts/check-rust-scope.ts`](../scripts/check-rust-scope.ts) — Rust is reserved for native bindings, OS/process/filesystem integration, or measured hot paths; this map adds **no** allowlist entry.
- [`hotspot-map-successor.md`](./hotspot-map-successor.md) — the closed CPU/memory hotspot program.

## Method

Candidates are native OS/process/filesystem bindings currently implemented in product TypeScript via ad-hoc `bun:ffi` / `readlink` / OS probing. They follow the standard porting guide (not the speculative-perf gates). A candidate is **land-now** only when it is a genuine OS-call boundary with a defined behavior-parity bar; otherwise it is **deferred** with a concrete `nextEvidenceAction`.

> **Do not reopen `cpu-hotspot-map.json`.** That CPU/memory hotspot program (H01–H11, M01–M05) is closed; it is exclusion/precedent history only.
>
> **The algorithmic-port class is deferred** until a `profilerSelfTime` artifact exists. The profiling corpus currently has zero captured profiler artifacts, so gate 2 of the FFI policy is unsatisfiable today.

## Candidates

| id | rank | file · symbol | policy class | decision | next evidence action |
|----|------|---------------|--------------|----------|----------------------|
| FN01 | 1 | `packages/tui/src/terminal.ts` · `#enableWindowsVTInput`/`#restoreWindowsVTInput` | native-binding: OS console mode | **land-now** | win32 CI build/load/shape/no-throw + conditional restore |
| FN02 | 2 | `packages/tui/src/ttyid.ts` · `getTtyPath` | native-binding: OS TTY/fs | **land-now** | POSIX `ttyname`/`readlink` parity + cross-platform non-TTY null |
| FN03 | 3 | `packages/coding-agent/src/config/file-lock.ts` · `withFileLock` | native-binding: fs lock + process liveness | deferred | design `flock`/`fcntl` vs `LockFileEx` semantics, stale-owner, rollback |
| FN04 | 4 | `packages/utils/src/which.ts` · `$which` | native-binding: executable resolver / OS path | deferred | define PATH/PATHEXT/toolchain parity vs `Bun.which` |

Each candidate carries a six-gate checklist (`corpusEvidence`, `selfTimeAttribution`, `measuredFfiOverhead`, `representativeWin`, `behaviorParity`, `operationalCost`) in the JSON map. For the land-now OS bindings, gates 1–4 are `not-required` (these are native bindings, not speculative perf ports); `behaviorParity` and `operationalCost` are required.

## Landed in this sweep

FN01 and FN02 land as N-API exports in `crates/pi-natives/src/terminal.rs` (`getTtyPath`, `enableWindowsVtInput`, `setConsoleInputMode`), consumed via guarded lazy lookups in `ttyid.ts`/`terminal.ts`. The native layer replaces only the OS call; TypeScript keeps orchestration (`getTerminalId` fallback, VT restore-on-teardown) and non-fatal behavior. FN03 and FN04 remain deferred.
