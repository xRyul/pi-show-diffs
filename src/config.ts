import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface DiffKeybindings {
	approve: string[] | false;
	reject: string[] | false;
	steer: string[] | false;
	editInline: string[] | false;
	autoApprove: string[] | false;
	scrollUp: string[] | false;
	scrollDown: string[] | false;
	nextHunk: string[] | false;
	prevHunk: string[] | false;
	toggleMode: string[] | false;
	toggleWrap: string[] | false;
	toggleExpand: string[] | false;
	contextMore: string[] | false;
	contextLess: string[] | false;
}

export const DEFAULT_KEYBINDINGS: DiffKeybindings = {
	approve: ["Enter", "y"],
	reject: ["Escape", "r"],
	steer: ["s"],
	editInline: ["e", "E"],
	autoApprove: ["A"],
	scrollUp: ["up"],
	scrollDown: ["down"],
	nextHunk: ["n"],
	prevHunk: ["p"],
	toggleMode: ["Tab"],
	toggleWrap: ["w"],
	toggleExpand: ["ctrl+f"],
	contextMore: ["right", "]"],
	contextLess: ["left", "["],
};

export interface DiffApprovalConfig {
	autoApprove: boolean;
	expandableLayout: boolean;
	collapsedHeight: string;
	expandedHeight: string;
	expandedWidth: string;
	keybindings: DiffKeybindings;
}

export const DEFAULT_CONFIG: DiffApprovalConfig = {
	autoApprove: false,
	expandableLayout: false,
	collapsedHeight: "30%",
	expandedHeight: "100%",
	expandedWidth: "100%",
	keybindings: { ...DEFAULT_KEYBINDINGS },
};

export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-show-diffs.json");

export function loadConfig(): DiffApprovalConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<DiffApprovalConfig>;
		const rawKb = parsed.keybindings ?? {};
		const parseKb = (key: keyof DiffKeybindings): string[] | false => {
			const val = (rawKb as any)[key];
			if (val === false) return false;
			if (Array.isArray(val)) return val.filter((v: unknown) => typeof v === "string");
			return DEFAULT_KEYBINDINGS[key] as string[];
		};

		return {
			autoApprove: parsed.autoApprove === true,
			expandableLayout: parsed.expandableLayout === true,
			collapsedHeight: typeof parsed.collapsedHeight === "string" ? parsed.collapsedHeight : DEFAULT_CONFIG.collapsedHeight,
			expandedHeight: typeof parsed.expandedHeight === "string" ? parsed.expandedHeight : DEFAULT_CONFIG.expandedHeight,
			expandedWidth: typeof parsed.expandedWidth === "string" ? parsed.expandedWidth : DEFAULT_CONFIG.expandedWidth,
			keybindings: {
				approve: parseKb("approve"),
				reject: parseKb("reject"),
				steer: parseKb("steer"),
				editInline: parseKb("editInline"),
				autoApprove: parseKb("autoApprove"),
				scrollUp: parseKb("scrollUp"),
				scrollDown: parseKb("scrollDown"),
				nextHunk: parseKb("nextHunk"),
				prevHunk: parseKb("prevHunk"),
				toggleMode: parseKb("toggleMode"),
				toggleWrap: parseKb("toggleWrap"),
				toggleExpand: parseKb("toggleExpand"),
				contextMore: parseKb("contextMore"),
				contextLess: parseKb("contextLess"),
			},
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: DiffApprovalConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
