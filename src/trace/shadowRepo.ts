import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Shadow git engine — the time-machine backend.
 *
 * A *second*, tool-private git repository whose `.git` directory lives in the
 * extension's per-workspace storage folder, NOT inside the project. Every git
 * call passes `--git-dir=<storage>/shadow.git --work-tree=<project>`, so:
 *
 *   - the project folder gains ZERO new files;
 *   - the project's real `.git` (if any) is never read or written;
 *   - the user's git config, hooks and index are untouched.
 *
 * One commit is recorded per detected AI turn (see traceService.ts). That
 * gives us, for free: the content of any file at any turn, a real unified
 * diff for each turn, and one-call restore of a file / folder / project to
 * any point in its story.
 *
 * The repo respects the project's own .gitignore plus our default excludes
 * (written to <git-dir>/info/exclude), so node_modules etc. never enter it.
 */

export interface TurnCommit {
  /** Commit hash holding the state AFTER the turn. */
  commit: string;
  /** Parent commit (state BEFORE the turn). Undefined for the baseline. */
  parent?: string;
  /** False when the working tree had no changes (commit === previous HEAD). */
  changed: boolean;
}

export interface NameStatusEntry {
  status: "A" | "M" | "D" | "R";
  relPath: string;
}

const DEFAULT_EXCLUDES = [
  "node_modules/",
  ".git/",
  "dist/",
  "out/",
  "build/",
  ".next/",
  "coverage/",
  "*.vsix",
  ".DS_Store"
];

export class ShadowRepo {
  private initialized = false;
  private gitMissing = false;

  constructor(
    private readonly gitDir: string,
    private readonly workTree: string
  ) {}

  /** True once init() succeeded (git found, repo created). */
  get available(): boolean {
    return this.initialized && !this.gitMissing;
  }

  /** Run a git command against the shadow repo. Throws on failure. */
  private run(args: string[], allowFail = false): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        ["--git-dir", this.gitDir, "--work-tree", this.workTree, ...args],
        {
          cwd: this.workTree,
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
        },
        (err, stdout, stderr) => {
          if (err && !allowFail) {
            reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
          } else {
            resolve(stdout ?? "");
          }
        }
      );
    });
  }

  /**
   * Create the shadow repo if needed and configure it for byte-faithful,
   * hook-free, sign-free snapshotting. Safe to call repeatedly.
   */
  async init(): Promise<boolean> {
    if (this.initialized) {
      return this.available;
    }
    try {
      await fs.promises.mkdir(this.gitDir, { recursive: true });
      if (!fs.existsSync(path.join(this.gitDir, "HEAD"))) {
        await this.run(["init"]);
      }
      // Local-only identity + byte-faithful snapshots. No signing, no hooks.
      await this.run(["config", "user.name", "Trace Your Code"]);
      await this.run(["config", "user.email", "change-tracker@localhost"]);
      await this.run(["config", "core.autocrlf", "false"]);
      await this.run(["config", "commit.gpgsign", "false"]);
      await this.run(["config", "core.hooksPath", path.join(this.gitDir, "no-hooks")]);
      // Default excludes (the project's own .gitignore also applies).
      const info = path.join(this.gitDir, "info");
      await fs.promises.mkdir(info, { recursive: true });
      await fs.promises.writeFile(
        path.join(info, "exclude"),
        DEFAULT_EXCLUDES.join("\n") + "\n",
        "utf8"
      );
      this.initialized = true;
    } catch (err) {
      // git not installed / not on PATH → degrade gracefully, never crash.
      this.gitMissing = true;
      this.initialized = true;
      console.warn("Trace Your Code: shadow repo unavailable:", err);
    }
    return this.available;
  }

  /** Current HEAD hash, or undefined before the first commit. */
  async head(): Promise<string | undefined> {
    try {
      const out = await this.run(["rev-parse", "HEAD"]);
      return out.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Snapshot the working tree as one commit. Returns the commit info, or the
   * previous HEAD with changed=false when nothing differed.
   */
  async commitSnapshot(message: string): Promise<TurnCommit | undefined> {
    if (!this.available) {
      return undefined;
    }
    try {
      await this.run(["add", "-A"]);
      const prev = await this.head();
      const status = await this.run(["status", "--porcelain"]);
      if (!status.trim() && prev) {
        return { commit: prev, parent: prev, changed: false };
      }
      await this.run(["commit", "--no-verify", "-m", message]);
      const commit = (await this.run(["rev-parse", "HEAD"])).trim();
      return { commit, parent: prev, changed: true };
    } catch (err) {
      console.warn("Trace Your Code: shadow commit failed:", err);
      return undefined;
    }
  }

  /** File content at a commit, or undefined if it didn't exist there. */
  async fileAt(commit: string, relPath: string): Promise<string | undefined> {
    if (!this.available) {
      return undefined;
    }
    try {
      return await this.run(["show", `${commit}:${toPosix(relPath)}`]);
    } catch {
      return undefined;
    }
  }

  /** Unified diff between two commits (optionally limited to paths). */
  async diffBetween(
    from: string,
    to: string,
    relPaths?: string[]
  ): Promise<string> {
    if (!this.available) {
      return "";
    }
    const args = ["diff", "--no-color", "--unified=3", from, to];
    if (relPaths && relPaths.length) {
      args.push("--", ...relPaths.map(toPosix));
    }
    try {
      return await this.run(args);
    } catch {
      return "";
    }
  }

  /** The diff a single turn introduced (parent → commit). */
  async diffOfTurn(tc: TurnCommit, relPaths?: string[]): Promise<string> {
    if (!tc.parent || !tc.changed) {
      return "";
    }
    return this.diffBetween(tc.parent, tc.commit, relPaths);
  }

  /** Changed files between two commits as A/M/D/R entries. */
  async nameStatus(from: string, to: string): Promise<NameStatusEntry[]> {
    if (!this.available) {
      return [];
    }
    let out: string;
    try {
      out = await this.run(["diff", "--no-color", "--name-status", from, to]);
    } catch {
      return [];
    }
    const entries: NameStatusEntry[] = [];
    for (const line of out.split("\n")) {
      const m = line.match(/^([AMDR])\w*\t(.+)$/);
      if (m) {
        // For renames git prints "old\tnew" — keep the new path.
        const p = m[2].includes("\t") ? m[2].split("\t").pop()! : m[2];
        entries.push({ status: m[1] as NameStatusEntry["status"], relPath: p });
      }
    }
    return entries;
  }

  /**
   * Restore specific paths on disk to their state at `commit`.
   * Files that did not exist at that commit are deleted from disk.
   */
  async restorePaths(commit: string, relPaths: string[]): Promise<void> {
    if (!this.available || relPaths.length === 0) {
      return;
    }
    const existed: string[] = [];
    for (const p of relPaths) {
      const content = await this.fileAt(commit, p);
      if (content === undefined) {
        // Didn't exist back then → remove it now (best-effort).
        try {
          await fs.promises.rm(path.join(this.workTree, p), { force: true });
        } catch {
          // ignore
        }
      } else {
        existed.push(p);
      }
    }
    if (existed.length) {
      await this.run(["checkout", commit, "--", ...existed.map(toPosix)]);
    }
  }

  /** Restore the entire project to `commit` (files added later are deleted). */
  async restoreAll(commit: string): Promise<void> {
    if (!this.available) {
      return;
    }
    // Delete files that exist now but not at the target commit, then checkout.
    const entries = await this.nameStatus(commit, "HEAD");
    const addedSince = entries
      .filter((e) => e.status === "A")
      .map((e) => e.relPath);
    for (const p of addedSince) {
      try {
        await fs.promises.rm(path.join(this.workTree, p), { force: true });
      } catch {
        // ignore
      }
    }
    await this.run(["checkout", commit, "--", "."]);
  }

  /** Total number of shadow commits (for the dashboard header). */
  async commitCount(): Promise<number> {
    try {
      const out = await this.run(["rev-list", "--count", "HEAD"]);
      return parseInt(out.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
