import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

import { normalizeToLF, stripBom } from "./diff-utils.js";

const HASH_CHARS = "ZPMQVRWSNKTXJBYH";
const HASH_LEN = 2;
const HASH_DICT = Array.from({ length: 256 }, (_, i) => {
	const h = i >>> 4;
	const l = i & 0x0f;
	return `${HASH_CHARS[h]}${HASH_CHARS[l]}`;
});

export type HashlineContentInput = string | string[] | null;

export interface HashlineOperation {
	op: "replace_range" | "delete_range" | "insert_after" | "insert_before";
	start?: string;
	end?: string;
	anchor?: string;
	content?: HashlineContentInput;
}

export interface HashlineEditInput {
	path: string;
	operations: HashlineOperation[];
}

export interface HashlinePreview {
	absolutePath: string;
	beforeText: string;
	afterText: string;
	summaryLines: string[];
	operationCount: number;
}

function normalizeLineForDisplay(line: string): string {
	let out = line.endsWith("\r") ? line.slice(0, -1) : line;
	if (out.startsWith("\uFEFF")) out = out.slice(1);
	return out;
}

function normalizeLineForHash(line: string): string {
	return normalizeLineForDisplay(line).replace(/\s+/g, "");
}

function fnv1a32(input: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
}

function hashTagFromLine(line: string): string {
	const normalized = normalizeLineForHash(line);
	const hash = fnv1a32(normalized);
	return HASH_DICT[hash & 0xff]!;
}

function parseTag(tag: string): { line: number; hash: string } {
	const match = tag.match(/^\s*[>+-]*\s*(\d+)\s*#\s*([ZPMQVRWSNKTXJBYH]{2})/i);
	if (!match) throw new Error(`Invalid tag: \"${tag}\". Expected format like \"12#ZY\".`);

	const line = Number(match[1]);
	if (!Number.isFinite(line) || line < 1) throw new Error(`Invalid line number in tag: \"${tag}\".`);

	return { line, hash: match[2]!.toUpperCase() };
}

function computeLineTag(lineText: string): string {
	return hashTagFromLine(lineText);
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

function parseContent(content: HashlineContentInput | undefined): string[] {
	if (content === null || content === undefined) return [];
	if (Array.isArray(content)) {
		for (let i = 0; i < content.length; i++) {
			const line = content[i] ?? "";
			if (line.includes("\n") || line.includes("\r")) {
				throw new Error(`Invalid content: content[${i}] contains a newline.`);
			}
		}
		return content;
	}

	const lines = normalizeToLF(content).split("\n");
	if (lines.length === 0) return [];
	if (lines[lines.length - 1]?.trim() === "") return lines.slice(0, -1);
	return lines;
}

export async function computeHashlinePreview(params: HashlineEditInput, cwd: string): Promise<HashlinePreview> {
	const absolutePath = resolveToCwd(params.path, cwd);
	await access(absolutePath, fsConstants.R_OK);

	const rawBuffer = await readFile(absolutePath);
	const raw = rawBuffer.toString("utf-8");
	const { text } = stripBom(raw);
	const normalized = normalizeToLF(text);
	const originalLines = normalized.split("\n");

	type SpliceOp = { at: number; deleteCount: number; insert: string[]; debug: string };
	const tagsToCheck: Array<{ tag: string; parsed: { line: number; hash: string } }> = [];

	for (const op of params.operations) {
		if (op.op === "replace_range" || op.op === "delete_range") {
			if (!op.start || !op.end) throw new Error(`${op.op} requires both start and end tags`);
			tagsToCheck.push({ tag: op.start, parsed: parseTag(op.start) });
			tagsToCheck.push({ tag: op.end, parsed: parseTag(op.end) });
			if (op.op === "replace_range" && op.content === undefined) {
				throw new Error("replace_range requires content");
			}
			continue;
		}

		if (!op.anchor) throw new Error(`${op.op} requires anchor tag`);
		if (op.content === undefined) throw new Error(`${op.op} requires content`);
		const parsedContent = parseContent(op.content);
		if (parsedContent.length === 0) throw new Error(`${op.op} requires at least one content line`);
		tagsToCheck.push({ tag: op.anchor, parsed: parseTag(op.anchor) });
	}

	for (const { tag, parsed } of tagsToCheck) {
		const index = parsed.line - 1;
		if (index < 0 || index >= originalLines.length) {
			throw new Error(`Tag ${tag} points outside the file.`);
		}
		const currentHash = computeLineTag(originalLines[index]!);
		if (currentHash !== parsed.hash) {
			throw new Error(
				`Tag mismatch at line ${parsed.line} in ${params.path}. Expected ${parsed.line}#${parsed.hash} but found ${parsed.line}#${currentHash}.`,
			);
		}
	}

	const splices: SpliceOp[] = params.operations.map((op) => {
		switch (op.op) {
			case "replace_range": {
				const start = parseTag(op.start!);
				const end = parseTag(op.end!);
				if (end.line < start.line) throw new Error("replace_range end must be >= start");
				return {
					at: start.line - 1,
					deleteCount: end.line - start.line + 1,
					insert: parseContent(op.content),
					debug: `replace_range ${op.start}..${op.end}`,
				};
			}
			case "delete_range": {
				const start = parseTag(op.start!);
				const end = parseTag(op.end!);
				if (end.line < start.line) throw new Error("delete_range end must be >= start");
				return {
					at: start.line - 1,
					deleteCount: end.line - start.line + 1,
					insert: [],
					debug: `delete_range ${op.start}..${op.end}`,
				};
			}
			case "insert_after": {
				const anchor = parseTag(op.anchor!);
				const insert = parseContent(op.content);
				if (insert.length === 0) throw new Error("insert_after requires at least one content line");
				return {
					at: anchor.line,
					deleteCount: 0,
					insert,
					debug: `insert_after ${op.anchor}`,
				};
			}
			case "insert_before": {
				const anchor = parseTag(op.anchor!);
				const insert = parseContent(op.content);
				if (insert.length === 0) throw new Error("insert_before requires at least one content line");
				return {
					at: anchor.line - 1,
					deleteCount: 0,
					insert,
					debug: `insert_before ${op.anchor}`,
				};
			}
		}
	});

	const ranges = splices
		.filter((splice) => splice.deleteCount > 0)
		.map((splice) => ({ start: splice.at, end: splice.at + splice.deleteCount - 1, debug: splice.debug }))
		.sort((a, b) => a.start - b.start);

	for (let i = 1; i < ranges.length; i++) {
		const previous = ranges[i - 1]!;
		const current = ranges[i]!;
		if (current.start <= previous.end) {
			throw new Error(`Overlapping edit ranges are not allowed (${previous.debug} overlaps ${current.debug}).`);
		}
	}

	splices.sort((a, b) => b.at - a.at);

	const newLines = [...originalLines];
	for (const splice of splices) {
		if (splice.at < 0 || splice.at > newLines.length) {
			throw new Error(`Invalid splice index computed (${splice.debug}).`);
		}
		newLines.splice(splice.at, splice.deleteCount, ...splice.insert);
	}

	const summaryLines = splices
		.slice()
		.reverse()
		.map((splice) => `${splice.debug} (delete=${splice.deleteCount}, insertLines=${splice.insert.length})`);

	return {
		absolutePath,
		beforeText: normalized,
		afterText: newLines.join("\n"),
		summaryLines,
		operationCount: splices.length,
	};
}
