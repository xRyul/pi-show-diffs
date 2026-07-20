import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { t } from "./i18n.js";
import {
    CURSOR_MARKER,
    Editor,
    matchesKey,
    truncateToWidth,
    visibleWidth,
    wrapTextWithAnsi,
    type Component,
    type SizeValue,
    type KeyId,
} from "@earendil-works/pi-tui";

import {
    adjustStructuredDiffContext,
    type InlineRange,
    type StructuredDiff,
    type StructuredDiffHunk,
    type StructuredDiffRow,
    type StructuredDiffVisibleItem,
} from "./diff-utils.js";
import { DEFAULT_KEYBINDINGS, type DiffColorMode, type DiffKeybindings, type PathStyle } from "./config.js";
import { rebuildPreviewAfterManualEdit, type ChangePreview } from "./preview.js";
import { formatDisplayPath } from "./path-display.js";
import { detectSyntaxLanguage, tokenizeSyntaxLine, type SyntaxSegment } from "./syntax-highlight.js";

export interface DiffDecision {
    action: "approve" | "reject" | "steer" | "approve_and_enable_auto";
    feedback?: string;
    afterTextOverride?: string;
}

interface ReviewOptions {
    allowAfterEdit?: boolean;
    diffColorMode?: DiffColorMode;
    showDiffRail?: boolean;
    expandableLayout?: boolean;
    collapsedHeight?: string;
    expandedHeight?: string;
    expandedWidth?: string;
    pathStyle?: PathStyle;
    pathSegments?: number;
    keybindings?: DiffKeybindings;
}

type ViewMode = "split" | "unified";
type DiffTone = "toolDiffAdded" | "toolDiffRemoved" | "toolDiffContext";
type ChangedDiffTone = Exclude<DiffTone, "toolDiffContext">;

interface CursorOverlay {
    startOffset: number;
    lines: string[];
}

interface RenderedCell {
    lines: string[];
    cursorLineIndex?: number;
}

interface RenderedContent {
    lines: string[];
    hunkOffsets: number[];
    cursorOffset?: number;
    cursorOverlay?: CursorOverlay;
}

interface RenderedRowSpan {
    startOffset: number;
    lineCount: number;
}

interface RenderedDiffCache {
    lines: string[];
    hunkOffsets: number[];
    rowSpans: Array<RenderedRowSpan | undefined>;
    rowIndexByNewLine: number[];
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
    scrollOffset: number;
    currentHunkIndex: number;
    cursorOverlay?: CursorOverlay;
}

const TAB_REPLACEMENT = "    ";
const DIFF_RAIL_MARKER = "▌";
const MIN_SPLIT_COLUMN_WIDTH = 28;
const MIN_CONTEXT_LINES = 0;
const MAX_CONTEXT_LINES = 80;
const INLINE_CURSOR_OPEN = "\x1b[1;7m";
const INLINE_CURSOR_CLOSE = "\x1b[0m";
const INLINE_HIGHLIGHT_MAX_CHANGED_RATIO = 0.8;
const DEFAULT_DARK_DIFF_BACKGROUND_ANSI: Record<ChangedDiffTone, string> = {
    toolDiffAdded: "\x1b[48;2;58;86;74m",
    toolDiffRemoved: "\x1b[48;2;86;63;67m",
};
const DEFAULT_LIGHT_DIFF_BACKGROUND_ANSI: Record<ChangedDiffTone, string> = {
    toolDiffAdded: "\x1b[48;2;223;240;216m",
    toolDiffRemoved: "\x1b[48;2;242;222;222m",
};

interface RgbColor {
    r: number;
    g: number;
    b: number;
}

interface HslColor {
    h: number;
    s: number;
    l: number;
}

function rgbLuminance(color: RgbColor): number {
    return (color.r * 299 + color.g * 587 + color.b * 114) / 1000;
}

function isLightTheme(theme: Theme): boolean {
    const name = (theme.name ?? "").toLowerCase();
    if (name.includes("light")) return true;
    if (name.includes("dark")) return false;

    try {
        const bg = theme.getBgAnsi("toolPendingBg");
        const match = bg.match(/48;2;(\d+);(\d+);(\d+)/);
        if (match) {
            return rgbLuminance({
                r: Number(match[1]),
                g: Number(match[2]),
                b: Number(match[3]),
            }) > 128;
        }
    } catch {}

    return false;
}

function getDefaultDiffBackgrounds(theme: Theme): Record<ChangedDiffTone, string> {
    return isLightTheme(theme) ? DEFAULT_LIGHT_DIFF_BACKGROUND_ANSI : DEFAULT_DARK_DIFF_BACKGROUND_ANSI;
}


function getThemeDiffBackgrounds(theme: Theme): Record<ChangedDiffTone, string> {
    return {
        toolDiffAdded: theme.getBgAnsi("toolSuccessBg"),
        toolDiffRemoved: theme.getBgAnsi("toolErrorBg"),
    };
}

function getDiffBackgrounds(theme: Theme, mode: DiffColorMode): Record<ChangedDiffTone, string> {
    return mode === "theme" ? getThemeDiffBackgrounds(theme) : getDefaultDiffBackgrounds(theme);
}

function parseTrueColorBackgroundAnsi(ansi: string): RgbColor | undefined {
    const match = ansi.match(/\x1b\[48;2;(\d{1,3});(\d{1,3});(\d{1,3})m/);
    if (!match) return undefined;

    const rgb = {
        r: Number(match[1]),
        g: Number(match[2]),
        b: Number(match[3]),
    };
    return [rgb.r, rgb.g, rgb.b].every((channel) => Number.isInteger(channel) && channel >= 0 && channel <= 255)
        ? rgb
        : undefined;
}

function rgbToHsl(color: RgbColor): HslColor {
    const r = color.r / 255;
    const g = color.g / 255;
    const b = color.b / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r:
                h = (g - b) / d + (g < b ? 6 : 0);
                break;
            case g:
                h = (b - r) / d + 2;
                break;
            default:
                h = (r - g) / d + 4;
                break;
        }
        h /= 6;
    }

    return { h, s, l };
}

function hueToRgb(p: number, q: number, t: number): number {
    let hue = t;
    if (hue < 0) hue += 1;
    if (hue > 1) hue -= 1;
    if (hue < 1 / 6) return p + (q - p) * 6 * hue;
    if (hue < 1 / 2) return q;
    if (hue < 2 / 3) return p + (q - p) * (2 / 3 - hue) * 6;
    return p;
}

function hslToRgb(color: HslColor): RgbColor {
    if (color.s === 0) {
        const channel = Math.round(color.l * 255);
        return { r: channel, g: channel, b: channel };
    }

    const q = color.l < 0.5 ? color.l * (1 + color.s) : color.l + color.s - color.l * color.s;
    const p = 2 * color.l - q;
    return {
        r: Math.round(hueToRgb(p, q, color.h + 1 / 3) * 255),
        g: Math.round(hueToRgb(p, q, color.h) * 255),
        b: Math.round(hueToRgb(p, q, color.h - 1 / 3) * 255),
    };
}

function formatTrueColorBackgroundAnsi(color: RgbColor): string {
    return `\x1b[48;2;${color.r};${color.g};${color.b}m`;
}

function intensifyDiffBackground(ansi: string): string | undefined {
    const rgb = parseTrueColorBackgroundAnsi(ansi);
    if (!rgb) return undefined;

    const hsl = rgbToHsl(rgb);
    const isLightBackground = rgbLuminance(rgb) > 128;
    return formatTrueColorBackgroundAnsi(hslToRgb({
        h: hsl.h,
        s: clampNumber(hsl.s * 1.3 + 0.08, 0, 1),
        l: clampNumber(hsl.l + (isLightBackground ? -0.12 : 0.1), 0.18, 0.86),
    }));
}

function getInlineDiffBackgrounds(lineBackgrounds: Record<ChangedDiffTone, string>): Record<ChangedDiffTone, string> {
    return {
        toolDiffAdded: intensifyDiffBackground(lineBackgrounds.toolDiffAdded) ?? lineBackgrounds.toolDiffAdded,
        toolDiffRemoved: intensifyDiffBackground(lineBackgrounds.toolDiffRemoved) ?? lineBackgrounds.toolDiffRemoved,
    };
}

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


class DiffViewer implements Component {
    private scrollOffset = 0;
    private lastWidth = 80;
    private wrapLongLines = true;
    private expandedView = false;
    private preferredMode: ViewMode;
    private baseDiffModel?: StructuredDiff;
    private diffModel?: StructuredDiff;
    private contextLines: number;
    private readonly syntaxLanguage?: string;
    private readonly syntaxLineCache = new Map<string, SyntaxSegment[]>();
    private readonly diffBackgrounds: Record<ChangedDiffTone, string>;
    private readonly diffInlineBackgrounds: Record<ChangedDiffTone, string>;
    private preview: ChangePreview;
    private readonly initialAfterText?: string;
    private fullContextLines: number;
    private inlineEditMode = false;
    private inlineEditor?: Editor;
    private savedContextLinesBeforeInlineEdit?: number;
    private selectedHunkIndex?: number;
    private readonly diffModelCacheIds = new WeakMap<StructuredDiff, number>();
    private nextDiffModelCacheId = 1;
    private lastRenderedDiffCache?: { key: string; value: RenderedDiffCache };
    private readonly cursorlessRowCache = new Map<string, RenderedCell>();
    private readonly gapLineCache = new Map<string, string>();
    private readonly kb: DiffKeybindings;

    constructor(
        private readonly tui: { terminal: { rows: number } },
        private readonly theme: Theme,
        preview: ChangePreview,
        private readonly allowAfterEdit: boolean,
        diffColorMode: DiffColorMode,
        private readonly showDiffRail: boolean = true,
        private readonly collapsedHeightPercent: number = 90,
        private readonly expandedHeightPercent: number = 100,
        private readonly expandableLayoutHint: boolean = false,
        keybindings?: DiffKeybindings,
        private readonly pathStyle: PathStyle = "full",
        private readonly pathSegments: number = 3,
    ) {
        this.kb = keybindings ?? DEFAULT_KEYBINDINGS;
        this.diffBackgrounds = getDiffBackgrounds(theme, diffColorMode);
        this.diffInlineBackgrounds = getInlineDiffBackgrounds(this.diffBackgrounds);
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
        this.lastRenderedDiffCache = undefined;
    }

    isEditingInline(): boolean {
        return this.inlineEditMode;
    }

    getAfterTextOverride(): string | undefined {
        return this.initialAfterText !== undefined && this.preview.afterText !== undefined && this.preview.afterText !== this.initialAfterText
            ? this.preview.afterText
            : undefined;
    }

    getPreview(): ChangePreview {
        return this.preview;
    }

    setPreview(preview: ChangePreview): void {
        this.applyUpdatedPreview(preview);
        if (this.inlineEditor && this.inlineEditor.getText() !== (preview.afterText ?? "")) {
            this.inlineEditor.setText(preview.afterText ?? "");
        }
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
        this.lastRenderedDiffCache = undefined;
        if (this.inlineEditMode && this.baseDiffModel) {
            this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.fullContextLines);
            return;
        }
        if (this.baseDiffModel) {
            this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.contextLines);
        }
    }

    private getDiffModelCacheId(diff: StructuredDiff): number {
        const existing = this.diffModelCacheIds.get(diff);
        if (existing !== undefined) return existing;

        const nextId = this.nextDiffModelCacheId++;
        this.diffModelCacheIds.set(diff, nextId);
        return nextId;
    }

    private serializeInlineRanges(ranges: InlineRange[]): string {
        return ranges.map((range) => `${range.start}:${range.end}`).join(",");
    }

    private getCursorlessRowCacheKey(
        mode: ViewMode,
        row: StructuredDiffRow,
        width: number,
        lineNumberWidth: number,
        split?: { leftWidth: number; rightWidth: number },
    ): string {
        return [
            mode,
            width,
            lineNumberWidth,
            this.showDiffRail ? "rail" : "no-rail",
            this.wrapLongLines ? "wrap" : "nowrap",
            split?.leftWidth ?? "",
            split?.rightWidth ?? "",
            row.kind,
            row.oldLineNumber ?? "",
            row.newLineNumber ?? "",
            this.serializeInlineRanges(row.oldHighlights),
            this.serializeInlineRanges(row.newHighlights),
            row.oldText,
            row.newText,
        ].join("\u001f");
    }

    private getCachedCursorlessRow(key: string, render: () => RenderedCell): RenderedCell {
        const cached = this.cursorlessRowCache.get(key);
        if (cached) return cached;

        const rendered = render();
        if (this.cursorlessRowCache.size >= 10_000) {
            this.cursorlessRowCache.clear();
        }
        this.cursorlessRowCache.set(key, rendered);
        return rendered;
    }

    private getCachedGapLine(label: string, width: number): string {
        const key = `${width}\u001f${label}`;
        const cached = this.gapLineCache.get(key);
        if (cached) return cached;

        const rendered = centerAnsiText(this.theme.fg("muted", label), width);
        if (this.gapLineCache.size >= 1_000) {
            this.gapLineCache.clear();
        }
        this.gapLineCache.set(key, rendered);
        return rendered;
    }

    enterInlineEditMode(): boolean {
        if (!this.allowAfterEdit) return false;
        const sourceDiff = this.diffModel ?? this.baseDiffModel;
        const layout = this.buildLayout(this.lastWidth);
        const targetHunkIndex =
            sourceDiff && sourceDiff.hunks.length > 0
                ? clampNumber(this.selectedHunkIndex ?? layout.currentHunkIndex, 0, sourceDiff.hunks.length - 1)
                : 0;
        const anchor = this.getInlineEditAnchor(targetHunkIndex);
        this.ensureInlineEditor();
        this.inlineEditMode = true;
        this.savedContextLinesBeforeInlineEdit = this.contextLines;
        this.preferredMode = "split";
        if (this.baseDiffModel) {
            this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, this.fullContextLines);
        }
        this.selectedHunkIndex = targetHunkIndex;
        this.setInlineEditorCursor(anchor.line, anchor.col);
        this.focusHunk(targetHunkIndex);
        return true;
    }

    exitInlineEditMode(): boolean {
        if (!this.inlineEditMode) return false;
        const currentInlineHunkIndex = this.getCurrentInlineHunkIndex();
        this.inlineEditMode = false;
        this.selectedHunkIndex = currentInlineHunkIndex;
        if (this.baseDiffModel) {
            const restoredContext = this.savedContextLinesBeforeInlineEdit ?? this.contextLines;
            this.contextLines = restoredContext;
            this.diffModel = adjustStructuredDiffContext(this.baseDiffModel, restoredContext);
            this.focusHunk(currentInlineHunkIndex);
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

    private getInlineEditAnchor(targetHunkIndex?: number): { line: number; col: number } {
        const navigationDiff = this.getNavigationDiff();
        if (!navigationDiff || navigationDiff.hunks.length === 0) return { line: 0, col: 0 };
        const layout = this.buildLayout(this.lastWidth);
        const safeTarget = clampNumber(targetHunkIndex ?? this.selectedHunkIndex ?? layout.currentHunkIndex, 0, navigationDiff.hunks.length - 1);
        const hunk = navigationDiff.hunks[safeTarget]!;
        return { line: this.getHunkAnchorLine(hunk), col: 0 };
    }

    private focusHunk(targetHunkIndex: number): void {
        const layout = this.buildLayout(this.lastWidth);
        if (layout.hunkOffsets.length === 0) {
            this.scrollOffset = 0;
            return;
        }
        const safeTarget = clampNumber(targetHunkIndex, 0, layout.hunkOffsets.length - 1);
        const anchorOffset = layout.hunkOffsets[safeTarget] ?? 0;
        this.scrollOffset = clampNumber(anchorOffset - Math.floor(layout.viewportHeight / 4), 0, layout.maxScrollOffset);
    }

    private getCurrentInlineHunkIndex(): number {
        const navigationDiff = this.getNavigationDiff();
        if (!navigationDiff || navigationDiff.hunks.length === 0) return 0;
        const cursor = this.getInlineCursor();
        if (!cursor) return this.buildLayout(this.lastWidth).currentHunkIndex;
        let current = 0;
        for (let i = 0; i < navigationDiff.hunks.length; i++) {
            if (this.getHunkAnchorLine(navigationDiff.hunks[i]!) <= cursor.line) current = i;
            else break;
        }
        return current;
    }

    private jumpInlineEditorToHunk(targetHunkIndex: number): boolean {
        const navigationDiff = this.getNavigationDiff();
        if (!navigationDiff || navigationDiff.hunks.length === 0) return false;
        const safeTarget = clampNumber(targetHunkIndex, 0, navigationDiff.hunks.length - 1);
        this.selectedHunkIndex = safeTarget;
        this.setInlineEditorCursor(this.getHunkAnchorLine(navigationDiff.hunks[safeTarget]!), 0);
        this.focusHunk(safeTarget);
        return true;
    }

    private getTotalHeight(): number {
        const rows = this.tui.terminal.rows || 24;
        const maxHeight = Math.max(4, rows - 2);
        if (this.expandedView) {
            const height = Math.floor((rows * this.expandedHeightPercent) / 100) - 4;
            return clampNumber(Math.max(16, height), 4, maxHeight);
        }

        const minHeight = this.collapsedHeightPercent >= 80 ? 16 : 10;
        const height = Math.floor((rows * this.collapsedHeightPercent) / 100);
        return clampNumber(Math.max(minHeight, height), 4, maxHeight);
    }

    setExpanded(value: boolean): void {
        this.expandedView = value;
        this.lastRenderedDiffCache = undefined;
    }

    private buildKeymap(layout: ViewerLayout): Map<string, () => boolean> {
        const { kb } = this;
        const actionDefs: Array<[string[] | false, () => boolean]> = [
            [kb.editInline, () => this.allowAfterEdit ? this.enterInlineEditMode() : false],
            [kb.scrollUp, () => this.setScrollOffset(this.scrollOffset - 1)],
            [kb.scrollDown, () => this.setScrollOffset(this.scrollOffset + 1)],
            [kb.pageUp, () => this.setScrollOffset(this.scrollOffset - layout.viewportHeight)],
            [kb.pageDown, () => this.setScrollOffset(this.scrollOffset + layout.viewportHeight)],
            [kb.scrollTop, () => this.setScrollOffset(0)],
            [kb.scrollBottom, () => this.setScrollOffset(layout.maxScrollOffset)],
            [kb.nextHunk, () => this.jumpToHunk(layout.currentHunkIndex + 1)],
            [kb.prevHunk, () => this.jumpToHunk(layout.currentHunkIndex - 1)],
            [kb.contextLess, () => this.adjustContext(-1)],
            [kb.contextMore, () => this.adjustContext(1)],
            [kb.toggleMode, () => this.toggleMode()],
            [kb.toggleWrap, () => this.toggleWrap()],
        ];
        const keymap = new Map<string, () => boolean>();
        for (const [binding, action] of actionDefs) {
            if (!binding) continue;
            for (const key of binding) keymap.set(key, action);
        }
        return keymap;
    }

    private resolveAction(data: string, layout: ViewerLayout): (() => boolean) | undefined {
        const keymap = this.buildKeymap(layout);
        const direct = keymap.get(data);
        if (direct) return direct;
        for (const [key, action] of keymap) {
            if (key.includes("+") || key.length > 1) {
                if (matchesKey(data, key as KeyId)) return action;
            }
        }
        return undefined;
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

    private getViewportHunkFocusOffset(scrollOffset: number, viewportHeight: number): number {
        return Math.max(0, scrollOffset + Math.floor(Math.max(0, viewportHeight) / 4));
    }

    private getCurrentHunkIndex(hunkOffsets: number[], focusOffset: number): number {
        if (hunkOffsets.length === 0) return 0;
        let current = 0;
        for (let i = 0; i < hunkOffsets.length; i++) {
            if (focusOffset >= (hunkOffsets[i] ?? 0)) current = i;
            else break;
        }
        return current;
    }

    private getNavigationDiff(): StructuredDiff | undefined {
        return this.baseDiffModel ?? this.diffModel;
    }

    private formatHunkLabel(currentHunkIndex: number, totalHunks: number): string {
        const navigationDiff = this.getNavigationDiff();
        if (!navigationDiff || totalHunks === 0) return "Hunk: none";
        const hunk = navigationDiff.hunks[clampNumber(currentHunkIndex, 0, totalHunks - 1)]!;
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
            `${this.theme.fg("muted", t("ui.diff", "Diff:"))} ${this.theme.fg("success", `+${this.preview.additions}`)} ${this.theme.fg("dim", "/")} ${this.theme.fg("error", `-${this.preview.deletions}`)}`,
            this.theme.fg("muted", this.formatHunkLabel(currentHunkIndex, totalHunks)),
            `${this.theme.fg("muted", t("ui.view", "View:"))} ${this.theme.fg("text", modeLabel)}`,
            `${this.theme.fg("muted", t("ui.context", "Context:"))} ${this.theme.fg("text", this.diffModel ? String(this.inlineEditMode ? "all" : this.contextLines) : "—")}`,
            `${this.theme.fg("muted", t("ui.wrap", "Wrap:"))} ${this.theme.fg("text", this.wrapLongLines ? "on" : "off")}`,
        ].join(` ${this.theme.fg("dim", "•")} `);
        const displayPath = formatDisplayPath(this.preview.path, this.pathStyle, this.pathSegments);
        const toolAndPath = `${this.theme.fg("muted", t("ui.tool", "Tool:"))} ${this.theme.fg("text", normalizeTuiText(this.preview.toolName))} ${this.theme.fg("dim", "•")} ${this.theme.fg("muted", t("ui.path", "Path:"))} ${this.theme.fg("text", normalizeTuiText(displayPath))}`;
        const summaryLine = this.preview.previewError
            ? this.theme.fg("warning", t("ui.previewWarning", `Preview warning: ${normalizeTuiText(this.preview.previewError)}`, { message: normalizeTuiText(this.preview.previewError) }))
            : this.theme.fg("dim", summarizeLines(this.preview.summaryLines));
        const title = this.inlineEditMode ? t("ui.titleEdit", "Review proposed file change · INLINE EDIT") : t("ui.title", "Review proposed file change");

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
        const leftHeader = truncateToWidth(this.theme.bold(this.theme.fg("muted", t("ui.original", "Original"))), split.leftWidth, "", true);
        const rightTitle = this.inlineEditMode ? this.theme.fg("accent", t("ui.updatedEditing", "Updated (editing)")) : this.theme.fg("muted", t("ui.updated", "Updated"));
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
                        "Editing inline • Esc review • Ctrl+N/Ctrl+P hunks • Alt/Option+↓/↑ if your terminal sends Alt • Enter newline • Tab indent",
                    ),
                    width,
                    "",
                    false,
                ),
            ];
        }

        const { kb } = this;
        const keyLabel = (key: string): string => {
            const labels: Record<string, string> = {
                up: "↑",
                down: "↓",
                left: "←",
                right: "→",
                pageUp: "PgUp",
                pageDown: "PgDn",
                home: "Home",
                end: "End",
                Escape: "Esc",
                escape: "Esc",
                Tab: "Tab",
                tab: "Tab",
            };
            return labels[key] ?? key;
        };
        const formatBinding = (binding: string[] | false): string | null => {
            if (!binding || binding.length === 0) return null;
            return binding.map(keyLabel).join("/");
        };
        const fmt = (binding: string[] | false, label: string): string | null => {
            const keys = formatBinding(binding);
            return keys ? `${keys} ${label}` : null;
        };
        const fmtPair = (first: string[] | false, second: string[] | false, label: string): string | null => {
            const firstKeys = formatBinding(first);
            const secondKeys = formatBinding(second);
            return firstKeys && secondKeys ? `${firstKeys}/${secondKeys} ${label}` : null;
        };
        const hasHunks = (this.getNavigationDiff()?.hunks.length ?? 0) > 0;
        const hasStructuredDiff = Boolean(this.baseDiffModel);

        const parts: string[] = [
            hasHunks ? fmt(kb.prevHunk, "prev") : null,
            hasHunks ? fmt(kb.nextHunk, "next") : null,
            fmtPair(kb.scrollUp, kb.scrollDown, "scroll"),
            fmtPair(kb.pageUp, kb.pageDown, "jump"),
            fmtPair(kb.scrollTop, kb.scrollBottom, "edges"),
            hasStructuredDiff ? fmtPair(kb.contextLess, kb.contextMore, "ctx-/+") : null,
            hasStructuredDiff ? fmt(kb.toggleMode, "split/unified") : null,
            fmt(kb.toggleWrap, "wrap"),
            this.allowAfterEdit ? fmt(kb.editInline, t("ui.footerEditAction", "edit")) : null,
            this.expandableLayoutHint ? fmt(kb.toggleExpand, this.expandedView ? t("ui.footerCollapseAction", "collapse") : t("ui.footerExpandAction", "expand")) : null,
            fmt(kb.approve, t("ui.footerApproveAction", "approve")),
            fmt(kb.reject, t("ui.footerRejectAction", "reject")),
            fmt(kb.steer, t("ui.footerSteerAction", "steer")),
            fmt(kb.autoApprove, t("ui.footerAutoAction", "auto")),
        ].filter((part): part is string => part !== null);
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
        return this.diffBackgrounds[tone];
    }

    private getInlineBackgroundAnsiForTone(tone: DiffTone): string | undefined {
        if (tone === "toolDiffContext") return undefined;
        return this.diffInlineBackgrounds[tone];
    }

    private applyInlineHighlight(text: string, tone: DiffTone): string {
        const inlineBackgroundAnsi = this.getInlineBackgroundAnsiForTone(tone);
        if (!inlineBackgroundAnsi) return this.theme.bold(text);

        const baseBackgroundAnsi = this.getBackgroundAnsiForTone(tone) ?? "\x1b[49m";
        return `${inlineBackgroundAnsi}${this.theme.bold(text)}${baseBackgroundAnsi}`;
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

    private static readonly TOKEN_TO_THEME: Record<string, string> = {
        keyword: "syntaxKeyword", literal: "syntaxNumber", "meta-keyword": "syntaxKeyword",
        built_in: "syntaxType", type: "syntaxType", class: "syntaxType", name: "syntaxType",
        string: "syntaxString", regexp: "syntaxString", "meta-string": "syntaxString",
        link: "syntaxString", code: "syntaxString",
        number: "syntaxNumber", symbol: "syntaxNumber",
        comment: "syntaxComment", doctag: "syntaxComment", quote: "syntaxComment",
        function: "syntaxFunction", title: "syntaxFunction",
        attr: "syntaxVariable", attribute: "syntaxVariable", variable: "syntaxVariable",
        "template-variable": "syntaxVariable", params: "syntaxVariable",
        operator: "syntaxOperator", punctuation: "syntaxPunctuation",
        meta: "syntaxKeyword", tag: "syntaxKeyword",
        "selector-tag": "syntaxType", "selector-id": "syntaxKeyword",
        "selector-pseudo": "syntaxKeyword", "selector-class": "syntaxFunction",
        "selector-attr": "syntaxVariable",
        addition: "syntaxString", deletion: "syntaxVariable",
        "template-tag": "syntaxKeyword", "builtin-name": "syntaxType",
        section: "syntaxType", bullet: "syntaxNumber",
        emphasis: "syntaxVariable", strong: "syntaxVariable", formula: "syntaxNumber",
        subst: "syntaxOperator",
    };

    private styleSyntaxSegment(
        text: string,
        tone: DiffTone,
        token: SyntaxSegment["token"],
        highlighted: boolean,
        useInlineBackground: boolean,
    ): string {
        const themeToken = token ? (this.constructor as typeof DiffViewer).TOKEN_TO_THEME[token] : undefined;
        const styled = themeToken
            ? this.theme.fg(themeToken as any, text)
            : this.theme.fg(this.getForegroundForTone(tone), text);

        if (!highlighted) return styled;
        return useInlineBackground ? this.applyInlineHighlight(styled, tone) : this.theme.bold(styled);
    }

    private styleDiffText(text: string, ranges: InlineRange[], tone: DiffTone, cursorCol?: number): string {
        const safeText = normalizeTuiText(text);
        const chars = Array.from(safeText);
        const clampedCursorCol = cursorCol === undefined ? undefined : clampNumber(cursorCol, 0, chars.length);
        if (safeText.length === 0) {
            if (clampedCursorCol === undefined) return "";
            return this.inlineEditMode ? CURSOR_MARKER : `${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
        }

        const safeRanges = ranges
            .map((range) => ({
                start: clampNumber(range.start, 0, chars.length),
                end: clampNumber(range.end, 0, chars.length),
            }))
            .filter((range) => range.end > range.start)
            .sort((a, b) => a.start - b.start || a.end - b.end);
        const highlightedCharCount = safeRanges.reduce((total, range) => total + range.end - range.start, 0);
        const useInlineHighlightBackground =
            highlightedCharCount > 0 && highlightedCharCount < chars.length * INLINE_HIGHLIGHT_MAX_CHANGED_RATIO;

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

            output += this.styleSyntaxSegment(segmentText, tone, token, highlighted, highlighted && useInlineHighlightBackground);
        }

        if (clampedCursorCol !== undefined && clampedCursorCol === chars.length) {
            output += this.inlineEditMode ? CURSOR_MARKER : `${INLINE_CURSOR_OPEN} ${INLINE_CURSOR_CLOSE}`;
        }

        return output;
    }

    private getCellPrefixWidth(lineNumberWidth: number): number {
        return lineNumberWidth + 2 + (this.showDiffRail ? 1 : 0);
    }

    private getRailColorToken(tone: DiffTone): "success" | "error" | "muted" {
        if (tone === "toolDiffAdded") return "success";
        if (tone === "toolDiffRemoved") return "error";
        return "muted";
    }

    private buildRailMarker(tone: DiffTone): string {
        if (!this.showDiffRail) return "";
        return this.theme.fg(this.getRailColorToken(tone), DIFF_RAIL_MARKER);
    }

    private buildCellPrefix(sign: string, lineNumber: number | undefined, lineNumberWidth: number, tone: DiffTone): string {
        const numberText = lineNumber === undefined ? "".padStart(lineNumberWidth, " ") : String(lineNumber).padStart(lineNumberWidth, " ");
        const foreground = this.getForegroundForTone(tone);
        const isChangedLine = tone !== "toolDiffContext";
        const signText = sign.trim().length === 0 ? sign : this.theme.bold(this.theme.fg(foreground, sign));
        const numberStyle = isChangedLine
            ? this.theme.bold(this.theme.fg(foreground, numberText))
            : this.theme.fg("muted", numberText);
        return `${this.buildRailMarker(tone)}${signText}${numberStyle} `;
    }

    private buildCellContinuationPrefix(lineNumberWidth: number, tone: DiffTone): string {
        return `${this.buildRailMarker(tone)}${" ".repeat(lineNumberWidth + 2)}`;
    }

    private renderEmptySplitCell(cellWidth: number, lineNumberWidth: number): RenderedCell {
        if (!this.showDiffRail) {
            return { lines: [" ".repeat(cellWidth)] };
        }

        const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
        const prefix = this.buildCellPrefix(" ", undefined, lineNumberWidth, "toolDiffContext");
        const fill = " ".repeat(Math.max(0, cellWidth - prefixWidth));
        return { lines: [truncateToWidth(prefix + fill, cellWidth, "", true)] };
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
        cursorCol?: number,
    ): RenderedCell {
        const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
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

        if (lineNumber === undefined && text.length === 0 && cursorCol === undefined) {
            return this.renderEmptySplitCell(cellWidth, lineNumberWidth);
        }

        const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
        const wrapped = this.wrapStyledText(styledText, contentWidth);
        const result: string[] = [];
        let cursorLineIndex: number | undefined;

        for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : this.buildCellContinuationPrefix(lineNumberWidth, tone);
            const line = truncateToWidth(prefix + wrapped[i]!, cellWidth, "", true);
            if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER)) cursorLineIndex = i;
            result.push(this.applyLineBackground(line, tone));
        }

        return { lines: result.length > 0 ? result : [" ".repeat(cellWidth)], cursorLineIndex };
    }

    private renderSplitRowWithCursor(
        row: StructuredDiffRow,
        leftWidth: number,
        rightWidth: number,
        gutterText: string,
        lineNumberWidth: number,
        cursorCol?: number,
    ): RenderedCell {
        const leftCell = this.renderSplitCell(row, "old", leftWidth, lineNumberWidth);
        const rightCell = this.renderSplitCell(row, "new", rightWidth, lineNumberWidth, cursorCol);
        const total = Math.max(leftCell.lines.length, rightCell.lines.length);
        const lines: string[] = [];

        for (let i = 0; i < total; i++) {
            const leftLine = leftCell.lines[i] ?? this.renderEmptySplitCell(leftWidth, lineNumberWidth).lines[0] ?? "";
            const rightLine = rightCell.lines[i] ?? this.renderEmptySplitCell(rightWidth, lineNumberWidth).lines[0] ?? "";
            const left = truncateToWidth(leftLine, leftWidth, "", true);
            const right = truncateToWidth(rightLine, rightWidth, "", true);
            lines.push(left + gutterText + right);
        }

        return { lines, cursorLineIndex: rightCell.cursorLineIndex };
    }

    private renderSplitRow(
        row: StructuredDiffRow,
        leftWidth: number,
        rightWidth: number,
        gutterText: string,
        lineNumberWidth: number,
    ): RenderedCell {
        return this.renderSplitRowWithCursor(row, leftWidth, rightWidth, gutterText, lineNumberWidth, this.getCursorColForRow(row, "new"));
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
        const prefixWidth = this.getCellPrefixWidth(lineNumberWidth);
        const contentWidth = Math.max(1, width - prefixWidth);
        this.syncInlineEditorLayoutWidth(contentWidth);
        const styledText = this.styleDiffText(text, highlights, tone, cursorCol);
        const wrapped = this.wrapStyledText(styledText, contentWidth);
        const lines: string[] = [];
        let cursorLineIndex: number | undefined;

        for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? this.buildCellPrefix(sign, lineNumber, lineNumberWidth, tone) : this.buildCellContinuationPrefix(lineNumberWidth, tone);
            const line = truncateToWidth(prefix + wrapped[i]!, width, "", true);
            if (cursorLineIndex === undefined && line.includes(CURSOR_MARKER)) cursorLineIndex = i;
            lines.push(this.applyLineBackground(line, tone));
        }

        return { lines: lines.length > 0 ? lines : [" ".repeat(width)], cursorLineIndex };
    }

    private renderUnifiedRowWithCursor(
        row: StructuredDiffRow,
        width: number,
        lineNumberWidth: number,
        cursorCol?: number,
    ): RenderedCell {
        if (row.kind === "equal") {
            return this.renderUnifiedLine(" ", row.oldLineNumber, row.oldText, "toolDiffContext", [], width, lineNumberWidth, cursorCol);
        }
        if (row.kind === "delete") {
            return this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth);
        }
        if (row.kind === "insert") {
            return this.renderUnifiedLine("+", row.newLineNumber, row.newText, "toolDiffAdded", row.newHighlights, width, lineNumberWidth, cursorCol);
        }

        const removed = this.renderUnifiedLine("-", row.oldLineNumber, row.oldText, "toolDiffRemoved", row.oldHighlights, width, lineNumberWidth);
        const added = this.renderUnifiedLine("+", row.newLineNumber, row.newText, "toolDiffAdded", row.newHighlights, width, lineNumberWidth, cursorCol);
        return {
            lines: [...removed.lines, ...added.lines],
            cursorLineIndex: added.cursorLineIndex === undefined ? undefined : removed.lines.length + added.cursorLineIndex,
        };
    }

    private renderUnifiedRow(row: StructuredDiffRow, width: number, lineNumberWidth: number): RenderedCell {
        return this.renderUnifiedRowWithCursor(row, width, lineNumberWidth, this.getCursorColForRow(row, "new"));
    }

    private renderGapLine(label: string, width: number): string {
        return this.getCachedGapLine(label, width);
    }

    private getRenderedDiffCache(width: number, mode: ViewMode): RenderedDiffCache | undefined {
        if (!this.diffModel) return undefined;

        const lineNumberWidth = this.getLineNumberWidth();
        const cacheKey = [
            this.getDiffModelCacheId(this.diffModel),
            mode,
            width,
            lineNumberWidth,
            this.wrapLongLines ? "wrap" : "nowrap",
            this.showDiffRail ? "rail" : "no-rail",
        ].join("|");
        if (this.lastRenderedDiffCache?.key === cacheKey) {
            return this.lastRenderedDiffCache.value;
        }

        const navigationDiff = this.getNavigationDiff() ?? this.diffModel;
        const navigationHunks = navigationDiff.hunks;
        const lines: string[] = [];
        const hunkOffsets: number[] = new Array(navigationHunks.length).fill(0);
        const rowSpans: Array<RenderedRowSpan | undefined> = new Array(this.diffModel.rows.length);
        const rowIndexByNewLine: number[] = new Array(this.diffModel.totalNewLines + 1);
        let nextHunkIndex = 0;

        const split = mode === "split" ? this.getSplitLayout(width) : undefined;

        for (const item of this.diffModel.visibleItems) {
            if (item.type === "row") {
                while (
                    nextHunkIndex < navigationHunks.length &&
                    navigationHunks[nextHunkIndex]!.changeStartRow === item.fullRowIndex
                ) {
                    hunkOffsets[nextHunkIndex] = lines.length;
                    nextHunkIndex++;
                }

                const rowStartOffset = lines.length;
                const rendered =
                    mode === "split" && split
                        ? this.getCachedCursorlessRow(
                            this.getCursorlessRowCacheKey(mode, item.row, width, lineNumberWidth, split),
                            () => this.renderSplitRowWithCursor(item.row, split.leftWidth, split.rightWidth, split.gutterText, lineNumberWidth),
                        )
                        : this.getCachedCursorlessRow(
                            this.getCursorlessRowCacheKey(mode, item.row, width, lineNumberWidth),
                            () => this.renderUnifiedRowWithCursor(item.row, width, lineNumberWidth),
                        );

                rowSpans[item.fullRowIndex] = { startOffset: rowStartOffset, lineCount: rendered.lines.length };
                if (item.row.newLineNumber !== undefined) {
                    rowIndexByNewLine[item.row.newLineNumber] = item.fullRowIndex;
                }
                lines.push(...rendered.lines);
                continue;
            }

            lines.push(this.renderGapLine(item.label, width));
        }

        for (let i = nextHunkIndex; i < hunkOffsets.length; i++) {
            hunkOffsets[i] = lines.length;
        }

        const value = { lines, hunkOffsets, rowSpans, rowIndexByNewLine };
        this.lastRenderedDiffCache = { key: cacheKey, value };
        return value;
    }

    private getCursorOverlay(
        width: number,
        mode: ViewMode,
        content: RenderedDiffCache,
    ): { cursorOffset?: number; cursorOverlay?: CursorOverlay } {
        if (!this.inlineEditMode || !this.diffModel) return {};

        const cursor = this.getInlineCursor();
        if (!cursor) return {};

        const rowIndex = content.rowIndexByNewLine[cursor.line + 1];
        if (rowIndex === undefined) return {};

        const row = this.diffModel.rows[rowIndex];
        const rowSpan = content.rowSpans[rowIndex];
        if (!row || !rowSpan) return {};

        const lineNumberWidth = this.getLineNumberWidth();
        const split = mode === "split" ? this.getSplitLayout(width) : undefined;
        const rendered =
            mode === "split" && split
                ? this.renderSplitRowWithCursor(row, split.leftWidth, split.rightWidth, split.gutterText, lineNumberWidth, cursor.col)
                : this.renderUnifiedRowWithCursor(row, width, lineNumberWidth, cursor.col);

        if (rendered.lines.length !== rowSpan.lineCount) {
            this.lastRenderedDiffCache = undefined;
            return {};
        }

        return {
            cursorOffset: rowSpan.startOffset + (rendered.cursorLineIndex ?? 0),
            cursorOverlay: {
                startOffset: rowSpan.startOffset,
                lines: rendered.lines,
            },
        };
    }

    private buildStructuredContent(width: number, mode: ViewMode): RenderedContent {
        const content = this.getRenderedDiffCache(width, mode);
        if (!content) return { lines: [], hunkOffsets: [] };

        const { cursorOffset, cursorOverlay } = this.getCursorOverlay(width, mode, content);
        return {
            lines: content.lines,
            hunkOffsets: content.hunkOffsets,
            cursorOffset,
            cursorOverlay,
        };
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
        const derivedCurrentHunkIndex =
            this.inlineEditMode && content.cursorOffset !== undefined
                ? this.getCurrentHunkIndex(content.hunkOffsets, content.cursorOffset)
                : this.getCurrentHunkIndex(content.hunkOffsets, this.getViewportHunkFocusOffset(clampedOffset, viewportHeight));
        const currentHunkIndex =
            !this.inlineEditMode && content.hunkOffsets.length > 0
                ? clampNumber(this.selectedHunkIndex ?? derivedCurrentHunkIndex, 0, content.hunkOffsets.length - 1)
                : derivedCurrentHunkIndex;
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
            scrollOffset: clampedOffset,
            currentHunkIndex,
            cursorOverlay: content.cursorOverlay,
        };
    }

    private setScrollOffset(nextOffset: number): boolean {
        const layout = this.buildLayout(this.lastWidth);
        const clampedOffset = clampNumber(nextOffset, 0, layout.maxScrollOffset);
        const derivedHunkIndex = this.getCurrentHunkIndex(
            layout.hunkOffsets,
            this.getViewportHunkFocusOffset(clampedOffset, layout.viewportHeight),
        );
        const nextSelectedHunkIndex = !this.inlineEditMode && layout.hunkOffsets.length > 0 ? derivedHunkIndex : undefined;
        const selectionChanged = nextSelectedHunkIndex !== this.selectedHunkIndex;
        if (clampedOffset === this.scrollOffset && !selectionChanged) return false;
        this.scrollOffset = clampedOffset;
        if (!this.inlineEditMode) {
            this.selectedHunkIndex = nextSelectedHunkIndex;
        }
        return true;
    }

    private jumpToHunk(targetHunkIndex: number): boolean {
        const layout = this.buildLayout(this.lastWidth);
        if (layout.hunkOffsets.length === 0) return false;
        const safeTarget = clampNumber(targetHunkIndex, 0, layout.hunkOffsets.length - 1);
        const anchor = layout.hunkOffsets[safeTarget] ?? 0;
        const nextOffset = clampNumber(anchor - Math.floor(layout.viewportHeight / 4), 0, layout.maxScrollOffset);
        const selectionChanged = this.selectedHunkIndex !== safeTarget;
        if (nextOffset === this.scrollOffset && !selectionChanged) return false;
        this.selectedHunkIndex = safeTarget;
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

        const action = this.resolveAction(data, layout);
        return action ? action() : false;
    }

    render(width: number): string[] {
        this.lastWidth = Math.max(1, width);
        const layout = this.buildLayout(this.lastWidth);
        this.scrollOffset = layout.scrollOffset;

        const visible = layout.contentLines.slice(layout.scrollOffset, layout.scrollOffset + layout.viewportHeight);
        if (layout.cursorOverlay) {
            for (let i = 0; i < layout.cursorOverlay.lines.length; i++) {
                const absoluteLineIndex = layout.cursorOverlay.startOffset + i;
                if (absoluteLineIndex < layout.scrollOffset || absoluteLineIndex >= layout.scrollOffset + layout.viewportHeight) {
                    continue;
                }
                visible[absoluteLineIndex - layout.scrollOffset] = layout.cursorOverlay.lines[i]!;
            }
        }

        const linesAbove = layout.scrollOffset;
        const linesBelow = Math.max(0, layout.contentLines.length - (layout.scrollOffset + visible.length));
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

function parsePercentOption(value: string | undefined, fallback: number): number {
    const match = value?.trim().match(/^(\d+(?:\.\d+)?)%?$/);
    if (!match) return fallback;

    const parsed = Number(match[1]);
    if (!Number.isFinite(parsed)) return fallback;
    return clampNumber(parsed, 10, 100);
}

function percentSizeValue(percent: number): SizeValue {
    return `${Number.isInteger(percent) ? percent : Number(percent.toFixed(2))}%` as SizeValue;
}

export async function reviewChangePreview(
    ctx: ExtensionContext,
    preview: ChangePreview,
    options: ReviewOptions = {},
): Promise<DiffDecision> {
    type ExpandableOverlayDecision = DiffDecision | { action: "collapse" };

    const allowAfterEdit =
        Boolean(options.allowAfterEdit) && preview.beforeText !== undefined && preview.afterText !== undefined;
    const diffColorMode = options.diffColorMode ?? "default";
    const showDiffRail = options.showDiffRail ?? true;
    const expandableLayout = Boolean(options.expandableLayout);
    const collapsedHeightPercent = parsePercentOption(options.collapsedHeight, 30);
    const expandedHeightPercent = parsePercentOption(options.expandedHeight, 100);
    const expandedWidthPercent = parsePercentOption(options.expandedWidth, 100);
    const expandedHeight = percentSizeValue(expandedHeightPercent);
    const expandedWidth = percentSizeValue(expandedWidthPercent);
    const pathStyle = options.pathStyle ?? "full";
    const pathSegments = options.pathSegments ?? 3;
    const kb = options.keybindings ?? DEFAULT_KEYBINDINGS;

    const matchesBinding = (data: string, binding: string[] | false | undefined): boolean => {
        if (!binding) return false;
        return binding.some((key) => {
            if (key.includes("+") || key.length > 1) return matchesKey(data, key as KeyId);
            return data === key;
        });
    };
    const initialAfterText = preview.afterText;
    let currentPreview = preview;

    const getAfterTextOverride = () =>
        initialAfterText !== undefined && currentPreview.afterText !== undefined && currentPreview.afterText !== initialAfterText
            ? currentPreview.afterText
            : undefined;

    const syncCurrentPreviewFromViewer = (viewer: DiffViewer) => {
        const viewerPreview = viewer.getPreview();
        if (viewerPreview.afterText !== currentPreview.afterText) {
            currentPreview = viewerPreview;
        }
    };

    const approvedDecisionFromViewer = (viewer: DiffViewer, action: "approve" | "approve_and_enable_auto"): DiffDecision => {
        syncCurrentPreviewFromViewer(viewer);
        return { action, afterTextOverride: getAfterTextOverride() };
    };

    if (isRpcMode(ctx)) {
        while (true) {
            const approveLabel = t("rpc.approve", "Approve");
            const rejectLabel = t("rpc.reject", "Reject");
            const steerLabel = t("rpc.steer", "Steer / request changes");
            const editFinalLabel = t("rpc.editFinal", "Edit final file content");
            const approveAutoLabel = t("rpc.approveAuto", "Approve + enable auto-approve");

            await ctx.ui.editor(
                [
                    t("ui.title", "Review proposed file change"),
                    `${t("ui.tool", "Tool:")} ${currentPreview.toolName}`,
                    `${t("ui.path", "Path:")} ${formatDisplayPath(currentPreview.path, pathStyle, pathSegments)}`,
                    `${t("ui.diff", "Diff:")} +${currentPreview.additions} / -${currentPreview.deletions}`,
                    ...currentPreview.summaryLines.map((line) => `- ${line}`),
                    currentPreview.previewError ? t("ui.previewWarning", `Preview warning: ${currentPreview.previewError}`, { message: currentPreview.previewError }) : "",
                ]
                    .filter(Boolean)
                    .join("\n"),
                currentPreview.diff,
            );

            const choice = await ctx.ui.select(
                t("rpc.prompt", "How should pi handle this change?"),
                [
                    approveLabel,
                    rejectLabel,
                    steerLabel,
                    ...(allowAfterEdit ? [editFinalLabel] : []),
                    approveAutoLabel,
                ],
            );

            if (choice === approveLabel) return { action: "approve", afterTextOverride: getAfterTextOverride() };
            if (choice === approveAutoLabel) {
                return { action: "approve_and_enable_auto", afterTextOverride: getAfterTextOverride() };
            }
            if (choice === editFinalLabel && allowAfterEdit) {
                const edited = await ctx.ui.editor(
                    t("rpc.editTitle", "Edit final contents for {path}", { path: currentPreview.path }),
                    currentPreview.afterText ?? "",
                );
                if (edited !== undefined) {
                    currentPreview = rebuildPreviewAfterManualEdit(currentPreview, edited);
                }
                continue;
            }
            if (choice === steerLabel) {
                const feedback = await ctx.ui.editor(t("ui.steerPrompt", "How should {path} change instead?", { path: currentPreview.path }), "");
                return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
            }
            return { action: "reject" };
        }
    }

    if (!expandableLayout) {
        const decision = await ctx.ui.custom<DiffDecision>(
            (tui, theme, _kb, done) => {
                const viewer = new DiffViewer(tui, theme, currentPreview, allowAfterEdit, diffColorMode, showDiffRail, 90, 100, false, kb, pathStyle, pathSegments);
                const framed = new BorderFrame(viewer, (text) => theme.fg("accent", text));
                const previousShowHardwareCursor = tui.getShowHardwareCursor();
                const syncCursorMode = () => tui.setShowHardwareCursor(viewer.isEditingInline() || previousShowHardwareCursor);
                syncCursorMode();

                return {
                    render: (width: number) => framed.render(width),
                    invalidate: () => framed.invalidate(),
                    handleInput: (data: string) => {
                        if (viewer.isEditingInline()) {
                            if (viewer.handleInput(data)) {
                                syncCursorMode();
                                tui.requestRender();
                            }
                            return;
                        }

                        if (matchesBinding(data, kb.approve)) {
                            done(approvedDecisionFromViewer(viewer, "approve"));
                            return;
                        }
                        if (matchesBinding(data, kb.reject)) {
                            done({ action: "reject" });
                            return;
                        }
                        if (matchesBinding(data, kb.steer)) {
                            done({ action: "steer" });
                            return;
                        }
                        if (matchesBinding(data, kb.autoApprove)) {
                            done(approvedDecisionFromViewer(viewer, "approve_and_enable_auto"));
                            return;
                        }

                        if (viewer.handleInput(data)) {
                            syncCursorMode();
                            tui.requestRender();
                        }
                    },
                    dispose: () => tui.setShowHardwareCursor(previousShowHardwareCursor),
                };
            },
            {
                overlay: true,
                overlayOptions: {
                    anchor: "center",
                    width: "96%",
                    minWidth: 20,
                    margin: 1,
                },
            },
        );

        if (decision.action !== "steer") return decision;
        const feedback = await ctx.ui.editor(t("ui.steerPrompt", "How should {path} change instead?", { path: preview.path }), "");
        return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
    }

    // Expandable layout: non-overlay compact, Ctrl+F stacks full overlay on top.
    const decision = await ctx.ui.custom<DiffDecision>(
        (tui, theme, _kb, done) => {
            const viewer = new DiffViewer(
                tui,
                theme,
                currentPreview,
                allowAfterEdit,
                diffColorMode,
                showDiffRail,
                collapsedHeightPercent,
                100,
                true,
                kb,
                pathStyle,
                pathSegments,
            );
            const framed = new BorderFrame(viewer, (text) => theme.fg("accent", text));
            const previousShowHardwareCursor = tui.getShowHardwareCursor();
            const syncCursorMode = () => tui.setShowHardwareCursor(viewer.isEditingInline() || previousShowHardwareCursor);
            syncCursorMode();

            const launchOverlay = () => {
                syncCurrentPreviewFromViewer(viewer);
                viewer.setPreview(currentPreview);

                let overlayViewer: DiffViewer | undefined;
                ctx.ui.custom<ExpandableOverlayDecision>(
                    (oTui, oTheme, _oKb, oDone) => {
                        const oViewer = new DiffViewer(
                            oTui,
                            oTheme,
                            currentPreview,
                            allowAfterEdit,
                            diffColorMode,
                            showDiffRail,
                            expandedHeightPercent,
                            expandedHeightPercent,
                            true,
                            kb,
                            pathStyle,
                            pathSegments,
                        );
                        overlayViewer = oViewer;
                        oViewer.setExpanded(true);
                        const oFramed = new BorderFrame(oViewer, (text) => oTheme.fg("accent", text));
                        const oPrevCursor = oTui.getShowHardwareCursor();
                        const oSyncCursor = () => oTui.setShowHardwareCursor(oViewer.isEditingInline() || oPrevCursor);
                        oSyncCursor();

                        return {
                            render: (width: number) => oFramed.render(width),
                            invalidate: () => oFramed.invalidate(),
                            handleInput: (data: string) => {
                                if (oViewer.isEditingInline()) {
                                    if (oViewer.handleInput(data)) {
                                        oSyncCursor();
                                        oTui.requestRender();
                                    }
                                    return;
                                }

                                if (matchesBinding(data, kb.toggleExpand)) {
                                    syncCurrentPreviewFromViewer(oViewer);
                                    oDone({ action: "collapse" });
                                    return;
                                }
                                if (matchesBinding(data, kb.approve)) {
                                    oDone(approvedDecisionFromViewer(oViewer, "approve"));
                                    return;
                                }
                                if (matchesBinding(data, kb.reject)) {
                                    oDone({ action: "reject" });
                                    return;
                                }
                                if (matchesBinding(data, kb.steer)) {
                                    oDone({ action: "steer" });
                                    return;
                                }
                                if (matchesBinding(data, kb.autoApprove)) {
                                    oDone(approvedDecisionFromViewer(oViewer, "approve_and_enable_auto"));
                                    return;
                                }

                                if (oViewer.handleInput(data)) {
                                    oSyncCursor();
                                    oTui.requestRender();
                                }
                            },
                            dispose: () => oTui.setShowHardwareCursor(oPrevCursor),
                        };
                    },
                    {
                        overlay: true,
                        overlayOptions: {
                            anchor: "center",
                            width: expandedWidth,
                            maxHeight: expandedHeight,
                            minWidth: 20,
                            margin: expandedWidthPercent >= 100 ? 0 : 1,
                        },
                    },
                ).then((overlayDecision) => {
                    if (overlayViewer) {
                        syncCurrentPreviewFromViewer(overlayViewer);
                    }
                    viewer.setPreview(currentPreview);
                    tui.requestRender();
                    if (overlayDecision.action === "collapse") return;
                    done(overlayDecision);
                });
            };

            return {
                render: (width: number) => framed.render(width),
                invalidate: () => framed.invalidate(),
                handleInput: (data: string) => {
                    if (viewer.isEditingInline()) {
                        if (viewer.handleInput(data)) {
                            syncCursorMode();
                            tui.requestRender();
                        }
                        return;
                    }

                    if (matchesBinding(data, kb.toggleExpand)) {
                        launchOverlay();
                        return;
                    }
                    if (matchesBinding(data, kb.approve)) {
                        done(approvedDecisionFromViewer(viewer, "approve"));
                        return;
                    }
                    if (matchesBinding(data, kb.reject)) {
                        done({ action: "reject" });
                        return;
                    }
                    if (matchesBinding(data, kb.steer)) {
                        done({ action: "steer" });
                        return;
                    }
                    if (matchesBinding(data, kb.autoApprove)) {
                        done(approvedDecisionFromViewer(viewer, "approve_and_enable_auto"));
                        return;
                    }

                    if (viewer.handleInput(data)) {
                        syncCursorMode();
                        tui.requestRender();
                    }
                },
                dispose: () => tui.setShowHardwareCursor(previousShowHardwareCursor),
            };
        },
        {
            overlay: false,
        },
    );

    if (decision.action !== "steer") return decision;
    const feedback = await ctx.ui.editor(t("ui.steerPrompt", "How should {path} change instead?", { path: preview.path }), "");
    return feedback?.trim() ? { action: "steer", feedback: feedback.trim() } : { action: "reject" };
}
