/**
 * Structural facts from a unified diff — no LLM, never hallucinates.
 *
 * We scan added/removed lines for function-ish declarations across the
 * common languages (JS/TS, Python, Java/C#, Go, Rust, Ruby, PHP). The result
 * ("this turn added validateSession() and removed legacyLogin()") is shown
 * as ground truth next to the LLM's narrative explanation.
 */

export interface CodeFacts {
  /** Function/method/class names introduced by the diff. */
  added: string[];
  /** Function/method/class names removed by the diff. */
  removed: string[];
}

const DECL_PATTERNS: RegExp[] = [
  // JS/TS: function foo(, async function foo(, export function foo(
  /(?:^|\s)function\s+([A-Za-z_$][\w$]*)\s*\(/,
  // JS/TS: const foo = (…) =>   |   const foo = async (…) =>
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^)=]*\)?\s*=>/,
  // JS/TS class methods: foo(args) {   (skip control keywords)
  /^\s*(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*\{/,
  // Class / interface declarations
  /(?:^|\s)(?:class|interface)\s+([A-Za-z_$][\w$]*)/,
  // Python: def foo(   |   async def foo(
  /(?:^|\s)def\s+([A-Za-z_]\w*)\s*\(/,
  // Go: func foo(   |   func (r *T) foo(
  /(?:^|\s)func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  // Rust: fn foo(
  /(?:^|\s)fn\s+([A-Za-z_]\w*)/,
  // Ruby: def foo
  /(?:^|\s)def\s+([a-z_]\w*[?!]?)/
];

const KEYWORD_BLOCKLIST = new Set([
  "if", "for", "while", "switch", "catch", "return", "constructor",
  "function", "async", "await", "new", "typeof", "else", "do", "try"
]);

function declaredNames(line: string): string[] {
  const names: string[] = [];
  for (const re of DECL_PATTERNS) {
    const m = line.match(re);
    if (m && m[1] && !KEYWORD_BLOCKLIST.has(m[1])) {
      names.push(m[1]);
    }
  }
  return names;
}

/** Extract added/removed declaration names from a unified diff. */
export function extractCodeFacts(unifiedDiff: string): CodeFacts {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const line of unifiedDiff.split("\n")) {
    // Skip file headers (---/+++) — only hunk body lines count.
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      for (const n of declaredNames(line.slice(1))) {
        added.add(n);
      }
    } else if (line.startsWith("-")) {
      for (const n of declaredNames(line.slice(1))) {
        removed.add(n);
      }
    }
  }
  // A name both added and removed is a *modification*, not add/remove —
  // keep it only on the added side so it reads as "touched".
  for (const n of added) {
    removed.delete(n);
  }
  return {
    added: Array.from(added).slice(0, 20),
    removed: Array.from(removed).slice(0, 20)
  };
}
