import { describe, expect, it } from "bun:test";
import { getOAuthProviders } from "@gajae-code/ai/utils/oauth";
import { LoginDialogComponent } from "@gajae-code/coding-agent/modes/components/login-dialog";
import { OAuthSelectorComponent } from "@gajae-code/coding-agent/modes/components/oauth-selector";
import { ProviderOnboardingSelectorComponent } from "@gajae-code/coding-agent/modes/components/provider-onboarding-selector";
import type { AuthStorage } from "@gajae-code/coding-agent/session/auth-storage";
import type { TUI } from "@gajae-code/tui";

const fakeTui = { requestRender: () => undefined } as unknown as TUI;
const fakeAuthStorage = { hasAuth: () => false } as unknown as AuthStorage;

describe("provider registration flow", () => {
	it("lets every OAuth provider row be selected from the login selector", () => {
		const providers = getOAuthProviders();
		expect(providers.length).toBeGreaterThan(0);

		for (let index = 0; index < providers.length; index++) {
			let selectedProvider: string | undefined;
			const selector = new OAuthSelectorComponent(
				"login",
				fakeAuthStorage,
				providerId => {
					selectedProvider = providerId;
				},
				() => undefined,
			);
			for (let i = 0; i < index; i++) selector.handleInput("\u001b[B");
			selector.handleInput("\n");
			selector.stopValidation();
			expect(selectedProvider).toBe(providers[index]?.id);
		}
	});

	it("routes both provider onboarding choices", () => {
		const actions: string[] = [];
		const selector = new ProviderOnboardingSelectorComponent(
			action => actions.push(action),
			() => actions.push("cancel"),
		);

		selector.handleInput("\n");
		selector.handleInput("\u001b[B");
		selector.handleInput("\n");

		expect(actions).toEqual(["oauth-login", "api-guide"]);
	});

	it("shows login as an explicit dialog action instead of dumping or auto-opening a raw URL", () => {
		const dialog = new LoginDialogComponent(fakeTui, "google-antigravity", () => undefined);
		const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=test&response_type=code";

		dialog.showAuth(url, "Follow the provider sign-in flow.");
		const rendered = Bun.stripANSI(dialog.render(100).join("\n"));

		expect(rendered).toContain("Sign in required");
		expect(rendered).toContain("Open login");
		expect(rendered).toContain("Enter/o: open");
		expect(rendered).not.toContain("accounts.google.com/o/oauth2/v2/auth");
	});
});
