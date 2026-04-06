import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

import { CONFIG_PATH, loadConfig, saveConfig, type DiffApprovalConfig } from "./src/config.js";
import { detectLineEnding, generateDiffString, restoreLineEndings, stripBom } from "./src/diff-utils.js";
import { computeChangePreview, type ChangePreview, type PreviewToolName } from "./src/preview.js";
import { reviewChangePreview } from "./src/ui.js";

const STATUS_KEY = "pi-show-diffs";
const TOOL_CALL_REVIEWED_TOOLS = new Set<PreviewToolName>(["edit", "hashline_edit", "write"]);

interface PendingImmediateApply {
	preview: ChangePreview;
	afterText: string;
}

export default function showDiffsExtension(pi: ExtensionAPI) {
	let config = loadConfig();
	const pendingImmediateApplies = new Map<string, PendingImmediateApply>();

	function refreshConfig() {
		config = loadConfig();
	}

	function clearPendingState() {
		pendingImmediateApplies.clear();
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

	function queuePendingImmediateApply(toolCallId: string, preview: ChangePreview, afterText: string) {
		pendingImmediateApplies.set(toolCallId, { preview, afterText });
	}

	function consumePendingImmediateApply(toolCallId: string) {
		const pending = pendingImmediateApplies.get(toolCallId);
		if (!pending) return undefined;
		pendingImmediateApplies.delete(toolCallId);
		return pending;
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

	function shouldSkipReview(preview: ChangePreview) {
		if (preview.toolName !== "hashline_edit") return false;
		if (!preview.previewError) return false;

		// Hashline validation failures mean the real tool call will fail before changing
		// the file, so showing an approval modal adds friction without any benefit.
		return preview.beforeText === undefined || preview.afterText === undefined;
	}

	async function restoreReviewedFinalContent(absolutePath: string, afterText: string) {
		try {
			const raw = (await readFile(absolutePath)).toString("utf-8");
			const { bom, text } = stripBom(raw);
			return `${bom}${restoreLineEndings(afterText, detectLineEnding(text))}`;
		} catch {
			return afterText;
		}
	}

	async function applyReviewedAfterText(preview: ChangePreview, afterText: string): Promise<any> {
		const finalContent = await restoreReviewedFinalContent(preview.absolutePath, afterText);
		await mkdir(dirname(preview.absolutePath), { recursive: true });
		await writeFile(preview.absolutePath, finalContent, "utf-8");

		if (preview.toolName === "edit") {
			const diffResult = generateDiffString(preview.beforeText ?? "", afterText);
			return {
				content: [{ type: "text", text: `Successfully applied reviewed final contents to ${preview.path}.` }],
				details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
			};
		}

		return {
			content: [
				{
					type: "text",
					text:
						preview.toolName === "write"
							? `Successfully wrote ${Buffer.byteLength(finalContent, "utf-8")} bytes to ${preview.path}`
							: `Successfully applied reviewed final contents to ${preview.path}.`,
				},
			],
			details: undefined,
		};
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
		clearPendingState();
		updateStatus(ctx);
	});


	pi.on("tool_call", async (event, ctx) => {
		if (!ctx.hasUI) return;
		if (!TOOL_CALL_REVIEWED_TOOLS.has(event.toolName as PreviewToolName)) return;
		if (config.autoApprove) return;

		const preview = await computeChangePreview(event.toolName as PreviewToolName, event.input, ctx.cwd);
		if (!preview) return;
		if (shouldSkipReview(preview)) return;

		const decision = await reviewChangePreview(ctx, preview, {
			allowAfterEdit: true,
		});

		if (decision.action === "approve_and_enable_auto") {
			setConfig({ autoApprove: true }, ctx);
		}

		if (decision.action === "reject" || decision.action === "steer") {
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
				sendNoChangeFeedback(preview);
				return {
					block: true,
					reason: `No changes were applied to ${preview.path}; user kept the existing file contents.`,
				};
			}

			queuePendingImmediateApply(event.toolCallId, preview, decision.afterTextOverride);
		}
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "edit" && event.toolName !== "write" && event.toolName !== "hashline_edit") return;

		const pending = consumePendingImmediateApply(event.toolCallId);
		if (!pending) return;

		if (event.isError) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Reviewed inline edits for ${pending.preview.path} were not applied because the original ${pending.preview.toolName} call failed.`,
					"warning",
				);
			}
			return;
		}

		try {
			return await applyReviewedAfterText(pending.preview, pending.afterText);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (ctx.hasUI) {
				ctx.ui.notify(
					`Reviewed inline edits for ${pending.preview.path} could not be applied automatically: ${message}`,
					"warning",
				);
			}
			return {
				content: [
					...event.content,
					{
						type: "text",
						text: `Warning: reviewed inline edits for ${pending.preview.path} could not be applied automatically: ${message}`,
					},
				],
				details: event.details,
			};
		}
	});
}
