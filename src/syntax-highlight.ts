import * as path from "node:path";

import { highlight, supportsLanguage, type Theme as HighlightTheme } from "cli-highlight";

export type SyntaxTokenKind = Exclude<keyof HighlightTheme, "default">;

export interface SyntaxSegment {
	text: string;
	token?: SyntaxTokenKind;
}

const TOKEN_START = "\u0001";
const TOKEN_SEPARATOR = "\u0002";
const TOKEN_END = "\u0003";

const TOKEN_KINDS = [
	"keyword",
	"built_in",
	"type",
	"literal",
	"number",
	"regexp",
	"string",
	"subst",
	"symbol",
	"class",
	"function",
	"title",
	"params",
	"comment",
	"doctag",
	"meta",
	"meta-keyword",
	"meta-string",
	"section",
	"tag",
	"name",
	"builtin-name",
	"attr",
	"attribute",
	"variable",
	"bullet",
	"code",
	"emphasis",
	"strong",
	"formula",
	"link",
	"quote",
	"selector-tag",
	"selector-id",
	"selector-class",
	"selector-attr",
	"selector-pseudo",
	"template-tag",
	"template-variable",
	"addition",
	"deletion",
] satisfies SyntaxTokenKind[];

const TOKEN_KIND_SET = new Set<SyntaxTokenKind>(TOKEN_KINDS);

const MARKER_THEME: HighlightTheme = {
	default: (codePart: string) => codePart,
};

for (const token of TOKEN_KINDS) {
	MARKER_THEME[token] = (codePart: string) => `${TOKEN_START}${token}${TOKEN_SEPARATOR}${codePart}${TOKEN_END}`;
}

const BASENAME_LANGUAGE_MAP = new Map<string, string>([
	["dockerfile", "dockerfile"],
	["containerfile", "dockerfile"],
	["makefile", "makefile"],
	["justfile", "makefile"],
	[".bashrc", "bash"],
	[".bash_profile", "bash"],
	[".bash_aliases", "bash"],
	[".profile", "bash"],
	[".zshrc", "zsh"],
	[".zprofile", "zsh"],
	[".env", "bash"],
	[".env.local", "bash"],
	["package.json", "json"],
	["tsconfig.json", "json"],
	["jsconfig.json", "json"],
	["bunfig.toml", "toml"],
]);

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
	".astro": "html",
	".bash": "bash",
	".cjs": "js",
	".conf": "ini",
	".cts": "ts",
	".env": "bash",
	".hbs": "html",
	".htm": "html",
	".html": "html",
	".ini": "ini",
	".json": "json",
	".json5": "json",
	".jsonc": "json",
	".jsx": "jsx",
	".less": "css",
	".md": "md",
	".mdx": "md",
	".mjs": "js",
	".mts": "ts",
	".scss": "scss",
	".sh": "bash",
	".svg": "xml",
	".toml": "toml",
	".tsx": "tsx",
	".vue": "html",
	".xml": "xml",
	".yml": "yaml",
	".yaml": "yaml",
	".zsh": "zsh",
};

const fg256 = (code: number) => `\x1b[38;5;${code}m`;

const TOKEN_COLOR_ANSI: Partial<Record<SyntaxTokenKind, string>> = {
	keyword: fg256(213),
	literal: fg256(213),
	"meta-keyword": fg256(213),
	"selector-id": fg256(213),
	"selector-pseudo": fg256(213),
	built_in: fg256(117),
	type: fg256(117),
	class: fg256(117),
	name: fg256(117),
	"selector-tag": fg256(117),
	string: fg256(221),
	regexp: fg256(221),
	"meta-string": fg256(221),
	link: fg256(221),
	code: fg256(221),
	number: fg256(215),
	symbol: fg256(215),
	comment: fg256(245),
	doctag: fg256(180),
	quote: fg256(245),
	meta: fg256(180),
	tag: fg256(180),
	attr: fg256(159),
	attribute: fg256(159),
	variable: fg256(229),
	"template-variable": fg256(229),
	function: fg256(81),
	title: fg256(81),
	"selector-class": fg256(81),
	"selector-attr": fg256(159),
	section: fg256(117),
	"template-tag": fg256(213),
	addition: fg256(229),
	deletion: fg256(229),
};

function pushSegment(segments: SyntaxSegment[], text: string, token?: SyntaxTokenKind): void {
	if (text.length === 0) return;
	const last = segments[segments.length - 1];
	if (last && last.token === token) {
		last.text += text;
		return;
	}
	segments.push({ text, token });
}

function parseMarkedSegments(markedText: string): SyntaxSegment[] {
	const segments: SyntaxSegment[] = [];
	const stack: SyntaxTokenKind[] = [];
	let cursor = 0;

	while (cursor < markedText.length) {
		const nextStart = markedText.indexOf(TOKEN_START, cursor);
		const nextEnd = markedText.indexOf(TOKEN_END, cursor);

		if (nextStart === -1 && nextEnd === -1) {
			pushSegment(segments, markedText.slice(cursor), stack[stack.length - 1]);
			break;
		}

		const isStart = nextStart !== -1 && (nextEnd === -1 || nextStart < nextEnd);
		const markerIndex = isStart ? nextStart : nextEnd;

		if (markerIndex > cursor) {
			pushSegment(segments, markedText.slice(cursor, markerIndex), stack[stack.length - 1]);
		}

		if (isStart) {
			const separatorIndex = markedText.indexOf(TOKEN_SEPARATOR, markerIndex + 1);
			if (separatorIndex === -1) {
				pushSegment(segments, markedText.slice(markerIndex), stack[stack.length - 1]);
				break;
			}

			const token = markedText.slice(markerIndex + 1, separatorIndex);
			if (!TOKEN_KIND_SET.has(token as SyntaxTokenKind)) {
				pushSegment(segments, markedText.slice(markerIndex, separatorIndex + 1), stack[stack.length - 1]);
				cursor = separatorIndex + 1;
				continue;
			}

			stack.push(token as SyntaxTokenKind);
			cursor = separatorIndex + 1;
			continue;
		}

		if (stack.length > 0) stack.pop();
		cursor = markerIndex + 1;
	}

	return segments;
}

export function detectSyntaxLanguage(filePath: string): string | undefined {
	const baseName = path.basename(filePath).toLowerCase();
	const mappedBaseName = BASENAME_LANGUAGE_MAP.get(baseName);
	if (mappedBaseName && supportsLanguage(mappedBaseName)) return mappedBaseName;
	if (supportsLanguage(baseName)) return baseName;

	const extension = path.extname(baseName);
	if (!extension) return undefined;

	const mappedExtension = EXTENSION_LANGUAGE_MAP[extension] ?? extension.slice(1);
	return supportsLanguage(mappedExtension) ? mappedExtension : undefined;
}

export function tokenizeSyntaxLine(text: string, language: string | undefined): SyntaxSegment[] {
	if (!language || text.length === 0) return [{ text }];

	try {
		const marked = highlight(text, {
			language,
			ignoreIllegals: true,
			theme: MARKER_THEME,
		});
		const segments = parseMarkedSegments(marked);
		return segments.length > 0 ? segments : [{ text }];
	} catch {
		return [{ text }];
	}
}

export function getSyntaxTokenColorAnsi(token: SyntaxTokenKind | undefined): string | undefined {
	if (!token) return undefined;
	return TOKEN_COLOR_ANSI[token];
}
