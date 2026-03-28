import type { EditToolInput, WriteToolInput } from "@mariozechner/pi-coding-agent";

import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import {
	fuzzyFindText,
	generateDiffString,
	normalizeForFuzzyMatch,
	normalizeToLF,
	stripBom,
	summarizeDiff,
	type StructuredDiff,
} from "./diff-utils.js";
import { computeHashlinePreview, type HashlineEditInput } from "./hashline.js";

export type PreviewToolName = "edit" | "hashline_edit" | "write";

export interface ChangePreview {
	toolName: PreviewToolName;
	path: string;
	absolutePath: string;
	diff: string;
	diffModel?: StructuredDiff;
	additions: number;
	deletions: number;
	summaryLines: string[];
	previewError?: string;
}

function stripAtPrefix(inputPath: string): string {
	return inputPath.startsWith("@") ? inputPath.slice(1) : inputPath;
}

function expandTilde(inputPath: string): string {
	if (inputPath === "~") return homedir();
	if (inputPath.startsWith("~/")) return path.join(homedir(), inputPath.slice(2));
	return inputPath;
}

function resolveToCwd(inputPath: string, cwd: string): string {
	const expanded = expandTilde(stripAtPrefix(inputPath));
	return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded);
}

function errorPreview(
	toolName: PreviewToolName,
	filePath: string,
	absolutePath: string,
	error: string,
	summaryLines: string[],
): ChangePreview {
	return {
		toolName,
		path: filePath,
		absolutePath,
		diff: `Preview unavailable\n\n${error}`,
		additions: 0,
		deletions: 0,
		summaryLines,
		previewError: error,
	};
}

async function computeEditPreview(input: EditToolInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);

	try {
		await access(absolutePath, fsConstants.R_OK);
	} catch {
		return errorPreview("edit", input.path, absolutePath, `File not found: ${input.path}`, ["Replace exact text"]);
	}

	try {
		const rawContent = await readFile(absolutePath, "utf-8");
		const { text: content } = stripBom(rawContent);
		const normalizedContent = normalizeToLF(content);
		const normalizedOldText = normalizeToLF(input.oldText);
		const normalizedNewText = normalizeToLF(input.newText);
		const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);

		if (!matchResult.found) {
			return errorPreview(
				"edit",
				input.path,
				absolutePath,
				`Could not find the exact text in ${input.path}. The old text must be unique and match the file.`,
				["Replace exact text"],
			);
		}

		const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
		const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
		const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
		if (occurrences > 1) {
			return errorPreview(
				"edit",
				input.path,
				absolutePath,
				`Found ${occurrences} occurrences in ${input.path}. Add more context so the edit is unique.`,
				["Replace exact text"],
			);
		}

		const baseContent = matchResult.contentForReplacement;
		const newContent =
			baseContent.substring(0, matchResult.index) +
			normalizedNewText +
			baseContent.substring(matchResult.index + matchResult.matchLength);

		if (baseContent === newContent) {
			return errorPreview(
				"edit",
				input.path,
				absolutePath,
				`No changes would be made to ${input.path}.`,
				["Replace exact text"],
			);
		}

		const diffResult = generateDiffString(baseContent, newContent);
		const summary = summarizeDiff(diffResult.diff);
		return {
			toolName: "edit",
			path: input.path,
			absolutePath,
			diff: diffResult.diff || "(No visible diff)",
			diffModel: diffResult.model,
			additions: summary.additions,
			deletions: summary.deletions,
			summaryLines: [
				"Replace exact text",
				matchResult.usedFuzzyMatch ? "Matched using fuzzy normalization" : "Matched exact text",
			],
		};
	} catch (error) {
		return errorPreview(
			"edit",
			input.path,
			absolutePath,
			error instanceof Error ? error.message : String(error),
			["Replace exact text"],
		);
	}
}

async function computeWritePreview(input: WriteToolInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);
	let beforeText = "";
	let existed = true;

	try {
		await access(absolutePath, fsConstants.R_OK);
		const rawContent = await readFile(absolutePath, "utf-8");
		beforeText = normalizeToLF(stripBom(rawContent).text);
	} catch {
		existed = false;
	}

	const afterText = normalizeToLF(input.content);
	if (beforeText === afterText) {
		return errorPreview(
			"write",
			input.path,
			absolutePath,
			`No changes would be made to ${input.path}.`,
			[existed ? "Overwrite existing file" : "Create new file"],
		);
	}

	const diffResult = generateDiffString(beforeText, afterText);
	const summary = summarizeDiff(diffResult.diff);
	return {
		toolName: "write",
		path: input.path,
		absolutePath,
		diff: diffResult.diff || "(No visible diff)",
		diffModel: diffResult.model,
		additions: summary.additions,
		deletions: summary.deletions,
		summaryLines: [
			existed ? "Overwrite existing file" : "Create new file",
			`${afterText.split("\n").length} output line(s)`,
		],
	};
}

async function computeHashlineEditChangePreview(input: HashlineEditInput, cwd: string): Promise<ChangePreview> {
	const absolutePath = resolveToCwd(input.path, cwd);

	try {
		const preview = await computeHashlinePreview(input, cwd);
		const diffResult = generateDiffString(preview.beforeText, preview.afterText);
		const summary = summarizeDiff(diffResult.diff);
		return {
			toolName: "hashline_edit",
			path: input.path,
			absolutePath: preview.absolutePath,
			diff: diffResult.diff || "(No visible diff)",
			diffModel: diffResult.model,
			additions: summary.additions,
			deletions: summary.deletions,
			summaryLines: [`${preview.operationCount} hashline operation(s)`, ...preview.summaryLines],
		};
	} catch (error) {
		return errorPreview(
			"hashline_edit",
			input.path,
			absolutePath,
			error instanceof Error ? error.message : String(error),
			[`${input.operations.length} hashline operation(s)`],
		);
	}
}

export async function computeChangePreview(
	toolName: PreviewToolName,
	input: unknown,
	cwd: string,
): Promise<ChangePreview | null> {
	if (toolName === "edit") return computeEditPreview(input as EditToolInput, cwd);
	if (toolName === "write") return computeWritePreview(input as WriteToolInput, cwd);
	if (toolName === "hashline_edit") return computeHashlineEditChangePreview(input as HashlineEditInput, cwd);
	return null;
}
