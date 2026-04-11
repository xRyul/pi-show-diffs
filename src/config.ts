import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface DiffApprovalConfig {
	autoApprove: boolean;
	expandableLayout: boolean;
	collapsedHeight: string;
	expandedHeight: string;
	expandedWidth: string;
}

export const DEFAULT_CONFIG: DiffApprovalConfig = {
	autoApprove: false,
	expandableLayout: false,
	collapsedHeight: "30%",
	expandedHeight: "100%",
	expandedWidth: "100%",
};

export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-show-diffs.json");

export function loadConfig(): DiffApprovalConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<DiffApprovalConfig>;
		return {
			autoApprove: parsed.autoApprove === true,
			expandableLayout: parsed.expandableLayout === true,
			collapsedHeight: typeof parsed.collapsedHeight === "string" ? parsed.collapsedHeight : DEFAULT_CONFIG.collapsedHeight,
			expandedHeight: typeof parsed.expandedHeight === "string" ? parsed.expandedHeight : DEFAULT_CONFIG.expandedHeight,
			expandedWidth: typeof parsed.expandedWidth === "string" ? parsed.expandedWidth : DEFAULT_CONFIG.expandedWidth,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: DiffApprovalConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
