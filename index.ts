import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsList, truncateToWidth, type SettingItem } from "@earendil-works/pi-tui";

import { CONFIG_PATH, DEFAULT_KEYBINDINGS, loadConfig, normalizeConfig, saveConfig, type DiffApprovalConfig, type DiffColorMode, type DiffKeybindings } from "./src/config.js";
import { detectLineEnding, generateDiffString, restoreLineEndings, stripBom } from "./src/diff-utils.js";
import { computeChangePreview, type ChangePreview, type PreviewToolName } from "./src/preview.js";
import { reviewChangePreview } from "./src/ui.js";
import { initI18n, t } from "./src/i18n.js";

const STATUS_KEY = "pi-show-diffs";
const TOOL_CALL_REVIEWED_TOOLS = new Set<PreviewToolName>(["edit", "hashline_edit", "write"]);

interface PendingImmediateApply {
	preview: ChangePreview;
	afterText: string;
}

export default function showDiffsExtension(pi: ExtensionAPI) {
	initI18n(pi);
	let config = loadConfig();
	const pendingImmediateApplies = new Map<string, PendingImmediateApply>();

	function refreshConfig() {
		config = loadConfig();
	}

	function clearPendingState() {
		pendingImmediateApplies.clear();
	}

	function getStatusLines() {
		return [
			"pi-show-diffs",
			`Mode: ${config.autoApprove ? t("mode.auto", "auto-approve") : t("mode.manual", "manual review")}`,
			`Diff colors: ${config.diffColorMode}`,
			`Diff rail: ${config.showDiffRail ? "on" : "off"}`,
			`Layout: ${config.expandableLayout ? "expandable" : "overlay"}`,
			`Collapsed height: ${config.collapsedHeight}`,
			`Expanded height: ${config.expandedHeight}`,
			`Expanded width: ${config.expandedWidth}`,
			`Path display: ${config.pathStyle === "short" ? `short (last ${config.pathSegments})` : "full"}`,
			`Keybindings: ${keybindingSummary()}`,
			`Config: ${CONFIG_PATH}`,
		];
	}

	function updateStatus(ctx: ExtensionContext) {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(
			STATUS_KEY,
			config.autoApprove ? ctx.ui.theme.fg("warning", t("status.auto", "✍ auto-approve file changes")) : undefined,
		);
	}

	function setConfig(next: Partial<DiffApprovalConfig>, ctx?: ExtensionContext, notify = true, message?: string) {
		config = normalizeConfig({ ...config, ...next });
		saveConfig(config);
		if (!ctx) return;
		updateStatus(ctx);
		if (!notify || !ctx.hasUI) return;
		ctx.ui.notify(message ?? getStatusLines().join("\n"), "info");
	}

	function setAutoApprove(autoApprove: boolean, ctx: ExtensionContext) {
		setConfig(
			{ autoApprove },
			ctx,
			true,
			autoApprove ? t("notify.autoOn", "Auto-approve is ON for file changes.") : t("notify.manualOn", "Manual diff review is ON."),
		);
	}

	function setDiffColorMode(diffColorMode: DiffColorMode, ctx: ExtensionContext) {
		setConfig(
			{ diffColorMode },
			ctx,
			true,
			diffColorMode === "theme"
				? "Diff colors now follow your pi theme backgrounds."
				: "Diff colors now use pi-show-diffs default backgrounds.",
		);
	}

	function formatKeys(keys: string[] | false): string {
		if (keys === false) return "disabled";
		return keys.join(", ");
	}

	function keybindingLabel(action: keyof DiffKeybindings): string {
		const labels: Record<keyof DiffKeybindings, string> = {
			approve: "Approve",
			reject: "Reject",
			steer: "Steer",
			editInline: "Edit inline",
			autoApprove: "Auto-approve",
			scrollUp: "Scroll up",
			scrollDown: "Scroll down",
			pageUp: "Page up",
			pageDown: "Page down",
			scrollTop: "Scroll to top",
			scrollBottom: "Scroll to bottom",
			nextHunk: "Next hunk",
			prevHunk: "Previous hunk",
			toggleMode: "Toggle mode",
			toggleWrap: "Toggle wrap",
			toggleExpand: "Toggle expand",
			contextMore: "More context",
			contextLess: "Less context",
		};
		return labels[action];
	}

	function keybindingActions(): (keyof DiffKeybindings)[] {
		return Object.keys(DEFAULT_KEYBINDINGS) as (keyof DiffKeybindings)[];
	}

	function countCustomKeybindings(): number {
		const kb = config.keybindings;
		return keybindingActions().filter((key) => {
			const current = kb[key];
			const defaultVal = DEFAULT_KEYBINDINGS[key];
			return JSON.stringify(current) !== JSON.stringify(defaultVal);
		}).length;
	}

	function keybindingSummary(): string {
		const customCount = countCustomKeybindings();
		return customCount === 0 ? "all defaults" : `${customCount} customized`;
	}

	async function handleKeybindingsMenu(ctx: ExtensionContext) {
		const actions = keybindingActions();
		const options = [
			...actions.map((action) => `${keybindingLabel(action)}: ${formatKeys(config.keybindings[action])}`),
			"Reset all to defaults",
			"Back",
		];

		const kbChoice = await ctx.ui.select("Configure keybindings", options);
		if (!kbChoice || kbChoice === "Back") return;

		if (kbChoice === "Reset all to defaults") {
			setConfig({ keybindings: { ...DEFAULT_KEYBINDINGS } }, ctx);
			return;
		}

		const selectedAction = actions.find((action) => kbChoice.startsWith(keybindingLabel(action)));
		if (!selectedAction) return;

		const current = config.keybindings[selectedAction];
		const currentStr = current === false ? "false" : current.join(", ");
		const value = await ctx.ui.editor(
			`${keybindingLabel(selectedAction)} keys (comma-separated, or "false" to disable)`,
			currentStr,
		);
		if (value === undefined || value === null) return;

		const trimmed = value.trim();
		if (!trimmed) return;

		const newKeys: string[] | false =
			trimmed.toLowerCase() === "false"
				? false
				: trimmed.split(",").map((key) => key.trim()).filter(Boolean);

		setConfig({ keybindings: { ...config.keybindings, [selectedAction]: newKeys } }, ctx);
	}

	function valuesWithCurrent(currentValue: string, values: string[]) {
		return values.includes(currentValue) ? values : [currentValue, ...values];
	}

	async function showApprovalSettings(ctx: ExtensionContext) {
		let followUp: "keybindings" | undefined;
		const items: SettingItem[] = [
			{
				id: "autoApprove",
				label: "Auto-approve",
				currentValue: config.autoApprove ? "on" : "off",
				values: ["off", "on"],
				description: "When on, file changes apply without opening the diff review modal.",
			},
			{
				id: "diffColorMode",
				label: "Diff colors",
				currentValue: config.diffColorMode,
				values: ["default", "theme"],
				description: "default = pi-show-diffs red/green backgrounds; theme = active pi theme success/error backgrounds.",
			},
			{
				id: "showDiffRail",
				label: "Diff rail",
				currentValue: config.showDiffRail ? "on" : "off",
				values: ["off", "on"],
				description: "Show a colored rail marker beside each rendered diff line.",
			},
			{
				id: "expandableLayout",
				label: "Expandable layout",
				currentValue: config.expandableLayout ? "on" : "off",
				values: ["off", "on"],
				description: "When on, the diff opens inline and Ctrl+F expands it to an overlay.",
			},
			{
				id: "collapsedHeight",
				label: "Collapsed height",
				currentValue: config.collapsedHeight,
				values: valuesWithCurrent(config.collapsedHeight, ["20%", "30%", "40%", "50%"]),
				description: "Inline diff height when expandable layout is enabled.",
			},
			{
				id: "expandedHeight",
				label: "Expanded height",
				currentValue: config.expandedHeight,
				values: valuesWithCurrent(config.expandedHeight, ["80%", "90%", "100%"]),
				description: "Maximum overlay height after pressing Ctrl+F in expandable layout.",
			},
			{
				id: "expandedWidth",
				label: "Expanded width",
				currentValue: config.expandedWidth,
				values: valuesWithCurrent(config.expandedWidth, ["80%", "90%", "96%", "100%"]),
				description: "Overlay width after pressing Ctrl+F in expandable layout.",
			},
			{
				id: "pathStyle",
				label: "Path display",
				currentValue: config.pathStyle,
				values: ["full", "short"],
				description: "full = entire path; short = last N segments with a leading …/ in the diff header.",
			},
			{
				id: "pathSegments",
				label: "Short path segments",
				currentValue: String(config.pathSegments),
				values: valuesWithCurrent(String(config.pathSegments), ["2", "3", "4", "5"]),
				description: "How many trailing path segments the short display keeps.",
			},
			{
				id: "keybindings",
				label: "Keybindings",
				currentValue: keybindingSummary(),
				values: ["open"],
				description: "Press Enter to configure custom diff modal keybindings.",
			},
		];

		await ctx.ui.custom((tui, theme, _kb, done) => {
			const settingsList = new SettingsList(
				items,
				items.length,
				{
					label: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("text", text)),
					value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
					description: (text) => theme.fg("dim", text),
					cursor: theme.fg("accent", "→ "),
					hint: (text) => theme.fg("dim", text),
				},
				(id, newValue) => {
					if (id === "autoApprove") {
						setConfig({ autoApprove: newValue === "on" }, ctx, false);
					}
					if (id === "diffColorMode") {
						setConfig({ diffColorMode: newValue === "theme" ? "theme" : "default" }, ctx, false);
					}
					if (id === "showDiffRail") {
						setConfig({ showDiffRail: newValue === "on" }, ctx, false);
					}
					if (id === "expandableLayout") {
						setConfig({ expandableLayout: newValue === "on" }, ctx, false);
					}
					if (id === "collapsedHeight") {
						setConfig({ collapsedHeight: newValue }, ctx, false);
					}
					if (id === "expandedHeight") {
						setConfig({ expandedHeight: newValue }, ctx, false);
					}
					if (id === "expandedWidth") {
						setConfig({ expandedWidth: newValue }, ctx, false);
					}
					if (id === "pathStyle") {
						setConfig({ pathStyle: newValue === "short" ? "short" : "full" }, ctx, false);
					}
					if (id === "pathSegments") {
						const parsed = Number.parseInt(newValue, 10);
						if (Number.isInteger(parsed) && parsed > 0) setConfig({ pathSegments: parsed }, ctx, false);
					}
					if (id === "keybindings") {
						followUp = "keybindings";
						done(undefined);
					}
				},
				() => done(undefined),
			);

			return {
				render: (width: number) => [
					truncateToWidth(theme.fg("accent", theme.bold("pi-show-diffs settings")), width, "", false),
					truncateToWidth(theme.fg("muted", `Config: ${CONFIG_PATH}`), width, theme.fg("muted", "…"), false),
					"",
					...settingsList.render(width),
				],
				invalidate: () => settingsList.invalidate(),
				handleInput: (data: string) => {
					settingsList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (followUp === "keybindings") {
			await handleKeybindingsMenu(ctx);
		}
	}

	async function handleCommand(args: string, ctx: ExtensionContext) {
		const command = args.trim().toLowerCase();
		const commandParts = command.split(/\s+/).filter(Boolean);

		if (command === "on" || command === "enable" || command === "auto") {
			setAutoApprove(true, ctx);
			return;
		}

		if (command === "off" || command === "disable" || command === "manual") {
			setAutoApprove(false, ctx);
			return;
		}

		if (command === "toggle") {
			setAutoApprove(!config.autoApprove, ctx);
			return;
		}

		if (
			commandParts.length === 2 &&
			["color", "colors", "diff-colors", "diff-color-mode"].includes(commandParts[0]!) &&
			(commandParts[1] === "default" || commandParts[1] === "theme")
		) {
			setDiffColorMode(commandParts[1], ctx);
			return;
		}

		if (["keybinding", "keybindings", "keys"].includes(command)) {
			await handleKeybindingsMenu(ctx);
			return;
		}

		if (command === "status") {
			ctx.ui.notify(getStatusLines().join("\n"), "info");
			return;
		}

		await showApprovalSettings(ctx);
		return;
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
		description: t("cmd.diffApproval", "Toggle or inspect diff approval mode"),
		handler: handleCommand,
	});

	pi.registerCommand("show-diffs", {
		description: t("cmd.showDiffs", "Alias for /diff-approval"),
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
			diffColorMode: config.diffColorMode,
			showDiffRail: config.showDiffRail,
			expandableLayout: config.expandableLayout,
			collapsedHeight: config.collapsedHeight,
			expandedHeight: config.expandedHeight,
			expandedWidth: config.expandedWidth,
			pathStyle: config.pathStyle,
			pathSegments: config.pathSegments,
			keybindings: config.keybindings,
		});

		if (decision.action === "approve_and_enable_auto") {
			setAutoApprove(true, ctx);
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
