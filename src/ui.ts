import type { ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import {
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
import type { ChangePreview } from "./preview.js";
import {
	detectSyntaxLanguage,
	getSyntaxTokenColorAnsi,
	tokenizeSyntaxLine,
	type SyntaxSegment,
} from "./syntax-highlight.js";

export interface DiffDecision {
	action: "approve" | "reject" | "steer" | "approve_and_enable_auto";
	feedback?: string;
}

type ViewMode = "split" | "unified";
type DiffTone = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";

interface RenderedContent {
	lines: string[];
	hunkOffsets: number[];
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
	private readonly baseDiffModel?: StructuredDiff;
	private diffModel?: StructuredDiff;
	private contextLines: number;
	private readonly syntaxLanguage?: string;
	private readonly syntaxLineCache = new Map<string, SyntaxSegment[]>();

	constructor(
		private readonly tui: { terminal: { rows: number } },
		private readonly theme: Theme,
		private readonly preview: ChangePreview,
	) {
		this.baseDiffModel = preview.diffModel;
		this.diffModel = preview.diffModel;
		this.contextLines = preview.diffModel?.contextLines ?? 4;
		this.preferredMode = preview.diffModel ? "split" : "unified";
		this.syntaxLanguage = detectSyntaxLanguage(preview.path);
	}

	invalidate(): void {
		// Stateless render.
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
		const modeLabel =
			this.preferredMode === mode
				? mode
				: `${mode} (auto)`;
		const diffLine = [
			`${this.theme.fg("muted", "Diff:")} ${this.theme.fg("success", `+${this.preview.additions}`)} ${this.theme.fg("dim", "/")} ${this.theme.fg("error", `-${this.preview.deletions}`)}`,
			this.theme.fg("muted", this.formatHunkLabel(currentHunkIndex, totalHunks)),
			`${this.theme.fg("muted", "View:")} ${this.theme.fg("text", modeLabel)}`,
			`${this.theme.fg("muted", "Context:")} ${this.theme.fg("text", this.diffModel ? String(this.contextLines) : "—")}`,
			`${this.theme.fg("muted", "Wrap:")} ${this.theme.fg("text", this.wrapLongLines ? "on" : "off")}`,
		].join(` ${this.theme.fg("dim", "•")} `);
		const toolAndPath = `${this.theme.fg("muted", "Tool:")} ${this.theme.fg("text", normalizeTuiText(this.preview.toolName))} ${this.theme.fg("dim", "•")} ${this.theme.fg("muted", "Path:")} ${this.theme.fg("text", normalizeTuiText(this.preview.path))}`;
		const summaryLine = this.preview.previewError
			? this.theme.fg("warning", `Preview warning: ${normalizeTuiText(this.preview.previewError)}`)
			: this.theme.fg("dim", summarizeLines(this.preview.summaryLines));

		return [
			truncateToWidth(this.theme.bold(this.theme.fg("accent", "Review proposed file change")), width, "", false),
			truncateToWidth(toolAndPath, width, this.theme.fg("muted", "…"), false),
			truncateToWidth(diffLine, width, this.theme.fg("muted", "…"), false),
			truncateToWidth(summaryLine, width, this.theme.fg("muted", "…"), false),
		];
	}

	private buildColumnLines(width: number, mode: ViewMode): string[] {
		if (mode !== "split") return [];
		const split = this.getSplitLayout(width);
		const leftHeader = truncateToWidth(this.theme.bold(this.theme.fg("muted", "Original")), split.leftWidth, "", true);
		const rightHeader = truncateToWidth(this.theme.bold(this.theme.fg("muted", "Updated")), split.rightWidth, "", true);
		const divider = this.theme.fg(
			"borderMuted",
			`${"─".repeat(split.leftWidth)}─┼─${"─".repeat(split.rightWidth)}`,
		);
		return [leftHeader + split.gutterText + rightHeader, divider];
	}

	private buildFooterLines(width: number, mode: ViewMode): string[] {
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

	private styleDiffText(text: string, ranges: InlineRange[], tone: DiffTone): string {
		const safeText = normalizeTuiText(text);
		if (safeText.length === 0) return "";

		const chars = Array.from(safeText);
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

			output += this.styleSyntaxSegment(sliceChars(safeText, start, end), tone, token, highlighted);
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

	private renderSplitCell(
		row: StructuredDiffRow,
		side: "old" | "new",
		cellWidth: number,
		lineNumberWidth: number,
	): string[] {
		const prefixWidth = lineNumberWidth + 2;
		const contentWidth = Math.max(1, cellWidth - prefixWidth);
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

		if (lineNumber === undefined && text.length === 0) {
			return [" ".repeat(cellWidth)];
		}

		const styledText = this.styleDiffText(text, highlights, tone);
		const wrapped = this.wrapStyledText(styledText, contentWidth);
		const result: string[] = [];

		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : " ".repeat(prefixWidth);
			const line = truncateToWidth(prefix + wrapped[i]!, cellWidth, "", true);
			result.push(this.applyLineBackground(line, tone));
		}

		return result.length > 0 ? result : [" ".repeat(cellWidth)];
	}

	private renderSplitRow(
		row: StructuredDiffRow,
		leftWidth: number,
		rightWidth: number,
		gutterText: string,
		lineNumberWidth: number,
	): string[] {
		const leftLines = this.renderSplitCell(row, "old", leftWidth, lineNumberWidth);
		const rightLines = this.renderSplitCell(row, "new", rightWidth, lineNumberWidth);
		const total = Math.max(leftLines.length, rightLines.length);
		const lines: string[] = [];

		for (let i = 0; i < total; i++) {
			const left = truncateToWidth(leftLines[i] ?? "", leftWidth, "", true);
			const right = truncateToWidth(rightLines[i] ?? "", rightWidth, "", true);
			lines.push(left + gutterText + right);
		}

		return lines;
	}

	private renderUnifiedLine(
		sign: " " | "+" | "-",
		lineNumber: number | undefined,
		text: string,
		tone: DiffTone,
		highlights: InlineRange[],
		width: number,
		lineNumberWidth: number,
	): string[] {
		const prefixWidth = lineNumberWidth + 2;
		const contentWidth = Math.max(1, width - prefixWidth);
		const styledText = this.styleDiffText(text, highlights, tone);
		const wrapped = this.wrapStyledText(styledText, contentWidth);
		const lines: string[] = [];

		for (let i = 0; i < wrapped.length; i++) {
			const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : " ".repeat(prefixWidth);
			const line = truncateToWidth(prefix + wrapped[i]!, width, "", true);
			lines.push(this.applyLineBackground(line, tone));
		}

		return lines.length > 0 ? lines : [" ".repeat(width)];
	}

	private renderUnifiedRow(row: StructuredDiffRow, width: number, lineNumberWidth: number): string[] {
		if (row.kind === "equal") {
			return this.renderUnifiedLine(" ", row.oldLineNumber, row.oldText, "toolDiffContext", [], width, lineNumberWidth);
		}
		if (row.kind === "delete") {
			return this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth);
		}
		if (row.kind === "insert") {
			return this.renderUnifiedLine("+", row.newLineNumber, row.newText, "toolDiffAdded", row.newHighlights, width, lineNumberWidth);
		}

		return [
			...this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth),
			...this.renderUnifiedLine("+", row.newLineNumber, row.newText, "toolDiffAdded", row.newHighlights, width, lineNumberWidth),
		];
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
				lines.push(...rendered);
				continue;
			}

			lines.push(this.renderGapLine(item.label, width));
		}

		for (let i = nextHunkIndex; i < hunkOffsets.length; i++) {
			hunkOffsets[i] = lines.length;
		}

		return { lines, hunkOffsets };
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
		return { lines: lines.length > 0 ? lines : [""] , hunkOffsets: [] };
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
		const clampedOffset = clampNumber(this.scrollOffset, 0, maxScrollOffset);
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

export async function reviewChangePreview(ctx: ExtensionContext, preview: ChangePreview): Promise<DiffDecision> {
	if (isRpcMode(ctx)) {
		await ctx.ui.editor(
			[
				"Review proposed file change",
				`Tool: ${preview.toolName}`,
				`Path: ${preview.path}`,
				`Diff: +${preview.additions} / -${preview.deletions}`,
				...preview.summaryLines.map((line) => `- ${line}`),
				preview.previewError ? `Preview warning: ${preview.previewError}` : "",
			]
				.filter(Boolean)
				.join("\n"),
			preview.diff,
		);

		const choice = await ctx.ui.select("How should pi handle this change?", [
			"Approve",
			"Reject",
			"Steer / request changes",
			"Approve + enable auto-approve",
		]);

		if (choice === "Approve") return { action: "approve" };
		if (choice === "Approve + enable auto-approve") return { action: "approve_and_enable_auto" };
		if (choice === "Steer / request changes") {
			const feedback = await ctx.ui.editor(`How should ${preview.path} change instead?`, "");
			return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
		}
		return { action: "reject" };
	}

	const action = await ctx.ui.custom<DiffDecision["action"]>((tui, theme, _kb, done) => {
		const viewer = new DiffViewer(tui, theme, preview);
		const framed = new BorderFrame(viewer, (text) => theme.fg("accent", text));
		const centered = new CenteredFrame(framed, tui);

		return {
			render: (width: number) => centered.render(width),
			invalidate: () => centered.invalidate(),
			handleInput: (data: string) => {
				if (matchesKey(data, "return") || data === "a" || data === "y") {
					done("approve");
					return;
				}
				if (matchesKey(data, "escape") || data === "r") {
					done("reject");
					return;
				}
				if (data === "s") {
					done("steer");
					return;
				}
				if (data === "A") {
					done("approve_and_enable_auto");
					return;
				}

				if (viewer.handleInput(data)) {
					tui.requestRender();
				}
			},
		};
	});

	if (action === "approve") return { action };
	if (action === "approve_and_enable_auto") return { action };
	if (action === "reject") return { action };

	const feedback = await ctx.ui.editor(`How should ${preview.path} change instead?`, "");
	return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
}
