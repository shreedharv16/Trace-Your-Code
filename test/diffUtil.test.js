// Unit tests for the pure diff-counting logic, which is where a silent bug in
// the +added / -removed numbers would hide. Run with: npm test
//
// The integration pieces (accept/reject file ops, deletion handling, the
// webview) are exercised via the manual checklist in CHECKLIST.md, or you can
// add a @vscode/test-electron harness later (see README).

const test = require("node:test");
const assert = require("node:assert/strict");
const { countLineChanges } = require("../out/diffUtil.js");

test("identical text -> no changes", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", "a\nb\nc"), { removed: 0, added: 0 });
});

test("one line modified -> +1 -1", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", "a\nX\nc"), { removed: 1, added: 1 });
});

test("appended lines -> only additions", () => {
  assert.deepEqual(countLineChanges("a\nb", "a\nb\nc\nd"), { removed: 0, added: 2 });
});

test("removed line -> only removals", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", "a\nc"), { removed: 1, added: 0 });
});

test("new file (empty baseline) -> all added", () => {
  assert.deepEqual(countLineChanges("", "a\nb\nc"), { removed: 0, added: 3 });
});

test("deleted file (empty current) -> all removed", () => {
  assert.deepEqual(countLineChanges("a\nb\nc", ""), { removed: 3, added: 0 });
});

test("trailing newline is ignored", () => {
  assert.deepEqual(countLineChanges("a\nb\n", "a\nb"), { removed: 0, added: 0 });
});

test("CRLF vs LF are treated the same", () => {
  assert.deepEqual(countLineChanges("a\r\nb\r\n", "a\nb\n"), { removed: 0, added: 0 });
});

test("insert a block in the middle -> additions only", () => {
  assert.deepEqual(
    countLineChanges("a\nb\nc", "a\nNEW1\nNEW2\nb\nc"),
    { removed: 0, added: 2 }
  );
});

test("replace a block -> counts both sides", () => {
  const r = countLineChanges("a\nb\nc\nd", "a\nX\nY\nZ\nd");
  assert.equal(r.removed, 2); // b, c gone
  assert.equal(r.added, 3); // X, Y, Z added
});

test("both empty -> nothing", () => {
  assert.deepEqual(countLineChanges("", ""), { removed: 0, added: 0 });
});
