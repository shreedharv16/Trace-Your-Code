/**
 * Self-contained line-level diff used only for the +added / -removed counts
 * shown in the tree. The actual visual diff is rendered by VS Code's native
 * diff editor, so we don't need a full hunk algorithm here.
 */

export interface LineDiffCounts {
  added: number;
  removed: number;
}

/** Count added/removed lines between two texts. */
export function countLineChanges(oldText: string, newText: string): LineDiffCounts {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0) {
    return { added: b.length, removed: 0 };
  }
  if (b.length === 0) {
    return { added: 0, removed: a.length };
  }
  const lcs = lcsLength(a, b);
  return { removed: a.length - lcs, added: b.length - lcs };
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  // A trailing newline yields a final empty element; drop it so counts match
  // what a human would expect.
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * Length of the longest common subsequence of two string arrays.
 * Two-row dynamic programming: O(n*m) time, O(m) space.
 */
function lcsLength(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  return prev[m];
}
