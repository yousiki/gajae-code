import { describe, expect, it } from "bun:test";
import {
	createGjcHerdrMuxCapabilityServices,
	createGjcMuxCapabilityServices,
	createHerdrMuxCapabilityServices,
	type GjcHerdrAdapterInvoker,
	type GjcMuxOwnedPaneRef,
	type GjcMuxOwnedSessionRef,
	resolveGjcHerdrCommand,
	resolveGjcMuxBackend,
	resolveGjcMuxBackendCommand,
} from "@gajae-code/coding-agent/gjc-runtime/mux/index";

interface HerdrCall {
	argv: readonly string[];
	env: NodeJS.ProcessEnv;
}

const schema = {
	schemaVersion: 1,
	protocol: "herdr-gjc-mux-v1",
	commands: {
		launch: ["mux", "launch"],
		status: ["mux", "status"],
		tail: ["mux", "tail"],
		list: ["mux", "list"],
	},
};

function identity(overrides: Record<string, string> = {}): Record<string, string> {
	return {
		sessionId: "gjc_s123",
		socketPath: "/tmp/herdr.sock",
		workspaceId: "workspace-1",
		tabId: "tab-1",
		paneId: "pane-1",
		createdAt: "2026-07-08T01:02:03.000Z",
		...overrides,
	};
}

function launchRequest() {
	return {
		cwd: "/repo-a",
		project: "/repo-a",
		gjcSessionId: "s123",
		sessionStateFile: "/tmp/gjc-session.json",
		command: ["gjc", "agent"],
		env: { EXTRA_ENV: "1" },
		visible: false,
	};
}

function fakeHerdr(
	overrides: {
		launchIdentity?: Record<string, string>;
		statusIdentity?: Record<string, string>;
		schemaStdout?: string;
		failVersion?: boolean;
		tailStdout?: string;
		listStdout?: string;
		statusStdout?: string;
		statusPayload?: Record<string, unknown>;
	} = {},
) {
	const calls: HerdrCall[] = [];
	const invokeHerdr: GjcHerdrAdapterInvoker = (argv, env) => {
		calls.push({ argv: [...argv], env: { ...env } });
		if (argv[0] === "--version") {
			return overrides.failVersion
				? { exitCode: 127, stdout: "", stderr: "missing herdr" }
				: { exitCode: 0, stdout: "herdr 0.0.1\n", stderr: "" };
		}
		if (argv.join(" ") === "api schema --json") {
			return { exitCode: 0, stdout: overrides.schemaStdout ?? JSON.stringify(schema), stderr: "" };
		}
		if (argv[0] === "mux" && argv[1] === "launch") {
			return { exitCode: 0, stdout: JSON.stringify(identity(overrides.launchIdentity ?? {})), stderr: "" };
		}
		if (argv[0] === "mux" && argv[1] === "status") {
			return {
				exitCode: 0,
				stdout:
					overrides.statusStdout ??
					JSON.stringify({
						...identity(overrides.statusIdentity ?? {}),
						attached: false,
						windows: 1,
						panes: 1,
						...(overrides.statusPayload ?? {}),
					}),
				stderr: "",
			};
		}
		if (argv[0] === "mux" && argv[1] === "tail") {
			return {
				exitCode: 0,
				stdout: overrides.tailStdout ?? JSON.stringify({ lines: ["one", "two"], truncated: false }),
				stderr: "",
			};
		}
		if (argv[0] === "mux" && argv[1] === "list") {
			return {
				exitCode: 0,
				stdout: overrides.listStdout ?? JSON.stringify({ sessions: [identity()] }),
				stderr: "",
			};
		}
		return { exitCode: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
	};
	return { calls, invokeHerdr };
}

function selectedServices(fake = fakeHerdr()) {
	return {
		...fake,
		services: createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fake.invokeHerdr,
		}),
	};
}

describe("Herdr mux capability services", () => {
	it("keeps tmux as the default factory backend and does not call Herdr", () => {
		const calls: HerdrCall[] = [];
		const services = createGjcMuxCapabilityServices({
			env: {},
			invokeHerdr: (argv, env) => {
				calls.push({ argv, env });
				throw new Error("Herdr should not be invoked");
			},
		});

		expect(services.resolver.resolveBackend({})).toBe("tmux");
		expect(Object.keys(services)).not.toContain("runCommand");
		expect(calls).toHaveLength(0);
	});

	it("resolves backend and command env with fail-closed invalid backend values", () => {
		expect(resolveGjcMuxBackend({})).toBe("tmux");
		expect(resolveGjcMuxBackend({ GJC_MUX_BACKEND: "" })).toBe("tmux");
		expect(resolveGjcMuxBackend({ GJC_MUX_BACKEND: "TmUx" })).toBe("tmux");
		expect(resolveGjcMuxBackend({ GJC_MUX_BACKEND: "HeRdR" })).toBe("herdr");
		expect(resolveGjcHerdrCommand({})).toBe("herdr");
		expect(resolveGjcHerdrCommand({ GJC_HERDR_COMMAND: " /bin/herdr " })).toBe("/bin/herdr");
		expect(resolveGjcMuxBackendCommand({ GJC_MUX_BACKEND: "herdr", GJC_HERDR_COMMAND: "fake-herdr" })).toBe(
			"fake-herdr",
		);
		expect(() => resolveGjcMuxBackend({ GJC_MUX_BACKEND: "screen" })).toThrow("unsupported_mux_backend:screen");
	});

	it("fails closed when Herdr services are used without opt-in", async () => {
		const { calls, invokeHerdr } = fakeHerdr();
		const services = createHerdrMuxCapabilityServices({ env: {}, invokeHerdr });

		await expect(services.launch.launch(launchRequest())).rejects.toThrow("herdr_mux_backend_not_selected");
		expect(calls).toHaveLength(0);
	});

	it("fails closed for missing binary, malformed schema, and unsupported schema", async () => {
		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({ failVersion: true }).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("herdr_unavailable:missing herdr");
		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({ schemaStdout: "{" }).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("herdr_schema_parse_failed:");
		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({ schemaStdout: JSON.stringify({ ...schema, protocol: "other" }) }).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("unsupported_herdr_api_schema:protocol:other");
		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({
					schemaStdout: JSON.stringify({
						...schema,
						commands: {
							launch: schema.commands.launch,
							status: schema.commands.status,
							tail: schema.commands.tail,
						},
					}),
				}).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("unsupported_herdr_api_schema:commands.list");
	});

	it("probes version and schema before launch, status, tail, and list", async () => {
		const { calls, services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		await services.sessionReader.getSession(result.session);
		await services.tailReader.readTail({ pane: result.pane!, lines: 2 });
		await services.sessionReader.listSessions("/repo-a");

		expect(calls.map(call => call.argv.slice(0, 3))).toEqual([
			["--version"],
			["api", "schema", "--json"],
			["mux", "launch", "--json"],
			["--version"],
			["api", "schema", "--json"],
			["mux", "status", "--json"],
			["--version"],
			["api", "schema", "--json"],
			["mux", "status", "--json"],
			["--version"],
			["api", "schema", "--json"],
			["mux", "tail", "--json"],
			["--version"],
			["api", "schema", "--json"],
			["mux", "list", "--json"],
			["--version"],
			["api", "schema", "--json"],
			["mux", "status", "--json"],
		]);
	});

	it("launch pins the generated session and persists revalidated identity", async () => {
		const { calls, services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		const launchCall = calls.find(call => call.argv[0] === "mux" && call.argv[1] === "launch")!;

		expect(launchCall.argv).toEqual([
			"mux",
			"launch",
			"--json",
			"--session",
			"gjc_s123",
			"--cwd",
			"/repo-a",
			"--project",
			"/repo-a",
			"--gjc-session-id",
			"s123",
			"--state-file",
			"/tmp/gjc-session.json",
			"--",
			"gjc",
			"agent",
		]);
		expect(launchCall.env.EXTRA_ENV).toBe("1");
		expect(result.session).toMatchObject({
			backend: "herdr",
			gjcSessionId: "s123",
			sessionStateFile: "/tmp/gjc-session.json",
			project: "/repo-a",
			cwd: "/repo-a",
			providerIds: {
				backendSessionId: "gjc_s123",
				socketPath: "/tmp/herdr.sock",
				backendWorkspaceId: "workspace-1",
				backendTabId: "tab-1",
				backendPaneId: "pane-1",
			},
			ownership: { version: { proofKind: "herdr-metadata", backendVersion: "herdr 0.0.1" } },
		});
		expect(result.session.ownership.version.proofData).toContain("protocol=herdr-gjc-mux-v1");
		expect(result.pane?.backend).toBe("herdr");
	});

	it("refuses launch identity that does not match the pinned generated session", async () => {
		const { services } = selectedServices(fakeHerdr({ launchIdentity: { sessionId: "foreign-session" } }));

		await expect(services.launch.launch(launchRequest())).rejects.toThrow("herdr_identity_mismatch:backendSessionId");
	});

	it("getSession, listSessions, and tail use pinned session and HERDR_SOCKET_PATH", async () => {
		const { calls, services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		await services.sessionReader.getSession(result.session);
		await services.tailReader.readTail({ pane: result.pane!, lines: 7 });
		const listed = await services.sessionReader.listSessions();

		const statusCalls = calls.filter(call => call.argv[0] === "mux" && call.argv[1] === "status");
		const tailCall = calls.find(call => call.argv[0] === "mux" && call.argv[1] === "tail")!;
		const listCall = calls.find(call => call.argv[0] === "mux" && call.argv[1] === "list")!;
		expect(statusCalls.every(call => call.argv.includes("--session") && call.argv.includes("gjc_s123"))).toBe(true);
		expect(statusCalls.every(call => call.env.HERDR_SOCKET_PATH === "/tmp/herdr.sock")).toBe(true);
		expect(tailCall.argv).toContain("--session");
		expect(tailCall.argv).toContain("gjc_s123");
		expect(tailCall.argv).toContain("--lines");
		expect(tailCall.argv).toContain("7");
		expect(tailCall.argv).toContain("--pane");
		expect(tailCall.argv).toContain("pane-1");
		expect(tailCall.env.HERDR_SOCKET_PATH).toBe("/tmp/herdr.sock");
		expect(listCall.argv).toEqual(["mux", "list", "--json"]);
		expect(listed).toHaveLength(1);
	});

	it("refuses mismatched GJC ownership proof before Herdr status calls", async () => {
		const { calls, services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		const mismatchedSession: GjcMuxOwnedSessionRef = { ...result.session, project: "/other-repo" };

		await expect(services.sessionReader.getSession(mismatchedSession)).rejects.toThrow(
			"herdr_identity_mismatch:project",
		);
		expect(calls.filter(call => call.argv[0] === "mux" && call.argv[1] === "status")).toHaveLength(1);
	});

	it("requires persisted Herdr session refs to retain pane identity", async () => {
		const { services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		const providerIds = { ...result.session.providerIds };
		delete providerIds.backendPaneId;
		const missingPaneSession: GjcMuxOwnedSessionRef = { ...result.session, providerIds };

		await expect(services.sessionReader.getSession(missingPaneSession)).rejects.toThrow(
			"herdr_identity_missing:backendPaneId",
		);
	});

	it("fails closed when Herdr omits required identity metadata", async () => {
		const services = createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fakeHerdr({ launchIdentity: { createdAt: "" } }).invokeHerdr,
		});

		await expect(services.launch.launch(launchRequest())).rejects.toThrow("herdr_identity_missing:createdAt");
	});

	it("fails closed for malformed Herdr tail payloads", async () => {
		const fake = fakeHerdr({ tailStdout: JSON.stringify({ lines: ["ok", 42], truncated: false }) });
		const services = createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fake.invokeHerdr,
		});
		const result = await services.launch.launch(launchRequest());

		await expect(services.tailReader.readTail({ pane: result.pane!, lines: 2 })).rejects.toThrow(
			"herdr_tail_parse_failed:lines",
		);
	});

	it("fails closed for malformed Herdr list payloads", async () => {
		const fake = fakeHerdr({ listStdout: JSON.stringify({ sessions: ["not-a-session"] }) });
		const services = createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fake.invokeHerdr,
		});
		await services.launch.launch(launchRequest());

		await expect(services.sessionReader.listSessions()).rejects.toThrow("herdr_list_parse_failed:session:0");
	});

	it("fails closed for malformed Herdr status counts", async () => {
		const services = createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fakeHerdr({ statusPayload: { windows: "one" } }).invokeHerdr,
		});

		await expect(services.launch.launch(launchRequest())).rejects.toThrow("herdr_status_parse_failed:windows");
	});

	it("fails closed for malformed Herdr status JSON and attached values", async () => {
		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({ statusStdout: "{" }).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("herdr_status_parse_failed:");

		await expect(
			createGjcHerdrMuxCapabilityServices({
				env: { GJC_MUX_BACKEND: "herdr" },
				invokeHerdr: fakeHerdr({ statusPayload: { attached: "false" } }).invokeHerdr,
			}).launch.launch(launchRequest()),
		).rejects.toThrow("herdr_status_parse_failed:attached");
	});
	it("refuses status identity mismatches", async () => {
		const fake = fakeHerdr({ statusIdentity: { paneId: "other-pane" } });
		const services = createGjcHerdrMuxCapabilityServices({
			env: { GJC_MUX_BACKEND: "herdr" },
			invokeHerdr: fake.invokeHerdr,
		});
		const session: GjcMuxOwnedSessionRef = {
			backend: "herdr",
			gjcSessionId: "s123",
			sessionStateFile: "/tmp/gjc-session.json",
			project: "/repo-a",
			cwd: "/repo-a",
			providerIds: {
				backendSessionId: "gjc_s123",
				backendPaneId: "pane-1",
				socketPath: "/tmp/herdr.sock",
				backendWorkspaceId: "workspace-1",
				backendTabId: "tab-1",
			},
			ownership: {
				backend: "herdr",
				gjcSessionId: "s123",
				sessionStateFile: "/tmp/gjc-session.json",
				project: "/repo-a",
				cwd: "/repo-a",
				providerIds: {
					backendSessionId: "gjc_s123",
					backendPaneId: "pane-1",
					socketPath: "/tmp/herdr.sock",
					backendWorkspaceId: "workspace-1",
					backendTabId: "tab-1",
				},
				version: {
					schemaVersion: 1,
					contractVersion: "herdr-gjc-mux-v1",
					proofKind: "herdr-metadata",
					proofData: [],
				},
				validatedAt: "2026-07-08T01:02:03.000Z",
			},
		};

		await expect(services.sessionReader.getSession(session)).rejects.toThrow("herdr_identity_mismatch:backendPaneId");
	});

	it("reports explicit unsupported Phase 2 flows and exposes no generic runCommand surface", async () => {
		const { services } = selectedServices();
		const result = await services.launch.launch(launchRequest());
		const pane = result.pane as GjcMuxOwnedPaneRef;

		await expect(services.sessionMutator.attachSession(result.session)).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:sessionMutator.attachSession",
		);
		await expect(services.sessionMutator.closeSession(result.session)).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:sessionMutator.closeSession",
		);
		await expect(services.paneMutator.focusPane(pane)).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:paneMutator.focusPane",
		);
		await expect(services.paneMutator.sendText(pane, "hello")).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:paneMutator.sendText",
		);
		await expect(services.coordinatorDelivery.deliver({ pane, message: "hello" })).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:coordinatorDelivery.deliver",
		);
		await expect(services.lifecycle.create(launchRequest())).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:lifecycle.create",
		);
		await expect(services.lifecycle.resume(result.session)).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:lifecycle.resume",
		);
		await expect(services.lifecycle.close(result.session)).rejects.toThrow(
			"unsupported_mux_backend_flow:herdr:lifecycle.close",
		);
		await expect(services.gc.collect()).rejects.toThrow("unsupported_mux_backend_flow:herdr:gc.collect");
		await expect(
			services.gc.prune({ session: result.session, stale: true, removable: true, reason: "test" }),
		).rejects.toThrow("unsupported_mux_backend_flow:herdr:gc.prune");
		expect(Object.keys(services)).not.toContain("runCommand");
	});
});
