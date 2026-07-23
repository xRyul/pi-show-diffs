import { test } from "node:test";
import assert from "node:assert/strict";

import { fuzzyFindText, normalizeForFuzzyMatch } from "./diff-utils.ts";

test("fuzzy normalization collapses NFKC compatibility characters", () => {
	assert.equal(normalizeForFuzzyMatch("a\u2026b"), "a...b"); // ellipsis → three dots
	assert.equal(normalizeForFuzzyMatch("\uFB01le"), "file"); // ﬁ ligature → fi
	assert.equal(normalizeForFuzzyMatch("\uFF21BC"), "ABC"); // full-width Ａ → A
});

test("fuzzy match finds ASCII oldText against content that stores a unicode ellipsis", () => {
	const content = "before\nsee the note\u2026 and continue\nafter";
	const result = fuzzyFindText(content, "see the note... and continue");
	assert.equal(result.found, true);
	assert.equal(result.usedFuzzyMatch, true);
});
