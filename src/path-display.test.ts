import { test } from "node:test";
import assert from "node:assert/strict";

import { formatDisplayPath } from "./path-display.ts";

test("full style returns the whole path unchanged", () => {
	assert.equal(formatDisplayPath("src/components/ui/button.tsx", "full", 3), "src/components/ui/button.tsx");
});

test("short style keeps only the last N segments with a leading ellipsis", () => {
	assert.equal(formatDisplayPath("a/b/src/components/ui/button.tsx", "short", 3), "…/components/ui/button.tsx");
});

test("short style leaves paths with fewer or equal segments untouched", () => {
	assert.equal(formatDisplayPath("components/ui/button.tsx", "short", 3), "components/ui/button.tsx");
	assert.equal(formatDisplayPath("button.tsx", "short", 3), "button.tsx");
});

test("short style honours a custom segment count", () => {
	assert.equal(formatDisplayPath("a/b/src/components/ui/button.tsx", "short", 1), "…/button.tsx");
	assert.equal(formatDisplayPath("a/b/src/components/ui/button.tsx", "short", 2), "…/ui/button.tsx");
});

test("short style with a non-positive segment count falls back to the full path", () => {
	assert.equal(formatDisplayPath("a/b/src/components/ui/button.tsx", "short", 0), "a/b/src/components/ui/button.tsx");
	assert.equal(formatDisplayPath("a/b/src/components/ui/button.tsx", "short", -2), "a/b/src/components/ui/button.tsx");
});
