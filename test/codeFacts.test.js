// Unit tests for the structural code-facts extractor (functions/classes
// added/removed, mined from unified diffs). Run with: npm test

const test = require("node:test");
const assert = require("node:assert/strict");
const { extractCodeFacts } = require("../out/trace/codeFacts.js");

test("added JS function and arrow function are detected", () => {
  const diff = [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,3 +1,9 @@",
    "+export function validateSession(token) {",
    "+const refreshToken = async (old) => {",
    " const x = 1;"
  ].join("\n");
  const facts = extractCodeFacts(diff);
  assert.ok(facts.added.includes("validateSession"));
  assert.ok(facts.added.includes("refreshToken"));
  assert.deepEqual(facts.removed, []);
});

test("removed python def is detected", () => {
  const diff = "@@ -1,2 +1,1 @@\n-def legacy_login(user):\n     pass";
  const facts = extractCodeFacts(diff);
  assert.deepEqual(facts.added, []);
  assert.ok(facts.removed.includes("legacy_login"));
});

test("name present on both sides counts as touched (added only)", () => {
  const diff = "@@\n-function save(a) {\n+function save(a, b) {";
  const facts = extractCodeFacts(diff);
  assert.ok(facts.added.includes("save"));
  assert.ok(!facts.removed.includes("save"));
});

test("file headers and keywords are not declarations", () => {
  const diff = [
    "--- a/x.js",
    "+++ b/x.js",
    "@@",
    "+if (cond) {",
    "+for (const f of list) {",
    "+return fetch(url);"
  ].join("\n");
  const facts = extractCodeFacts(diff);
  assert.deepEqual(facts.added, []);
  assert.deepEqual(facts.removed, []);
});

test("class and go func declarations", () => {
  const diff = "@@\n+class SessionStore {\n+func (s *Server) Handle(w, r) {";
  const facts = extractCodeFacts(diff);
  assert.ok(facts.added.includes("SessionStore"));
  assert.ok(facts.added.includes("Handle"));
});
