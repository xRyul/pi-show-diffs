import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export interface DiffApprovalConfig {
	autoApprove: boolean;
}

export const DEFAULT_CONFIG: DiffApprovalConfig = {
	autoApprove: false,
};

export const CONFIG_PATH = join(getAgentDir(), "extensions", "pi-show-diffs.json");

export function loadConfig(): DiffApprovalConfig {
	try {
		const raw = readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON.parse(raw) as Partial<DiffApprovalConfig>;
		return {
			autoApprove: parsed.autoApprove === true,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveConfig(config: DiffApprovalConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}
