import { RpcClient } from "@gajae-code/coding-agent";
import type { RpcBackendConfig, RpcBackendPort, RpcBackendState } from "./types";

type SocketSecurityModule = { prepareRpcSocketPath(socketPath: string): Promise<void> };

async function runSocketSecurityPreflight(socketPath: string): Promise<void> {
	const importer = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
	const security = (await importer(
		"@gajae-code/coding-agent/modes/rpc/rpc-socket-security.ts",
	)) as SocketSecurityModule;
	await security.prepareRpcSocketPath(socketPath);
}

export class RpcBackend implements RpcBackendPort {
	readonly #config: RpcBackendConfig;
	#client: RpcClient | null = null;
	#connected = false;

	constructor(config: RpcBackendConfig) {
		this.#config = config;
	}

	async connect(): Promise<void> {
		await runSocketSecurityPreflight(this.#config.socketPath);
		const client = new RpcClient({ transport: "uds", socketPath: this.#config.socketPath } as ConstructorParameters<
			typeof RpcClient
		>[0] & { transport: "uds"; socketPath: string });
		await client.start();
		this.#client = client;
		this.#connected = true;
	}

	async close(): Promise<void> {
		this.#client?.stop();
		this.#client = null;
		this.#connected = false;
	}

	async getState(): Promise<RpcBackendState> {
		const session = this.#client ? await this.#client.getState().catch(() => undefined) : undefined;
		return { connected: this.#connected, socketPath: this.#config.socketPath, session };
	}

	async prompt(_message: string): Promise<void> {
		// TODO(PR3): map Telegram idle text onto serialized RPC prompt control.
		throw new Error("telegram_remote_rpc_prompt_not_implemented");
	}

	async steer(_message: string): Promise<void> {
		// TODO(PR3): map Telegram mid-turn text onto serialized RPC steer control.
		throw new Error("telegram_remote_rpc_steer_not_implemented");
	}

	async abort(): Promise<void> {
		// TODO(PR3): wire /abort and abort buttons through the control state machine.
		throw new Error("telegram_remote_rpc_abort_not_implemented");
	}

	onEvents(): () => void {
		// TODO(PR5): subscribe to RPC events, gates, liveness, and final-answer delivery.
		return () => undefined;
	}
}

export class FakeRpcBackend implements RpcBackendPort {
	connected = false;
	connectCalls = 0;
	closeCalls = 0;
	state: RpcBackendState;

	constructor(socketPath = "/tmp/gjc-rpc.sock") {
		this.state = { connected: false, socketPath };
	}

	async connect(): Promise<void> {
		this.connectCalls += 1;
		this.connected = true;
		this.state = { ...this.state, connected: true };
	}

	async close(): Promise<void> {
		this.closeCalls += 1;
		this.connected = false;
		this.state = { ...this.state, connected: false };
	}

	async getState(): Promise<RpcBackendState> {
		return { ...this.state };
	}
}
