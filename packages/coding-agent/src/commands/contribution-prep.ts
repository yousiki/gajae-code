import { Command, Flags } from "@gajae-code/utils/cli";
import { prepareContributionPrep } from "../session/contribution-prep";

function writeText(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

export default class ContributionPrep extends Command {
	static description = "Dump redacted context and prepare a fresh contribution-prep worker prompt";
	static strict = false;

	static flags = {
		spawn: Flags.boolean({ description: "Spawn a fresh GJC worker after writing artifacts", default: false }),
		"source-session-id": Flags.string({ description: "Source session id to record in the manifest" }),
		"artifact-root": Flags.string({ description: "Directory where contribution-prep artifacts are written" }),
	};

	static examples = ["gjc contribution-prep", "gjc contribution-prep --spawn"];

	async run(): Promise<void> {
		const { flags } = await this.parse(ContributionPrep);
		const cwd = process.cwd();
		const result = await prepareContributionPrep(
			{
				sessionId: flags["source-session-id"] ?? "cli",
				cwd,
				messages: [],
			},
			{
				spawnWorker: flags.spawn ?? false,
				artifactRoot: flags["artifact-root"],
			},
		);
		writeText([
			"Contribution prep artifacts written.",
			`Manifest: ${result.manifestPath}`,
			`Worker prompt: ${result.workerPromptPath}`,
			`Spawned worker: ${result.spawned ? "yes" : "no"}`,
		]);
	}
}
