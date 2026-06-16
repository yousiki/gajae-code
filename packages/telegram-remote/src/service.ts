/**
 * Service wiring: connect the Telegram transport to the gateway and the
 * coordinator client, and run the receive loop until stopped.
 */
import type { ServiceConfig } from "./config";
import { McpStdioCoordinatorClient } from "./coordinator-client";
import { TelegramRemoteGateway } from "./gateway";
import { TelegramRemoteNotifier } from "./notifier";
import { SubscriptionStore } from "./subscriptions";
import { TelegramBotApiTransport } from "./telegram";
import type { CoordinatorClient, TelegramTransport } from "./types";

/** Optional injection points for local runs and integration tests. */
export interface RunServiceOptions {
	coordinator?: CoordinatorClient;
	transport?: TelegramTransport;
}

/** Wire and run the gateway service until the transport loop ends. */
export async function runService(config: ServiceConfig, options: RunServiceOptions = {}): Promise<void> {
	const coordinator = options.coordinator ?? new McpStdioCoordinatorClient(config.coordinator);
	const transport =
		options.transport ??
		new TelegramBotApiTransport({
			botToken: config.botToken,
			apiBase: config.apiBase,
			pollTimeoutSec: config.pollTimeoutSec,
			enableEditMessageText: config.enableEditMessageText,
			registerBotCommands: config.registerBotCommands,
		});
	const shouldEnablePush = config.enablePush && config.stateDir !== undefined && typeof transport.send === "function";
	const subscriptions = shouldEnablePush
		? await SubscriptionStore.open({
				stateDir: config.stateDir!,
				followTtlMs: config.followTtlMs,
				maxSubscriptions: config.subscriptionsMax,
			})
		: undefined;
	const gateway = new TelegramRemoteGateway(
		{ ...config.policy, enablePush: shouldEnablePush },
		{ coordinator, subscriptions },
	);
	const notifier =
		shouldEnablePush && subscriptions && transport.send
			? new TelegramRemoteNotifier({
					coordinator,
					outbound: { send: transport.send.bind(transport) },
					subscriptions,
					renderCard: (rawSessionId, view, sub) =>
						gateway.renderNotificationCard(rawSessionId, view, { chatId: sub.chatId, userId: sub.userId }),
					longPollMs: config.longPollMs,
					digestThreshold: config.digestThreshold,
				})
			: undefined;

	const shutdown = (): void => {
		notifier?.stop();
		transport.stop();
	};
	process.once("SIGINT", shutdown);
	process.once("SIGTERM", shutdown);

	const notifierRun = notifier?.start();
	try {
		await transport.run(update => gateway.handleUpdate(update));
	} finally {
		notifier?.stop();
		process.off("SIGINT", shutdown);
		process.off("SIGTERM", shutdown);
		await notifierRun?.catch(() => undefined);
		await coordinator.close?.();
	}
}
