import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { CONFIG_PATH, loadConfig, saveConfig, type DiffApprovalConfig } from "./src/config.js";
import { computeChangePreview, type PreviewToolName } from "./src/preview.js";
import { reviewChangePreview } from "./src/ui.js";

const STATUS_KEY = "pi-show-diffs";
const REVIEWED_TOOLS = new Set<PreviewToolName>(["edit", "hashline_edit", "write"]);

export default function showDiffsExtension(pi: ExtensionAPI) {
	let config = loadConfig();

	function refreshConfig() {
		config = loadConfig();
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			config.autoApprove ? ctx.ui.theme.fg("warning", "✍ auto-approve file changes") : undefined,
		);
	}

	function setConfig(next: DiffApprovalConfig, ctx?: ExtensionContext, notify = true) {
		config = next;
		saveConfig(config);
		if (!ctx) return;
		updateStatus(ctx);
		if (!notify || !ctx.hasUI) return;
		ctx.ui.notify(
			config.autoApprove ? "Auto-approve is ON for edit/write tools." : "Manual diff review is ON.",
			"info",
		);
	}

	async function handleCommand(args: string, ctx: ExtensionContext) {
		const command = args.trim().toLowerCase();

		if (command === "on" || command === "enable" || command === "auto") {
			setConfig({ autoApprove: true }, ctx);
			return;
		}

		if (command === "off" || command === "disable" || command === "manual") {
			setConfig({ autoApprove: false }, ctx);
			return;
		}

		if (command === "toggle") {
			setConfig({ autoApprove: !config.autoApprove }, ctx);
			return;
		}

		if (command === "status") {
			ctx.ui.notify(
				[
					"pi-show-diffs",
					`Mode: ${config.autoApprove ? "auto-approve" : "manual review"}`,
					`Config: ${CONFIG_PATH}`,
				].join("\n"),
				"info",
			);
			return;
		}

		const choice = await ctx.ui.select(
			[
				"pi-show-diffs",
				`Mode: ${config.autoApprove ? "auto-approve" : "manual review"}`,
				`Config: ${CONFIG_PATH}`,
			].join("\n"),
			[
				config.autoApprove ? "Turn auto-approve off" : "Turn auto-approve on",
				"Show status",
				"Cancel",
			],
		);

		if (choice === "Turn auto-approve on") {
			setConfig({ autoApprove: true }, ctx);
			return;
		}

		if (choice === "Turn auto-approve off") {
			setConfig({ autoApprove: false }, ctx);
			return;
		}

		if (choice === "Show status") {
			ctx.ui.notify(
				[
					"pi-show-diffs",
					`Mode: ${config.autoApprove ? "auto-approve" : "manual review"}`,
					`Config: ${CONFIG_PATH}`,
				].join("\n"),
				"info",
			);
		}
	}

	pi.registerCommand("diff-approval", {
		description: "Toggle or inspect diff approval mode",
		handler: handleCommand,
	});

	pi.registerCommand("show-diffs", {
		description: "Alias for /diff-approval",
		handler: handleCommand,
	});

	pi.on("session_start", async (_event, ctx) => {
		refreshConfig();
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshConfig();
		updateStatus(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshConfig();
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!REVIEWED_TOOLS.has(event.toolName as PreviewToolName)) return;
		if (config.autoApprove) return;

		const preview = await computeChangePreview(event.toolName as PreviewToolName, event.input, ctx.cwd);
		if (!preview) return;

		const decision = await reviewChangePreview(ctx, preview);

		if (decision.action === "approve") return;

		if (decision.action === "approve_and_enable_auto") {
			setConfig({ autoApprove: true }, ctx);
			return;
		}

		if (decision.action === "steer") {
			const feedback = decision.feedback?.trim();
			if (feedback) {
				try {
					pi.sendUserMessage(
						[
							`I rejected the proposed ${preview.toolName} change to ${preview.path}.`,
							`Please revise it like this:\n${feedback}`,
							"Do not retry the same file change unchanged.",
						].join("\n\n"),
						{ deliverAs: "steer" },
					);
				} catch {
					// Best-effort; the block reason below still gives the model useful context.
				}
			}

			return {
				block: true,
				reason: feedback
					? `Rejected by user after diff review for ${preview.path}. Feedback: ${feedback}`
					: `Rejected by user after diff review for ${preview.path}.`,
			};
		}

		return {
			block: true,
			reason: `Rejected by user after diff review for ${preview.path}.`,
		};
	});
}
