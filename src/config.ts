import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type DiffColorMode = "default" | "theme";

export interface DiffKeybindings {
	approve: string[] | false;
	reject: string[] | false;
	steer: string[] | false;
	editInline: string[] | false;
	autoApprove: string[] | false;
	scrollUp: string[] | false;
	scrollDown: string[] | false;
	pageUp: string[] | false;
	pageDown: string[] | false;
	scrollTop: string[] | false;
	scrollBottom: string[] | false;
	nextHunk: string[] | false;
	prevHunk: string[] | false;
	toggleMode: string[] | false;
	toggleWrap: string[] | false;
	toggleExpand: string[] | false;
	contextMore: string[] | false;
	contextLess: string[] | false;
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
	approve: ["Enter", "a", "y"],
	reject: ["Escape", "r"],
	steer: ["s"],
	editInline: ["e", "E"],
	autoApprove: ["A"],
	scrollUp: ["up"],
	scrollDown: ["down"],
	pageUp: ["pageUp"],
	pageDown: ["pageDown"],
	scrollTop: ["home"],
	scrollBottom: ["end"],
	nextHunk: ["n"],
	prevHunk: ["p"],
	toggleMode: ["Tab"],
	toggleWrap: ["w"],
	toggleExpand: ["ctrl+f"],
	contextMore: ["right", "]"],
	contextLess: ["left", "["],
};

export type PathStyle = "full" | "short";

export interface DiffApprovalConfig {
	autoApprove: boolean;
	diffColorMode: DiffColorMode;
	showDiffRail: boolean;
	expandableLayout: boolean;
	collapsedHeight: string;
	expandedHeight: string;
	expandedWidth: string;
	pathStyle: PathStyle;
	pathSegments: number;
	keybindings: DiffKeybindings;
}

export const DEFAULT_CONFIG: DiffApprovalConfig = {
	autoApprove: false,
	diffColorMode: "default",
	showDiffRail: true,
	expandableLayout: false,
	collapsedHeight: "30%",
	expandedHeight: "100%",
	expandedWidth: "100%",
	pathStyle: "full",
	pathSegments: 3,
	keybindings: { ...DEFAULT_KEYBINDINGS },
};

export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-show-diffs.json");

function parseDiffColorMode(value: unknown): DiffColorMode {
	return value === "theme" ? "theme" : "default";
}

function parsePathStyle(value: unknown): PathStyle {
	return value === "short" ? "short" : "full";
}

function parsePathSegments(value: unknown): number {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : DEFAULT_CONFIG.pathSegments;
}

function formatPercent(value: number): string {
	return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

function parsePercentConfig(value: unknown, fallback: string, min = 10, max = 100): string {
	if (typeof value !== "string") return fallback;
	const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/);
	if (!match) return fallback;

	const percent = Number(match[1]);
	if (!Number.isFinite(percent)) return fallback;
	return formatPercent(Math.max(min, Math.min(percent, max)));
}

function copyKeybinding(value: string[] | false): string[] | false {
	return value === false ? false : [...value];
}

function parseKeybindingValue(value: unknown, fallback: string[] | false): string[] | false {
	if (value === false) return false;
	if (Array.isArray(value)) {
		const keys = value
			.filter((key): key is string => typeof key === "string")
			.map((key) => key.trim())
			.filter(Boolean);
		return keys.length > 0 ? keys : copyKeybinding(fallback);
	}
	return copyKeybinding(fallback);
}

function parseKeybindings(value: unknown): DiffKeybindings {
	const raw = value && typeof value === "object" ? value as Partial<Record<keyof DiffKeybindings, unknown>> : {};
	return {
		approve: parseKeybindingValue(raw.approve, DEFAULT_KEYBINDINGS.approve),
		reject: parseKeybindingValue(raw.reject, DEFAULT_KEYBINDINGS.reject),
		steer: parseKeybindingValue(raw.steer, DEFAULT_KEYBINDINGS.steer),
		editInline: parseKeybindingValue(raw.editInline, DEFAULT_KEYBINDINGS.editInline),
		autoApprove: parseKeybindingValue(raw.autoApprove, DEFAULT_KEYBINDINGS.autoApprove),
		scrollUp: parseKeybindingValue(raw.scrollUp, DEFAULT_KEYBINDINGS.scrollUp),
		scrollDown: parseKeybindingValue(raw.scrollDown, DEFAULT_KEYBINDINGS.scrollDown),
		pageUp: parseKeybindingValue(raw.pageUp, DEFAULT_KEYBINDINGS.pageUp),
		pageDown: parseKeybindingValue(raw.pageDown, DEFAULT_KEYBINDINGS.pageDown),
		scrollTop: parseKeybindingValue(raw.scrollTop, DEFAULT_KEYBINDINGS.scrollTop),
		scrollBottom: parseKeybindingValue(raw.scrollBottom, DEFAULT_KEYBINDINGS.scrollBottom),
		nextHunk: parseKeybindingValue(raw.nextHunk, DEFAULT_KEYBINDINGS.nextHunk),
		prevHunk: parseKeybindingValue(raw.prevHunk, DEFAULT_KEYBINDINGS.prevHunk),
		toggleMode: parseKeybindingValue(raw.toggleMode, DEFAULT_KEYBINDINGS.toggleMode),
		toggleWrap: parseKeybindingValue(raw.toggleWrap, DEFAULT_KEYBINDINGS.toggleWrap),
		toggleExpand: parseKeybindingValue(raw.toggleExpand, DEFAULT_KEYBINDINGS.toggleExpand),
		contextMore: parseKeybindingValue(raw.contextMore, DEFAULT_KEYBINDINGS.contextMore),
		contextLess: parseKeybindingValue(raw.contextLess, DEFAULT_KEYBINDINGS.contextLess),
	};
}

export function normalizeConfig(config: Partial<DiffApprovalConfig> = {}): DiffApprovalConfig {
	return {
		autoApprove: config.autoApprove === true,
		diffColorMode: parseDiffColorMode(config.diffColorMode),
		showDiffRail: config.showDiffRail !== false,
		expandableLayout: config.expandableLayout === true,
		collapsedHeight: parsePercentConfig(config.collapsedHeight, DEFAULT_CONFIG.collapsedHeight),
		expandedHeight: parsePercentConfig(config.expandedHeight, DEFAULT_CONFIG.expandedHeight),
		expandedWidth: parsePercentConfig(config.expandedWidth, DEFAULT_CONFIG.expandedWidth),
		pathStyle: parsePathStyle(config.pathStyle),
		pathSegments: parsePathSegments(config.pathSegments),
		keybindings: parseKeybindings(config.keybindings),
	};
}

export function loadConfig(): DiffApprovalConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		return normalizeConfig(JSON.parse(raw) as Partial<DiffApprovalConfig>);
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

function hasErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function readExistingConfigForSave(): Record<string, unknown> {
	try {
		const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? parsed as Record<string, unknown>
			: {};
	} catch (error) {
		if (error instanceof SyntaxError || hasErrorCode(error, "ENOENT")) return {};
		throw error;
	}
}

export function saveConfig(config: DiffApprovalConfig): void {
	const normalized = normalizeConfig(config);
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	const merged = { ...readExistingConfigForSave(), ...normalized };
	writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
}
