// UI regression tests that do not require a browser or a DOM dependency.
// app.ts renders date fields as template strings, so inspect those templates
// directly to keep the editing contract explicit.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "..", "src", "app.ts"), "utf8");

test("date fields stay unrestricted while invalid ranges are corrected", () => {
  const dateInputs = appSource.match(/<input type="date"[^>]*>/g);

  // Visa, first-arrival, departure, and return fields must all accept any
  // calendar date. Invalid and overlapping ranges are reported by the UI,
  // rather than disabled in a native date picker.
  assert.equal(dateInputs.length, 4);
  for (const input of dateInputs) {
    assert.doesNotMatch(input, /\s(?:min|max)=/);
  }
  assert.doesNotMatch(appSource, /function overlapsRow\(/);
});
