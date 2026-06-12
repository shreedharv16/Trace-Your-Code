import * as vscode from "vscode";
import { createHash } from "crypto";
import { BaselineStore, relativePath } from "./baselineStore";
import { countLineChanges } from "./diffUtil";

export type ChangeStatus = "A" | "M" | "D"; // Added, Modified, Deleted

export interface ChangeItem {
  relPath: string;
  uri: vscode.Uri; // location the file would live at under the checkpoint root
  status: ChangeStatus;
  added: number;
  removed: number;
}

const decoder = new TextDecoder("utf-8");

/**
 * Computes the difference between the current files on disk and the stored
 * checkpoint. This is the "ground truth" the panel shows — it reflects what is
 * actually on disk, independent of any assistant's description of its work.
 */
export class ChangeModel {
  constructor(private readonly store: BaselineStore) {}

  /** Whether a checkpoint snapshot currently exists. */
  hasCheckpoint(): boolean {
    return this.store.hasCheckpoint();
  }

  /** The workspace folder we operate in (first folder). */
  rootFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  private config() {
    const cfg = vscode.workspace.getConfiguration("changeTracker");
    return {
      include: cfg.get<string>("include", "**/*"),
      exclude: cfg.get<string>(
        "exclude",
        "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**}"
      ),
      maxBytes: cfg.get<number>("maxFileSizeKB", 1024) * 1024
    };
  }

  /** Read a file as UTF-8 text. Returns undefined if missing/too big/binary. */
  async readText(uri: vscode.Uri, maxBytes: number): Promise<string | undefined> {
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return undefined;
    }
    if (stat.type !== vscode.FileType.File) {
      return undefined;
    }
    if (stat.size > maxBytes) {
      return undefined;
    }
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch {
      return undefined;
    }
    if (looksBinary(bytes)) {
      return undefined;
    }
    return decoder.decode(bytes);
  }

  /**
   * Enumerate the files eligible for a checkpoint and read their contents.
   * Used by "Take Checkpoint".
   */
  async collectFiles(
    progress?: vscode.Progress<{ message?: string }>
  ): Promise<Array<{ relPath: string; content: string }>> {
    const root = this.rootFolder();
    if (!root) {
      return [];
    }
    const { include, exclude, maxBytes } = this.config();
    const pattern = new vscode.RelativePattern(root, include);
    const uris = await vscode.workspace.findFiles(pattern, exclude);

    const out: Array<{ relPath: string; content: string }> = [];
    let i = 0;
    for (const uri of uris) {
      i++;
      if (progress && i % 25 === 0) {
        progress.report({ message: `Snapshotting ${i}/${uris.length} files…` });
      }
      const text = await this.readText(uri, maxBytes);
      if (text === undefined) {
        continue; // skip binaries / oversize / unreadable
      }
      out.push({ relPath: relativePath(root.uri, uri), content: text });
    }
    return out;
  }

  /** Compare disk to checkpoint and return the list of changed files. */
  async computeChanges(): Promise<ChangeItem[]> {
    if (!this.store.hasCheckpoint()) {
      return [];
    }
    const root = this.rootFolder();
    if (!root) {
      return [];
    }
    const { include, exclude, maxBytes } = this.config();
    const pattern = new vscode.RelativePattern(root, include);
    const uris = await vscode.workspace.findFiles(pattern, exclude);

    const items: ChangeItem[] = [];
    const seen = new Set<string>();

    for (const uri of uris) {
      const text = await this.readText(uri, maxBytes);
      if (text === undefined) {
        continue;
      }
      const relPath = relativePath(root.uri, uri);
      seen.add(relPath);

      const baseHash = this.store.getHash(relPath);
      if (baseHash === undefined) {
        // Present now, not in checkpoint -> Added.
        const { added, removed } = countLineChanges("", text);
        items.push({ relPath, uri, status: "A", added, removed });
        continue;
      }
      const curHash = createHash("sha1").update(text, "utf8").digest("hex");
      if (curHash === baseHash) {
        continue; // unchanged
      }
      const baseText = (await this.store.getBaseline(relPath)) ?? "";
      const { added, removed } = countLineChanges(baseText, text);
      items.push({ relPath, uri, status: "M", added, removed });
    }

    // Anything in the checkpoint that no longer exists on disk -> Deleted.
    for (const relPath of this.store.listBaselinePaths()) {
      if (seen.has(relPath)) {
        continue;
      }
      const uri = vscode.Uri.joinPath(root.uri, ...relPath.split("/"));
      let exists = true;
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        exists = false;
      }
      if (!exists) {
        const baseText = (await this.store.getBaseline(relPath)) ?? "";
        const { added, removed } = countLineChanges(baseText, "");
        items.push({ relPath, uri, status: "D", added, removed });
      }
    }

    items.sort((a, b) => a.relPath.localeCompare(b.relPath));
    return items;
  }
}

/** Heuristic: a NUL byte in the first chunk means "treat as binary". */
function looksBinary(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 8000);
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}
