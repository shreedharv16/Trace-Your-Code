// Dev-time sanity check (not part of npm test): extract the timeline
// webview's <script> body from the compiled provider and make sure it parses.
// The script lives inside a TS template literal, so a stray backtick/escape
// would only blow up at runtime inside VS Code — catch it here instead.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(
  path.join(__dirname, "..", "out", "trace", "traceViewProvider.js"),
  "utf8"
);
const start = src.indexOf("<script nonce=");
const end = src.indexOf("</script>", start);
if (start < 0 || end < 0) {
  throw new Error("script block not found");
}
const body = src.slice(src.indexOf(">", start) + 1, end);
// `new Function` parses without executing — syntax errors throw here.
new Function(body);
console.log("timeline webview JS parses OK, length:", body.length);
