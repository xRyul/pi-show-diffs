import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
	CURSOR_MARKER,
	Editor,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
} from "@mariozechner/pi-tui";

import {
	adjustStructuredDiffContext,
	type InlineRange,
	type StructuredDiff,
	type StructuredDiffHunk,
	type StructuredDiffRow,
	type StructuredDiffVisibleItem,
} from "./diff-utils.js";
import { rebuildPreviewAfterManualEdit, type ChangePreview } from "./preview.js";
import {
	detectSyntaxLanguage,
	getSyntaxTokenColorAnsi,
	tokenizeSyntaxLine,
	type SyntaxSegment,
} from "./syntax-highlight.js";

export interface DiffDecision {
	action: "approve" | "reject" | "steer" | "approve_and_enable_auto";
	feedback?: string;
	afterTextOverride?: string;
}

interface ReviewOptions {
	allowAfterEdit?: boolean;
}

type ViewMode = "split" | "unified";
type DiffTone = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";

interface RenderedCell {
	lines: string[];
	cursorLineIndex?: number;
}

interface RenderedContent {
	lines: string[];
	hunkOffsets: number[];
	cursorOffset?: number;
}

interface ViewerLayout {
	width: number;
	mode: ViewMode;
	headerLines: string[];
	columnLines: string[];
	footerLines: string[];
	contentLines: string[];
	hunkOffsets: number[];
	viewportHeight: number;
	maxScrollOffset: number;
	currentHunkIndex: number;
}

const TAB_REPLACEMENT = "    ";
const MIN_SPLIT_COLUMN_WIDTH = 28;
const MIN_CONTEXT_LINES = 0;
const MAX_CONTEXT_LINES = 80;
const INLINE_CURSOR_OPEN = "\x1b[1;7m";
const INLINE_CURSOR_CLOSE = "\x1b[0m";
const MUTED_DIFF_BACKGROUND_ANSI: Record<Exclude<DiffTone, "toolDiffContext">, string> = {
	toolDiffAdded: "\x1b[48;2;58;86;74m",
	toolDiffRemoved: "\x1b[48;2;86;63;67m",
};

function clampNumber(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(value, max));
}

function normalizeTuiText(text: string): string {
	return text.replace(/\t/g, TAB_REPLACEMENT);
}

function pluralize(word: string, count: number): string {
	return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

function summarizeLines(lines: string[], maxItems = 3): string {
	if (lines.length === 0) return "";
	const visible = lines.slice(0, maxItems).map(normalizeTuiText);
	if (lines.length <= maxItems) return visible.join(" • ");
	return `${visible.join(" • ")} • … ${lines.length - maxItems} more`;
}

function sliceChars(text: string, start: number, end: number): string {
	return Array.from(text).slice(start, end).join("");
}

function centerAnsiText(text: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const truncated = truncateToWidth(text, safeWidth, "", false);
	const padding = Math.max(0, safeWidth - visibleWidth(truncated));
	const leftPadding = Math.floor(padding / 2);
	return truncateToWidth(`${" ".repeat(leftPadding)}${truncated}`, safeWidth, "", true);
}

function convertFgAnsiToBgAnsi(ansi: string): string {
	const match = ansi.match(/\x1b\[([0-9;]*)m/);
	if (!match) return ansi;

	const params = match[1] ? match[1].split(";").map((value) => Number(value)) : [];
	const converted: number[] = [];

	for (let i = 0; i < params.length; i++) {
		const param = params[i]!;

		if (param >= 30 && param <= 37) {
			converted.push(param + 10);
			continue;
		}

		if (param >= 90 && param <= 97) {
			converted.push(param + 10);
			continue;
		}

		if (param === 38) {
			const mode = params[i + 1];
			if (mode === 5 && i + 2 < params.length) {
				converted.push(48, 5, params[i + 2]!);
				i += 2;
				continue;
			}
			if (mode === 2 && i + 4 < params.length) {
				converted.push(48, 2, params[i + 2]!, params[i + 3]!, params[i + 4]!);
				i += 4;
				continue;
			}
		}

		if (param === 39) {
			converted.push(49);
			continue;
		}

		converted.push(param);
	}

	return `\x1b[${converted.join(";")}m`;
}

class BorderFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly borderColor: (text: string) => string,
	) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		if (width <= 4) return this.child.render(width);

		const innerWidth = Math.max(1, width - 2);
		const top = this.borderColor(`┌${"─".repeat(innerWidth)}┐`);
		const bottom = this.borderColor(`└${"─".repeat(innerWidth)}┘`);
		const childLines = this.child.render(innerWidth);
		const body = childLines.map((line) => {
			const safe = truncateToWidth(line, innerWidth, "", true);
			return this.borderColor("│") + safe + this.borderColor("│");
		});

		return [top, ...body, bottom];
	}
}

class CenteredFrame implements Component {
	constructor(
		private readonly child: Component,
		private readonly tui: { terminal: { rows: number } },
	) {}

	invalidate(): void {
		this.child.invalidate();
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const maxFrameWidth = Math.max(1, safeWidth - 2);
		const preferredFrameWidth = Math.max(20, Math.floor(safeWidth * 0.96));
		const frameWidth = Math.min(maxFrameWidth, preferredFrameWidth);
		const childLines = this.child.render(frameWidth);
		const canvasHeight = Math.max(childLines.length, this.tui.terminal.rows || 24);
		const topPadding = Math.max(0, Math.floor((canvasHeight - childLines.length) / 2));
		const bottomPadding = Math.max(0, canvasHeight - topPadding - childLines.length);
		const leftPadding = Math.max(0, Math.floor((safeWidth - frameWidth) / 2));
		const blankLine = " ".repeat(safeWidth);
		const lines: string[] = [];

		for (let i = 0; i < topPadding; i++) lines.push(blankLine);

		for (const line of childLines) {
			const safeLine = truncateToWidth(line, frameWidth, "", true);
			const rightPadding = Math.max(0, safeWidth - leftPadding - visibleWidth(safeLine));
			lines.push(`${" ".repeat(leftPadding)}${safeLine}${" ".repeat(rightPadding)}`);
		}

		for (let i = 0; i < bottomPadding; i++) lines.push(blankLine);

		return lines;
	}
}

class DiffViewer implements Component {
	private scrollOffset = 0;
	private lastWidth = 80;
	private wrapLongLines = true;
	private preferredMode: ViewMode;
	private baseDiffModel?: StructuredDiff;
	private diffModel?: StructuredDiff;
	private contextLines: number;
	private readonly syntaxLanguage?: string;
	private readonly syntaxLineCache = new Map<string, SyntaxSegment[]>();
	private preview: ChangePreview;
	private readonly initialAfterText?: string;
	private fullContextLines: number;
	private inlineEditMode = false;
	private inlineEditor?: Editor;
	private savedContextLinesBeforeInlineEdit?: number;

	constructor(
		private readonly tui: { terminal: { rows: number } },
		private readonly theme: Theme,
		preview: ChangePreview,
		private readonly allowAfterEdit: boolean,
	) {
		this.preview = preview;
		this.initialAfterText = preview.afterText;
		this.baseDiffModel = preview.diffModel;
		this.diffModel = preview.diffModel;
		this.contextLines = preview.diffModel?.contextLines ?? 4;
		this.preferredMode = preview.diffModel ? "split" : "unified";
		this.syntaxLanguage = detectSyntaxLanguage(preview.path);
		this.fullContextLines = Math.max(preview.diffModel?.totalOldLines ?? 0, preview.diffModel?.totalNewLines ?? 0, 1);
	}

	invalidate(): void {
		// Stateless render.
	}

	isEditingInline(): boolean {
		return this.inlineEditMode;
	}

	getAfterTextOverride(): string | undefined {
		return this.initialAfterText !== undefined && this.preview.afterText !== undefined && this.preview.afterText !== this.initialAfterText
			? this.preview.afterText
			: undefined;
	}

	private createInlineEditor(): Editor {
		const editor = new Editor(this.tui as never, {
			borderColor: (text) => text,
			selectList: {
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		});
		editor.disableSubmit = true;
		editor.onChange = (text) => {
			this.applyUpdatedPreview(rebuildPreviewAfterManualEdit(this.preview, text));
		};
		editor.setText(this.preview.afterText ?? "");
		return editor;
	}

	private ensureInlineEditor(): Editor {
		this.inlineEditor ??= this.createInlineEditor();
		if (this.inlineEditor.getText() !== (this.preview.afterText ?? "")) {
			this.inlineEditor.setText(this.preview.afterText ?? "");
		}
		return this.inlineEditor;
	}

	private applyUpdatedPreview(nextPreview: ChangePreview): void {
		this.preview = nextPreview;
		this.baseDiffModel = nextPreview.diffModel;
		this.fullContextLines = Math.max(nextPreview.diffModel?.totalOldLines ?? 0, nextPreview.diffModel?.totalNewLines ?? 0, 1);
		this.diffModel = nextPreview.diffModel;
		if (this.inlineEditMode && this.baseDiffModel) {
			this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.fullContextLines);
			return;
		}
		if (this.baseDiffModel) {
			this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.contextLines);
		}
	}

	enterInlineEditMode(): boolean {
		if (!this.allowAfterEdit) return false;
		const anchor = this.getInlineEditAnchor();
		this.ensureInlineEditor();
		this.inlineEditMode = true;
		this.savedContextLinesBeforeInlineEdit = this.contextLines;
		this.preferredMode = "split";
		if (this.baseDiffModel) {
			this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.fullContextLines);
		}
		this.setInlineEditorCursor(anchor.line, anchor.col);
		this.scrollOffset = 0;
		return true;
	}

	exitInlineEditMode(): boolean {
		if (!this.inlineEditMode) return false;
		this.inlineEditMode = false;
		if (this.baseDiffModel) {
			const restoredContext = this.savedContextLinesBeforeInlineEdit ?? this.contextLines;
			this.contextLines = restoredContext;
			this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, restoredContext);
		}
		return true;
	}

	private syncInlineEditorLayoutWidth(contentWidth: number): void {
		if (!this.inlineEditMode || !this.inlineEditor) return;
		(this.inlineEditor as unknown as { lastWidth: number }).lastWidth = Math.max(1, contentWidth);
	}

	private getInlineCursor(): { line: number; col: number } | undefined {
		if (!this.inlineEditMode || !this.inlineEditor) return undefined;
		return this.inlineEditor.getCursor();
	}

	private setInlineEditorCursor(line: number, col: number): void {
		const editor = this.ensureInlineEditor();
		const mutableEditor = editor as unknown as {
			state: { lines: string[]; cursorLine: number; cursorCol: number };
			scrollOffset: number;
			preferredVisualCol: number | null;
		};
		const targetLine = clampNumber(line, 0, Math.max(0, mutableEditor.state.lines.length - 1));
		const targetCol = clampNumber(col, 0, (mutableEditor.state.lines[targetLine] ?? "").length);
		mutableEditor.state.cursorLine = targetLine;
		mutableEditor.state.cursorCol = targetCol;
		mutableEditor.scrollOffset = 0;
		mutableEditor.preferredVisualCol = null;
	}

	private getHunkAnchorLine(hunk: StructuredDiffHunk): number {
		return Math.max(0, (hunk.newStartLine ?? hunk.oldStartLine ?? 1) - 1);
	}

	private getInlineEditAnchor(): { line: number; col: number } {
		const sourceDiff = this.diffModel ?? this.baseDiffModel;
		if (!sourceDiff || sourceDiff.hunks.length === 0) return { line: 0, col: 0 };
		const layout = this.buildLayout(this.lastWidth);
		const hunk = sourceDiff.hunks[clampNumber(layout.currentHunkIndex, 0, sourceDiff.hunks.length - 1)]!;
		return { line: this.getHunkAnchorLine(hunk), col: 0 };
	}

	private getCurrentInlineHunkIndex(): number {
		const sourceDiff = this.diffModel ?? this.baseDiffModel;
		if (!sourceDiff || sourceDiff.hunks.length === 0) return 0;
		const cursor = this.getInlineCursor();
		if (!cursor) return this.buildLayout(this.lastWidth).currentHunkIndex;
		let current = 0;
		for (let i = 0; i < sourceDiff.hunks.length; i++) {
			if (this.getHunkAnchorLine(sourceDiff.hunks[i]!) <= cursor.line) current = i;
			else break;
		}
		return current;
	}

	private jumpInlineEditorToHunk(targetHunkIndex: number): boolean {
		const sourceDiff = this.diffModel ?? this.baseDiffModel;
		if (!sourceDiff || sourceDiff.hunks.length === 0) return false;
		const safeTarget = clampNumber(targetHunkIndex, 0, sourceDiff.hunks.length - 1);
		this.setInlineEditorCursor(this.getHunkAnchorLine(sourceDiff.hunks[safeTarget]!), 0);
		this.scrollOffset = 0;
		return true;
	}

	private getTotalHeight(): number {
		const rows = this.tui.terminal.rows || 24;
		return Math.max(16, Math.min(rows - 2, Math.floor(rows * 0.9)));
	}

	private getLineNumberWidth(): number {
		if (!this.diffModel) return 4;
		return Math.max(1, String(Math.max(this.diffModel.totalOldLines, this.diffModel.totalNewLines, 1)).length);
	}

	private getSplitLayout(width: number): { leftWidth: number; rightWidth: number; gutterText: string; gutterWidth: number } {
		const gutterText = this.theme.fg("borderMuted", " │ ");
		const gutterWidth = 3;
		const leftWidth = Math.floor((width - gutterWidth) / 2);
		const rightWidth = width - gutterWidth - leftWidth;
		return { leftWidth, rightWidth, gutterText, gutterWidth };
	}

	private canRenderSplit(width: number): boolean {
		if (!this.diffModel) return false;
		const split = this.getSplitLayout(width);
		return split.leftWidth >= MIN_SPLIT_COLUMN_WIDTH && split.rightWidth >= MIN_SPLIT_COLUMN_WIDTH;
	}

	private getEffectiveMode(width: number): ViewMode {
		if (this.preferredMode === "split" && this.canRenderSplit(width)) return "split";
		return "unified";
	}

	private getCurrentHunkIndex(hunkOffsets: number[], scrollOffset: number): number {
		if (hunkOffsets.length === 0) return 0;
		let current = 0;
		for (let i = 0; i < hunkOffsets.length; i++) {
			if (scrollOffset >= (hunkOffsets[i] ?? 0)) current = i;
			else break;
		}
		return current;
	}

	private formatHunkLabel(currentHunkIndex: number, totalHunks: number): string {
		if (!this.diffModel || totalHunks === 0) return "Hunk: none";
		const hunk = this.diffModel.hunks[clampNumber(currentHunkIndex, 0, totalHunks - 1)]!;
		const newRange =
			hunk.newStartLine === undefined
				? undefined
				: hunk.newStartLine === hunk.newEndLine
					? `${hunk.newStartLine.toLocaleString()}`
					: `${hunk.newStartLine.toLocaleString()}-${(hunk.newEndLine ?? hunk.newStartLine).toLocaleString()}`;
		const oldRange =
			hunk.oldStartLine === undefined
				? undefined
				: hunk.oldStartLine === hunk.oldEndLine
					? `${hunk.oldStartLine.toLocaleString()}`
					: `${hunk.oldStartLine.toLocaleString()}-${(hunk.oldEndLine ?? hunk.oldStartLine).toLocaleString()}`;
		const anchor = newRange ? `new ${newRange}` : oldRange ? `old ${oldRange}` : "mixed";
		return `Hunk ${currentHunkIndex + 1}/${totalHunks} @ ${anchor}`;
	}

	private buildHeaderLines(width: number, mode: ViewMode, currentHunkIndex: number, totalHunks: number): string[] {
		const modeLabel = this.preferredMode === mode ? mode : `${mode} (auto)`;
		const diffLine = [
			`${this.theme.fg("muted", "Diff:")} ${this.theme.fg("success", `+${this.preview.additions}`)} ${this.theme.fg("dim", "/")} ${this.theme.fg("error", `-${this.preview.deletions}`)}`,
			this.theme.fg("muted", this.formatHunkLabel(currentHunkIndex, totalHunks)),
			`${this.theme.fg("muted", "View:")} ${this.theme.fg("text", modeLabel)}`,
			`${this.theme.fg("muted", "Context:")} ${this.theme.fg("text", this.diffModel ? String(this.inlineEditMode ? "all" : this.contextLines) : "—")}`,
			`${this.theme.fg("muted", "Wrap:")} ${this.theme.fg("text", this.wrapLongLines ? "on" : "off")}`,
		].join(` ${this.theme.fg("dim", "•")} `);
		const toolAndPath = `${this.theme.fg("muted", "Tool:")} ${this.theme.fg("text", normalizeTuiText(this.preview.toolName))} ${this.theme.fg("dim", "•")} ${this.theme.fg("muted", "Path:")} ${this.theme.fg("text", normalizeTuiText(this.preview.path))}`;
		const summaryLine = this.preview.previewError
			? this.theme.fg("warning", `Preview warning: ${normalizeTuiText(this.preview.previewError)}`)
			: this.theme.fg("dim", summarizeLines(this.preview.summaryLines));
		const title = this.inlineEditMode ? "Review proposed file change · INLINE EDIT" : "Review proposed file change";

		return [
			truncateToWidth(this.theme.bold(this.theme.fg("accent", title)), width, "", false),
			truncateToWidth(toolAndPath, width, this.theme.fg("muted", "…"), false),
			truncateToWidth(diffLine, width, this.theme.fg("muted", "…"), false),
			truncateToWidth(summaryLine, width, this.theme.fg("muted", "…"), false),
		];
	}

	private buildColumnLines(width: number, mode: ViewMode): string[] {
		if (mode !== "split") return [];
		const split = this.getSplitLayout(width);
		const leftHeader = truncateToWidth(this.theme.bold(this.theme.fg("muted", "Original")), split.leftWidth, "", true);
		const rightTitle = this.inlineEditMode ? this.theme.fg("accent", "Updated (editing)") : this.theme.fg("muted", "Updated");
		const rightHeader = truncateToWidth(this.theme.bold(rightTitle), split.rightWidth, "", true);
		const divider = this.theme.fg(
			"borderMuted",
			`${"─".repeat(split.leftWidth)}─┼─${"─".repeat(split.rightWidth)}`,
		);
		return [leftHeader + split.gutterText + rightHeader, divider];
	}

	private buildFooterLines(width: number, mode: ViewMode): string[] {
		if (this.inlineEditMode) {
			return [
				truncateToWidth(
					this.theme.fg(
						"dim",
						"Editing inline • Esc review • Ctrl+N/Ctrl+P hunks • Alt+↓/Alt+↑ hunks • Enter newline • Tab indent",
					),
					width,
					"",
					false,
				),
			];
		}

		const parts = [
			"n/p hunks",
			"↑↓ scroll",
			"PgUp/PgDn jump",
			"Home/End edges",
			"←/→ context",
			"Tab split/unified",
			"w wrap",
			"Enter/y approve",
			"r/Esc reject",
			"s steer",
			"Shift+A auto",
		];
		if (this.allowAfterEdit) {
			parts.splice(parts.length - 3, 0, "E edit inline");
		}
		if (!this.diffModel) {
			parts.splice(0, 2, "↑↓ scroll", "PgUp/PgDn jump");
		}
		if (mode !== "split") {
			parts.splice(4, 1, "[/] context");
		}
		return [truncateToWidth(this.theme.fg("dim", parts.join(" • ")), width, "", false)];
	}

	private wrapStyledText(text: string, width: number): string[] {
		const safeWidth = Math.max(1, width);
		if (text.length === 0) return [""];
		if (!this.wrapLongLines) {
			return [truncateToWidth(text, safeWidth, this.theme.fg("muted", "…"), false)];
		}
		const wrapped = wrapTextWithAnsi(text, safeWidth).map((line) => truncateToWidth(line, safeWidth, "", false));
		return wrapped.length > 0 ? wrapped : [""];
	}

	private getBackgroundAnsiForTone(tone: DiffTone): string | undefined {
		if (tone === "toolDiffContext") return undefined;
		return MUTED_DIFF_BACKGROUND_ANSI[tone];
	}

	private getForegroundForTone(tone: DiffTone): "text" | "toolDiffContext" {
		return tone === "toolDiffContext" ? "toolDiffContext" : "text";
	}

	private applyLineBackground(text: string, tone: DiffTone): string {
		const backgroundAnsi = this.getBackgroundAnsiForTone(tone);
		return backgroundAnsi ? `${backgroundAnsi}${text}\x1b[49m` : text;
	}

	private getSyntaxSegments(text: string): SyntaxSegment[] {
		if (!this.syntaxLanguage || text.trim().length === 0) return [{ text }];
		const cached = this.syntaxLineCache.get(text);
		if (cached) return cached;

		const segments = tokenizeSyntaxLine(text, this.syntaxLanguage);
		this.syntaxLineCache.set(text, segments);
		return segments;
	}

	private styleSyntaxSegment(
		text: string,
		tone: DiffTone,
		token: SyntaxSegment["token"],
		highlighted: boolean,
	): string {
		const foreground = this.getForegroundForTone(tone);
		const fallback = highlighted ? this.theme.bold(this.theme.fg(foreground, text)) : this.theme.fg(foreground, text);
		const colorAnsi = getSyntaxTokenColorAnsi(token);
		if (!colorAnsi) return fallback;

		let output = "";
		if (highlighted) output += "\x1b[1m";
		output += `${colorAnsi}${text}\x1b[39m`;
		if (highlighted) output += "\x1b[22m";
		return output;
	}

	private styleDiffText(text: string, ranges: InlineRange[], tone: DiffTone, cursorCol?: number): string {
		const safeText = normalizeTuiText(text);
		const chars = Array.from(safeText);
		const clampedCursorCol = cursorCol === undefined ? undefined : clampNumber(cursorCol, 0, chars.length);
		if (safeText.length === 0) {
			if (clampedCursorCol === undefined) return "";
			return `${this.inlineEditMode ? CURSOR_MARKER : ""}${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
		}

		const safeRanges = ranges
			.map((range) => ({
				start: clampNumber(range.start, 0, chars.length),
				end: clampNumber(range.end, 0, chars.length),
			}))
			.filter((range) => range.end > range.start)
			.sort((a, b) => a.start - b.start || a.end - b.end);

		const syntaxSegments = this.getSyntaxSegments(safeText);
		const syntaxRanges: Array<{ start: number; end: number; token: SyntaxSegment["token"] }> = [];
		let syntaxCursor = 0;

		for (const segment of syntaxSegments) {
			const segmentLength = Array.from(segment.text).length;
			if (segmentLength === 0) continue;
			syntaxRanges.push({
				start: syntaxCursor,
				end: syntaxCursor + segmentLength,
				token: segment.token,
			});
			syntaxCursor += segmentLength;
		}

		const boundaries = new Set<number>([0, chars.length]);
		for (const range of safeRanges) {
			boundaries.add(range.start);
			boundaries.add(range.end);
		}
		for (const range of syntaxRanges) {
			boundaries.add(range.start);
			boundaries.add(range.end);
		}
		if (clampedCursorCol !== undefined && clampedCursorCol < chars.length) {
			boundaries.add(clampedCursorCol);
			boundaries.add(clampedCursorCol + 1);
		}

		const orderedBoundaries = [...boundaries].sort((a, b) => a - b);
		let syntaxIndex = 0;
		let highlightIndex = 0;
		let output = "";

		for (let i = 0; i < orderedBoundaries.length - 1; i++) {
			const start = orderedBoundaries[i]!;
			const end = orderedBoundaries[i + 1]!;
			if (end <= start) continue;

			while (syntaxIndex < syntaxRanges.length && start >= syntaxRanges[syntaxIndex]!.end) syntaxIndex++;
			while (highlightIndex < safeRanges.length && start >= safeRanges[highlightIndex]!.end) highlightIndex++;

			const token =
				syntaxIndex < syntaxRanges.length &&
				start >= syntaxRanges[syntaxIndex]!.start &&
				start < syntaxRanges[syntaxIndex]!.end
					? syntaxRanges[syntaxIndex]!.token
					: undefined;
			const highlighted =
				highlightIndex < safeRanges.length &&
				start >= safeRanges[highlightIndex]!.start &&
				start < safeRanges[highlightIndex]!.end;

			const segmentText = sliceChars(safeText, start, end);
			if (clampedCursorCol !== undefined && start === clampedCursorCol && end === clampedCursorCol + 1) {
				output += `${this.inlineEditMode ? CURSOR_MARKER : ""}${INLINE_CURSOR_OPEN}${segmentText || " "}${INLINE_CURSOR_CLOSE}`;
				continue;
			}

			output += this.styleSyntaxSegment(segmentText, tone, token, highlighted);
		}

		if (clampedCursorCol !== undefined && clampedCursorCol === chars.length) {
			output += `${this.inlineEditMode ? CURSOR_MARKER : ""}${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
		}

		return output;
	}

	private buildCellPrefix(sign: string, lineNumber: number | undefined, lineNumberWidth: number, tone: DiffTone): string {
		const numberText = lineNumber === undefined ? "".padStart(lineNumberWidth, " ") : String(lineNumber).padStart(lineNumberWidth, " ");
		const foreground = this.getForegroundForTone(tone);
		const isChangedLine = tone !== "toolDiffContext";
		const signText = sign.trim().length === 0 ? sign : this.theme.bold(this.theme.fg(foreground, sign));
		const numberStyle = isChangedLine
			? this.theme.bold(this.theme.fg(foreground, numberText))
			: this.theme.fg("muted", numberText);
		return `${signText}${numberStyle} `;
	}

	private getCursorColForRow(row: StructuredDiffRow, side: "old" | "new"): number | undefined {
		if (!this.inlineEditMode || side !== "new") return undefined;
		const cursor = this.getInlineCursor();
		if (!cursor) return undefined;
		return row.newLineNumber === cursor.line + 1 ? cursor.col : undefined;
	}

	private renderSplitCell(
		row: StructuredDiffRow,
		side: "old" | "new",
		cellWidth: number,
		lineNumberWidth: number,
	): RenderedCell {
		const prefixWidth = lineNumberWidth + 2;
		const contentWidth = Math.max(1, cellWidth - prefixWidth);
		if (side === "new") this.syncInlineEditorLayoutWidth(contentWidth);
		let sign = " ";
		let tone: DiffTone = "toolDiffContext";
		let lineNumber: number | undefined;
		let text = "";
		let highlights: InlineRange[] = [];

		if (side === "old") {
			lineNumber = row.oldLineNumber;
			text = row.oldText;
			highlights = row.oldHighlights;
			if (row.kind === "delete" || row.kind === "replace") {
				sign = "-";
				tone = "toolDiffRemoved";
			}
		} else {
			lineNumber = row.newLineNumber;
			text = row.newText;
			highlights = row.newHighlights;
			if (row.kind === "insert" || row.kind === "replace") {
				sign = "+";
				tone = "toolDiffAdded";
			}
		}

		const cursorCol = this.getCursorColForRow(row, side);
		if (lineNumber === undefined && text.length === 0 && cursorCol === undefined) {
			return { lines: [" ".repeat(cellWidth)] };
		}

		const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
		const wrapped = this.wrapStyledText(styledText, contentWidth);
		const result: string[] = [];
		let cursorLineIndex: number | undefined;

		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : " ".repeat(prefixWidth);
			const line = truncateToWidth(prefix + wrapped[i]!, cellWidth, "", true);
			if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER)) cursorLineIndex = i;
			result.push(this.applyLineBackground(line, tone));
		}

		return { lines: result.length > 0 ? result : [" ".repeat(cellWidth)], cursorLineIndex };
	}

	private renderSplitRow(
		row: StructuredDiffRow,
		leftWidth: number,
		rightWidth: number,
		gutterText: string,
		lineNumberWidth: number,
	): RenderedCell {
		const leftCell = this.renderSplitCell(row, "old", leftWidth, lineNumberWidth);
		const rightCell = this.renderSplitCell(row, "new", rightWidth, lineNumberWidth);
		const total = Math.max(leftCell.lines.length, rightCell.lines.length);
		const lines: string[] = [];

		for (let i = 0; i < total; i++) {
			const left = truncateToWidth(leftCell.lines[i] ?? "", leftWidth, "", true);
			const right = truncateToWidth(rightCell.lines[i] ?? "", rightWidth, "", true);
			lines.push(left + gutterText + right);
		}

		return { lines, cursorLineIndex: rightCell.cursorLineIndex };
	}

	private renderUnifiedLine(
		sign: " " | "+" | "-",
		lineNumber: number | undefined,
		text: string,
		tone: DiffTone,
		highlights: InlineRange[],
		width: number,
		lineNumberWidth: number,
		cursorCol?: number,
	): RenderedCell {
		const prefixWidth = lineNumberWidth + 2;
		const contentWidth = Math.max(1, width - prefixWidth);
		this.syncInlineEditorLayoutWidth(contentWidth);
		const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
		const wrapped = this.wrapStyledText(styledText, contentWidth);
		const lines: string[] = [];
		let cursorLineIndex: number | undefined;

		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : " ".repeat(prefixWidth);
			const line = truncateToWidth(prefix + wrapped[i]!, width, "", true);
			if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER)) cursorLineIndex = i;
			lines.push(this.applyLineBackground(line, tone));
		}

		return { lines: lines.length > 0 ? lines : [" ".repeat(width)], cursorLineIndex };
	}

	private renderUnifiedRow(row: StructuredDiffRow, width: number, lineNumberWidth: number): RenderedCell {
		if (row.kind === "equal") {
			return this.renderUnifiedLine(
				" ",
				row.oldLineNumber,
				row.oldText,
				"toolDiffContext",
				[],
				width,
				lineNumberWidth,
				this.getCursorColForRow(row, "new"),
			);
		}
		if (row.kind === "delete") {
			return this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth);
		}
		if (row.kind === "insert") {
			return this.renderUnifiedLine(
				"+",
				row.newLineNumber,
				row.newText,
				"toolDiffAdded",
				row.newHighlights,
				width,
				lineNumberWidth,
				this.getCursorColForRow(row, "new"),
			);
		}

		const removed = this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth);
		const added = this.renderUnifiedLine(
			"+",
			row.newLineNumber,
			row.newText,
			"toolDiffAdded",
			row.newHighlights,
			width,
			lineNumberWidth,
			this.getCursorColForRow(row, "new"),
		);
		return {
			lines: [...removed.lines, ...added.lines],
			cursorLineIndex: added.cursorLineIndex === undefined ? undefined : removed.lines.length + added.cursorLineIndex,
		};
	}

	private renderGapLine(label: string, width: number): string {
		return centerAnsiText(this.theme.fg("muted", label), width);
	}

	private buildStructuredContent(width: number, mode: ViewMode): RenderedContent {
		if (!this.diffModel) return { lines: [], hunkOffsets: [] };
		const lineNumberWidth = this.getLineNumberWidth();
		const lines: string[] = [];
		const hunkOffsets: number[] = new Array(this.diffModel.hunks.length).fill(0);
		let nextHunkIndex = 0;
		let cursorOffset: number | undefined;

		const split = mode === "split" ? this.getSplitLayout(width) : undefined;

		for (const item of this.diffModel.visibleItems) {
			if (item.type === "row") {
				while (
					nextHunkIndex < this.diffModel.hunks.length &&
					this.diffModel.hunks[nextHunkIndex]!.changeStartRow === item.fullRowIndex
				) {
					hunkOffsets[nextHunkIndex] = lines.length;
					nextHunkIndex++;
				}

				const rendered =
					mode === "split" && split
						? this.renderSplitRow(item.row, split.leftWidth, split.rightWidth, split.gutterText, lineNumberWidth)
						: this.renderUnifiedRow(item.row, width, lineNumberWidth);
				if (cursorOffset === undefined && rendered.cursorLineIndex !== undefined) {
					cursorOffset = lines.length + rendered.cursorLineIndex;
				}
				lines.push(...rendered.lines);
				continue;
			}

			lines.push(this.renderGapLine(item.label, width));
		}

		for (let i = nextHunkIndex; i < hunkOffsets.length; i++) {
			hunkOffsets[i] = lines.length;
		}

		return { lines, hunkOffsets, cursorOffset };
	}

	private stylePlainTextLine(line: string): string {
		const safe = normalizeTuiText(line);
		if (safe.startsWith("+")) return this.applyLineBackground(this.theme.fg("text", safe), "toolDiffAdded");
		if (safe.startsWith("-")) return this.applyLineBackground(this.theme.fg("text", safe), "toolDiffRemoved");
		if (safe.startsWith(" ")) return this.theme.fg("toolDiffContext", safe);
		return this.theme.fg("text", safe);
	}

	private buildPlainTextContent(width: number): RenderedContent {
		const lines: string[] = [];
		for (const rawLine of (this.preview.diff || "(No visible diff)").split("\n")) {
			const wrapped = this.wrapStyledText(this.stylePlainTextLine(rawLine), width);
			lines.push(...wrapped);
		}
		return { lines: lines.length > 0 ? lines : [""], hunkOffsets: [] };
	}

	private buildContent(width: number, mode: ViewMode): RenderedContent {
		if (this.diffModel) return this.buildStructuredContent(width, mode);
		return this.buildPlainTextContent(width);
	}

	private buildLayout(width: number): ViewerLayout {
		const safeWidth = Math.max(20, width);
		const mode = this.getEffectiveMode(safeWidth);
		const columnLines = this.buildColumnLines(safeWidth, mode);
		const footerLines = this.buildFooterLines(safeWidth, mode);
		const content = this.buildContent(safeWidth, mode);
		const provisionalHeaderLines = this.buildHeaderLines(safeWidth, mode, 0, content.hunkOffsets.length);
		const viewportHeight = Math.max(
			4,
			this.getTotalHeight() - provisionalHeaderLines.length - columnLines.length - footerLines.length - 2,
		);
		const maxScrollOffset = Math.max(0, content.lines.length - viewportHeight);
		let nextScrollOffset = this.scrollOffset;
		if (this.inlineEditMode && content.cursorOffset !== undefined) {
			const desiredTop = Math.max(0, content.cursorOffset - Math.floor(viewportHeight / 3));
			if (content.cursorOffset < nextScrollOffset || content.cursorOffset >= nextScrollOffset + viewportHeight) {
				nextScrollOffset = desiredTop;
			}
		}
		const clampedOffset = clampNumber(nextScrollOffset, 0, maxScrollOffset);
		const currentHunkIndex = this.getCurrentHunkIndex(content.hunkOffsets, clampedOffset);
		const headerLines = this.buildHeaderLines(safeWidth, mode, currentHunkIndex, content.hunkOffsets.length);

		return {
			width: safeWidth,
			mode,
			headerLines,
			columnLines,
			footerLines,
			contentLines: content.lines,
			hunkOffsets: content.hunkOffsets,
			viewportHeight,
			maxScrollOffset,
			currentHunkIndex,
		};
	}

	private setScrollOffset(nextOffset: number): boolean {
		const layout = this.buildLayout(this.lastWidth);
		const clampedOffset = clampNumber(nextOffset, 0, layout.maxScrollOffset);
		if (clampedOffset === this.scrollOffset) return false;
		this.scrollOffset = clampedOffset;
		return true;
	}

	private jumpToHunk(targetHunkIndex: number): boolean {
		const layout = this.buildLayout(this.lastWidth);
		if (layout.hunkOffsets.length === 0) return false;
		const safeTarget = clampNumber(targetHunkIndex, 0, layout.hunkOffsets.length - 1);
		const anchor = layout.hunkOffsets[safeTarget] ?? 0;
		const nextOffset = clampNumber(anchor - Math.floor(layout.viewportHeight / 4), 0, layout.maxScrollOffset);
		if (nextOffset === this.scrollOffset) return false;
		this.scrollOffset = nextOffset;
		return true;
	}

	private preserveCurrentHunk(run: () => void): boolean {
		const before = this.buildLayout(this.lastWidth);
		const currentHunkIndex = before.currentHunkIndex;
		const previousOffset = this.scrollOffset;
		run();
		const after = this.buildLayout(this.lastWidth);
		if (after.hunkOffsets.length > 0) {
			const safeTarget = clampNumber(currentHunkIndex, 0, after.hunkOffsets.length - 1);
			const anchor = after.hunkOffsets[safeTarget] ?? 0;
			this.scrollOffset = clampNumber(anchor - Math.floor(after.viewportHeight / 4), 0, after.maxScrollOffset);
		} else {
			this.scrollOffset = clampNumber(previousOffset, 0, after.maxScrollOffset);
		}
		return true;
	}

	private adjustContext(delta: number): boolean {
		const baseDiffModel = this.baseDiffModel;
		if (!baseDiffModel) return false;
		const nextContextLines = clampNumber(this.contextLines + delta, MIN_CONTEXT_LINES, MAX_CONTEXT_LINES);
		if (nextContextLines === this.contextLines) return false;
		return this.preserveCurrentHunk(() => {
			this.contextLines = nextContextLines;
			this.diffModel = adjustStructuredDiffContext(baseDiffModel, nextContextLines);
		});
	}

	private toggleMode(): boolean {
		if (!this.baseDiffModel) return false;
		return this.preserveCurrentHunk(() => {
			this.preferredMode = this.preferredMode === "split" ? "unified" : "split";
		});
	}

	private toggleWrap(): boolean {
		return this.preserveCurrentHunk(() => {
			this.wrapLongLines = !this.wrapLongLines;
		});
	}

	handleInput(data: string): boolean {
		const layout = this.buildLayout(this.lastWidth);

		if (this.inlineEditMode) {
			if (matchesKey(data, "escape")) return this.exitInlineEditMode();
			if (matchesKey(data, "ctrl+p") || matchesKey(data, "alt+up")) {
				return this.jumpInlineEditorToHunk(this.getCurrentInlineHunkIndex() - 1);
			}
			if (matchesKey(data, "ctrl+n") || matchesKey(data, "alt+down")) {
				return this.jumpInlineEditorToHunk(this.getCurrentInlineHunkIndex() + 1);
			}
			if (matchesKey(data, "pageUp")) return this.setScrollOffset(this.scrollOffset - layout.viewportHeight);
			if (matchesKey(data, "pageDown")) return this.setScrollOffset(this.scrollOffset + layout.viewportHeight);
			const lineNumberWidth = this.getLineNumberWidth();
			const contentWidth =
				layout.mode === "split"
					? Math.max(1, this.getSplitLayout(this.lastWidth).rightWidth - (lineNumberWidth + 2))
					: Math.max(1, this.lastWidth - (lineNumberWidth + 2));
			this.syncInlineEditorLayoutWidth(contentWidth);
			const editor = this.ensureInlineEditor();
			const beforeCursor = editor.getCursor();
			if (matchesKey(data, "tab")) {
				editor.insertTextAtCursor(TAB_REPLACEMENT);
				return true;
			}
			if (matchesKey(data, "return")) {
				editor.handleInput("\n");
				return true;
			}
			editor.handleInput(data);
			const afterCursor = editor.getCursor();
			const cursorDidNotMove = beforeCursor.line === afterCursor.line && beforeCursor.col === afterCursor.col;
			if (cursorDidNotMove && matchesKey(data, "up")) return this.setScrollOffset(this.scrollOffset - 1) || true;
			if (cursorDidNotMove && matchesKey(data, "down")) return this.setScrollOffset(this.scrollOffset + 1) || true;
			return true;
		}

		if ((data === "e" || data === "E") && this.allowAfterEdit) return this.enterInlineEditMode();
		if (matchesKey(data, "up")) return this.setScrollOffset(this.scrollOffset - 1);
		if (matchesKey(data, "down")) return this.setScrollOffset(this.scrollOffset + 1);
		if (matchesKey(data, "pageUp")) return this.setScrollOffset(this.scrollOffset - layout.viewportHeight);
		if (matchesKey(data, "pageDown")) return this.setScrollOffset(this.scrollOffset + layout.viewportHeight);
		if (matchesKey(data, "home")) return this.setScrollOffset(0);
		if (matchesKey(data, "end")) return this.setScrollOffset(layout.maxScrollOffset);
		if (data === "n") return this.jumpToHunk(layout.currentHunkIndex + 1);
		if (data === "p") return this.jumpToHunk(layout.currentHunkIndex - 1);
		if (matchesKey(data, "left") || data === "[") return this.adjustContext(-1);
		if (matchesKey(data, "right") || data === "]") return this.adjustContext(1);
		if (matchesKey(data, "tab")) return this.toggleMode();
		if (data === "w") return this.toggleWrap();
		return false;
	}

	render(width: number): string[] {
		this.lastWidth = Math.max(1, width);
		const layout = this.buildLayout(this.lastWidth);
		this.scrollOffset = clampNumber(this.scrollOffset, 0, layout.maxScrollOffset);

		const visible = layout.contentLines.slice(this.scrollOffset, this.scrollOffset + layout.viewportHeight);
		const linesAbove = this.scrollOffset;
		const linesBelow = Math.max(0, layout.contentLines.length - (this.scrollOffset + visible.length));
		const hunkInfo = layout.hunkOffsets.length > 0 ? `hunk ${layout.currentHunkIndex + 1}/${layout.hunkOffsets.length}` : "no hunks";
		const topIndicatorText = linesAbove > 0 ? `↑ ${pluralize("more line", linesAbove)} • ${hunkInfo}` : `Top of diff • ${hunkInfo}`;
		const bottomIndicatorText = linesBelow > 0 ? `↓ ${pluralize("more line", linesBelow)} • ${hunkInfo}` : `Bottom of diff • ${hunkInfo}`;

		const result: string[] = [];
		result.push(...layout.headerLines);
		result.push(...layout.columnLines);
		result.push(truncateToWidth(this.theme.fg("dim", topIndicatorText), layout.width, "", true));
		result.push(...visible);
		while (result.length < layout.headerLines.length + layout.columnLines.length + 1 + layout.viewportHeight) {
			result.push(" ".repeat(layout.width));
		}
		result.push(truncateToWidth(this.theme.fg("dim", bottomIndicatorText), layout.width, "", true));
		result.push(...layout.footerLines);
		return result;
	}
}

function isRpcMode(ctx: ExtensionContext): boolean {
	return ctx.ui.getAllThemes().length === 0;
}

export async function reviewChangePreview(
	ctx: ExtensionContext,
	preview: ChangePreview,
	options: ReviewOptions = {},
): Promise<DiffDecision> {
	const allowAfterEdit =
		Boolean(options.allowAfterEdit) && preview.beforeText !== undefined && preview.afterText !== undefined;
	const initialAfterText = preview.afterText;
	let currentPreview = preview;

	const getAfterTextOverride = () =>
		initialAfterText !== undefined && currentPreview.afterText !== undefined && currentPreview.afterText !== initialAfterText
			? currentPreview.afterText
			: undefined;

	if (isRpcMode(ctx)) {
		while (true) {
			await ctx.ui.editor(
				[
					"Review proposed file change",
					`Tool: ${currentPreview.toolName}`,
					`Path: ${currentPreview.path}`,
					`Diff: +${currentPreview.additions} / -${currentPreview.deletions}`,
					...currentPreview.summaryLines.map((line) => `- ${line}`),
					currentPreview.previewError ? `Preview warning: ${currentPreview.previewError}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				currentPreview.diff,
			);

			const choice = await ctx.ui.select(
				"How should pi handle this change?",
				[
					"Approve",
					"Reject",
					"Steer / request changes",
					...(allowAfterEdit ? ["Edit final file content"] : []),
					"Approve + enable auto-approve",
				],
			);

			if (choice === "Approve") return { action: "approve", afterTextOverride: getAfterTextOverride() };
			if (choice === "Approve + enable auto-approve") {
				return { action: "approve_and_enable_auto", afterTextOverride: getAfterTextOverride() };
			}
			if (choice === "Edit final file content" && allowAfterEdit) {
				const edited = await ctx.ui.editor(
					`Edit final contents for ${currentPreview.path}`,
					currentPreview.afterText ?? "",
				);
				if (edited !== undefined) {
					currentPreview = rebuildPreviewAfterManualEdit(currentPreview, edited);
				}
				continue;
			}
			if (choice === "Steer / request changes") {
				const feedback = await ctx.ui.editor(`How should ${currentPreview.path} change instead?`, "");
				return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
			}
			return { action: "reject" };
		}
	}

	const decision = await ctx.ui.custom<DiffDecision>((tui, theme, _kb, done) => {
		const viewer = new DiffViewer(tui, theme, preview, allowAfterEdit);
		const framed = new BorderFrame(viewer, (text) => theme.fg("accent", text));
		const centered = new CenteredFrame(framed, tui);
		const previousShowHardwareCursor = tui.getShowHardwareCursor();
		const syncCursorMode = () => tui.setShowHardwareCursor(viewer.isEditingInline() || previousShowHardwareCursor);
		syncCursorMode();

		return {
			render: (width: number) => centered.render(width),
			invalidate: () => centered.invalidate(),
			handleInput: (data: string) => {
				if (viewer.isEditingInline()) {
					if (viewer.handleInput(data)) {
						syncCursorMode();
						tui.requestRender();
					}
					return;
				}

				if (matchesKey(data, "return") || data === "a" || data === "y") {
					done({ action: "approve", afterTextOverride: viewer.getAfterTextOverride() });
					return;
				}
				if (matchesKey(data, "escape") || data === "r") {
					done({ action: "reject" });
					return;
				}
				if (data === "s") {
					done({ action: "steer" });
					return;
				}
				if (data === "A") {
					done({ action: "approve_and_enable_auto", afterTextOverride: viewer.getAfterTextOverride() });
					return;
				}

				if (viewer.handleInput(data)) {
					syncCursorMode();
					tui.requestRender();
				}
			},
			dispose: () => tui.setShowHardwareCursor(previousShowHardwareCursor),
		};
	});

	if (decision.action !== "steer") return decision;
	const feedback = await ctx.ui.editor(`How should ${preview.path} change instead?`, "");
	return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
}
