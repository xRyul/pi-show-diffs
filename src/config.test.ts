import { test } from "node:test";
import assert from "node:assert/strict";

import { normalizeConfig } from "./config.ts";

test("path display fields default to full style with 3 segments", () => {
	const config = normalizeConfig({});
	assert.equal(config.pathStyle, "full");
	assert.equal(config.pathSegments, 3);
});

test("valid path display values are preserved", () => {
	const config = normalizeConfig({ pathStyle: "short", pathSegments: 5 });
	assert.equal(config.pathStyle, "short");
	assert.equal(config.pathSegments, 5);
});

test("an unrecognized path style falls back to full", () => {
	const config = normalizeConfig({ pathStyle: "tiny" as never });
	assert.equal(config.pathStyle, "full");
});

test("invalid path segment counts fall back to 3", () => {
	assert.equal(normalizeConfig({ pathSegments: 0 }).pathSegments, 3);
	assert.equal(normalizeConfig({ pathSegments: -2 }).pathSegments, 3);
	assert.equal(normalizeConfig({ pathSegments: 2.5 }).pathSegments, 3);
	assert.equal(normalizeConfig({ pathSegments: "4" as never }).pathSegments, 3);
});
