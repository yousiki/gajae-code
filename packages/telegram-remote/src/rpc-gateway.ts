import { parseCommand } from "./commands";
import { MESSAGES } from "./messages";
import type { RpcAttachmentStore } from "./rpc-attachment-store";
import type {
	AttachmentRecord,
	ChatReply,
	IncomingMessage,
	IncomingUpdate,
	OutgoingReply,
	RpcBackendPort,
} from "./types";

export interface RpcGatewayPolicy {
	allowedUserIds: ReadonlySet<string>;
	allowedChatIds: ReadonlySet<string>;
	defaultSocketPath: string;
	allowAttachSocketArg: boolean;
}

export interface RpcGatewayDeps {
	backend: RpcBackendPort;
	attachments: RpcAttachmentStore;
	now?: () => number;
}

export class TelegramRpcGateway {
	readonly #policy: RpcGatewayPolicy;
	readonly #backend: RpcBackendPort;
	readonly #attachments: RpcAttachmentStore;
	readonly #now: () => number;

	constructor(policy: RpcGatewayPolicy, deps: RpcGatewayDeps) {
		this.#policy = policy;
		this.#backend = deps.backend;
		this.#attachments = deps.attachments;
		this.#now = deps.now ?? Date.now;
	}

	async handleUpdate(update: IncomingUpdate): Promise<OutgoingReply> {
		if (update.kind === "callback_query")
			return { kind: "callback_answer", callbackAnswer: { text: MESSAGES.callbackInvalid }, sendMessage: false };
		if (!this.isAuthorized(update.userId, update.chatId)) return this.chat(MESSAGES.unauthorized);
		return this.dispatchText(update);
	}

	private async dispatchText(message: IncomingMessage): Promise<ChatReply> {
		const command = parseCommand(message.text);
		switch (command.kind) {
			case "help":
			case "start":
				return this.chat("Commands: /attach, /detach, /status, /abort");
			case "attach":
				return this.attach(message, command.socketPath);
			case "detach":
				await this.#attachments.clear();
				return this.chat("Detached. Session keeps running.");
			case "status":
				return this.status();
			case "abort":
				return this.chat("Abort is not wired yet.");
			case "sessions":
			case "observe":
			case "presets":
			case "start_session":
			case "stop":
				return this.chat(MESSAGES.unknownCommand);
			default:
				return this.chat(MESSAGES.unknownCommand);
		}
	}

	private async attach(message: IncomingMessage, requestedSocketPath: string | null): Promise<ChatReply> {
		const socketPath =
			this.#policy.allowAttachSocketArg && requestedSocketPath
				? requestedSocketPath
				: this.#policy.defaultSocketPath;
		const attachment: AttachmentRecord = {
			chatId: message.chatId,
			userId: message.userId,
			socketPath,
			stale: false,
			controllerState: "connecting",
			pendingGateIds: [],
			deliveryIdentities: [],
			updatedAt: this.#now(),
		};
		await this.#attachments.set(attachment);
		await this.#backend.connect();
		return this.chat("Attached to RPC session.");
	}

	private async status(): Promise<ChatReply> {
		const attachment = this.#attachments.get();
		if (!attachment) return this.chat("Detached.");
		const state = await this.#backend.getState();
		return this.chat(state.connected ? "Attached." : "Attachment is stale.");
	}

	private isAuthorized(userId: string | null, chatId: string): boolean {
		return (userId !== null && this.#policy.allowedUserIds.has(userId)) || this.#policy.allowedChatIds.has(chatId);
	}

	private chat(text: string): ChatReply {
		return { kind: "chat", text };
	}
}
