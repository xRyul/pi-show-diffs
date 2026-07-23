import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveExistingPath } from "./resolve-existing-path.ts";

function existsIn(paths: string[]): (candidate: string) => boolean {
	const set = new Set(paths);
	return (candidate: string) => set.has(candidate);
}

test("a non-breaking space in the input resolves to the real space-separated file", () => {
	const resolved = resolveExistingPath("scripts/my\u00A0file.ts", "/project", existsIn(["/project/scripts/my file.ts"]));
	assert.equal(resolved, "/project/scripts/my file.ts");
});

test("an NFC accent in the input resolves to the NFD-stored file", () => {
	const nfcInput = "caf\u00E9.ts"; // é as a single precomposed code point
	const nfdStored = "/project/caf\u0065\u0301.ts"; // e + combining acute accent
	const resolved = resolveExistingPath(nfcInput, "/project", existsIn([nfdStored]));
	assert.equal(resolved, nfdStored);
});

test("a plain existing relative path resolves against the cwd", () => {
	const resolved = resolveExistingPath("scripts/csv/csvRerunPlanning.ts", "/project", existsIn(["/project/scripts/csv/csvRerunPlanning.ts"]));
	assert.equal(resolved, "/project/scripts/csv/csvRerunPlanning.ts");
});

test("an absolute path is returned as-is", () => {
	const resolved = resolveExistingPath("/abs/scripts/x.ts", "/project", existsIn(["/abs/scripts/x.ts"]));
	assert.equal(resolved, "/abs/scripts/x.ts");
});

test("a genuinely missing file returns the plainly-resolved path", () => {
	const resolved = resolveExistingPath("scripts/missing.ts", "/project", existsIn([]));
	assert.equal(resolved, "/project/scripts/missing.ts");
});

test("with multiple candidate roots, the first root where the file exists wins", () => {
	// e.g. [process.cwd() = worktree, ctx.cwd = main]; file exists in both, prefer worktree
	const resolved = resolveExistingPath(
		"scripts/worktree/lib.sh",
		["/worktree", "/main"],
		existsIn(["/worktree/scripts/worktree/lib.sh", "/main/scripts/worktree/lib.sh"]),
	);
	assert.equal(resolved, "/worktree/scripts/worktree/lib.sh");
});
