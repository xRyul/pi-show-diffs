import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { CONFIG_PATH, loadConfig, saveConfig, type DiffApprovalConfig } from "./src/config.js";
import { computeChangePreview, type ChangePreview, type PreviewToolName } from "./src/preview.js";
import { reviewChangePreview } from "./src/ui.js";

const STATUS_KEY = "pi-show-diffs";
const TOOL_CALL_REVIEWED_TOOLS = new Set<PreviewToolName>(["edit", "hashline_edit", "write"]);

interface PendingEditedChange {
	absolutePath: string;
	afterText: string;
}

export default function showDiffsExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	let pendingEditedChanges: PendingEditedChange[] = [];

	function refreshConfig() {
		config = loadConfig();
	}

	function clearPendingEditedChanges() {
		pendingEditedChanges = [];
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
			config.autoApprove ? "Auto-approve is ON for file changes." : "Manual diff review is ON.",
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

	function getRejectionReason(preview: ChangePreview, feedback?: string) {
		return feedback
			? `Rejected by user after diff review for ${preview.path}. Feedback: ${feedback}`
			: `Rejected by user after diff review for ${preview.path}.`;
	}

	function sendSteerFeedback(preview: ChangePreview, feedback?: string) {
		if (!feedback) return;
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
			// Best-effort; the block reason still gives the model useful context.
		}
	}

	function queuePendingEditedChange(preview: ChangePreview, afterText: string) {
		pendingEditedChanges = pendingEditedChanges.filter((item) => item.absolutePath !== preview.absolutePath);
		pendingEditedChanges.unshift({ absolutePath: preview.absolutePath, afterText });
	}

	function hasPendingEditedChangeForPath(absolutePath: string) {
		return pendingEditedChanges.some((item) => item.absolutePath === absolutePath);
	}

	function clearPendingEditedChangeForPath(absolutePath: string) {
		pendingEditedChanges = pendingEditedChanges.filter((item) => item.absolutePath !== absolutePath);
	}

	function consumePendingEditedChange(preview: ChangePreview) {
		const index = pendingEditedChanges.findIndex(
			(item) => item.absolutePath === preview.absolutePath && item.afterText === preview.afterText,
		);
		if (index === -1) return false;
		pendingEditedChanges.splice(index, 1);
		return true;
	}

	function sendEditedContentFeedback(preview: ChangePreview, afterText: string) {
		const lineCount = afterText.split("\n").length;
		const trailingNewlineNote = afterText.endsWith("\n")
			? "The final content ends with a trailing newline."
			: "The final content does not end with a trailing newline.";

		try {
			pi.sendUserMessage(
				[
					`I edited the proposed final contents for ${preview.path}.`,
					"Apply exactly the final file content below and nothing else.",
					`Path: ${preview.path}`,
					`Expected final content: ${lineCount.toLocaleString()} line(s), ${afterText.length.toLocaleString()} chars.`,
					trailingNewlineNote,
					"<final_file_content>",
					afterText,
					"</final_file_content>",
					"Use a single file-change tool call that produces exactly that final file content. Prefer replacing the full file contents if needed to preserve the exact text.",
					"Do not retry the previous change unchanged.",
				].join("\n\n"),
				{ deliverAs: "steer" },
			);
		} catch {
			// Best-effort; the block reason still gives the model useful context.
		}
	}

	function sendNoChangeFeedback(preview: ChangePreview) {
		try {
			pi.sendUserMessage(
				[
					`I decided ${preview.path} should stay unchanged.`,
					"Do not retry the previous file change.",
					"Continue with the rest of the task if needed.",
				].join("\n\n"),
				{ deliverAs: "steer" },
			);
		} catch {
			// Best-effort; the block reason still gives the model useful context.
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
		clearPendingEditedChanges();
		updateStatus(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		refreshConfig();
		clearPendingEditedChanges();
		updateStatus(ctx);
	});

	pi.on("session_fork", async (_event, ctx) => {
		refreshConfig();
		clearPendingEditedChanges();
		updateStatus(ctx);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!TOOL_CALL_REVIEWED_TOOLS.has(event.toolName as PreviewToolName)) return;

		const preview = await computeChangePreview(event.toolName as PreviewToolName, event.input, ctx.cwd);
		if (!preview) return;

		if (consumePendingEditedChange(preview)) {
			return;
		}

		const hasPendingEditedChange = hasPendingEditedChangeForPath(preview.absolutePath);
		if (config.autoApprove && !hasPendingEditedChange) {
			return;
		}

		const decision = await reviewChangePreview(ctx, preview, {
			allowAfterEdit: preview.toolName !== "hashline_edit",
		});

		if (decision.action === "approve_and_enable_auto") {
			setConfig({ autoApprove: true }, ctx);
		}

		if (decision.action === "reject" || decision.action === "steer") {
			clearPendingEditedChangeForPath(preview.absolutePath);
			const feedback = decision.action === "steer" ? decision.feedback?.trim() : undefined;
			if (decision.action === "steer") {
				sendSteerFeedback(preview, feedback);
			}
			return {
				block: true,
				reason: getRejectionReason(preview, feedback),
			};
		}

		if (decision.afterTextOverride !== undefined) {
			if (preview.beforeText !== undefined && decision.afterTextOverride === preview.beforeText) {
				clearPendingEditedChangeForPath(preview.absolutePath);
				sendNoChangeFeedback(preview);
				return {
					block: true,
					reason: `No changes were applied to ${preview.path}; user kept the existing file contents.`,
				};
			}

			queuePendingEditedChange(preview, decision.afterTextOverride);
			sendEditedContentFeedback(preview, decision.afterTextOverride);
			return {
				block: true,
				reason: `User edited the approved final contents for ${preview.path}; waiting for a revised tool call.`,
			};
		}

		clearPendingEditedChangeForPath(preview.absolutePath);
	});
}
