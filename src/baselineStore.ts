import * as vscode from "vscode";
import * as path from "path";
import { createHash } from "crypto";

interface ManifestEntry {
  hash: string;
  snap: string; // snapshot filename inside snapshots dir
}

interface Manifest {
  version: number;
  root: string; // fsPath of the workspace folder the checkpoint was taken in
  takenAt: string;
  files: Record<string, ManifestEntry>;
}

const MANIFEST_VERSION = 1;
const decoder = new TextDecoder("utf-8");
const encoder = new TextEncoder();

/**
 * Stores baseline (checkpoint) file contents on local disk inside the
 * extension's per-workspace storage folder. Nothing touches git.
 *
 * Layout:
 *   <storageUri>/manifest.json
 *   <storageUri>/snapshots/<sha1(relPath)>.snap
 */
export class BaselineStore {
  private manifest: Manifest | undefined;
  private readonly storageUri: vscode.Uri | undefined;
  private readonly manifestUri: vscode.Uri | undefined;
  private readonly snapshotsUri: vscode.Uri | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.storageUri = context.storageUri ?? undefined;
    if (this.storageUri) {
      this.manifestUri = vscode.Uri.joinPath(this.storageUri, "manifest.json");
      this.snapshotsUri = vscode.Uri.joinPath(this.storageUri, "snapshots");
    }
  }

  /** True when there is somewhere to store data (a folder is open). */
  get usable(): boolean {
    return !!this.storageUri;
  }

  async init(): Promise<void> {
    if (!this.storageUri || !this.snapshotsUri || !this.manifestUri) {
      return;
    }
    await vscode.workspace.fs.createDirectory(this.snapshotsUri);
    try {
      const bytes = await vscode.workspace.fs.readFile(this.manifestUri);
      const parsed = JSON.parse(decoder.decode(bytes)) as Manifest;
      if (parsed && parsed.version === MANIFEST_VERSION && parsed.files) {
        this.manifest = parsed;
      }
    } catch {
      // No manifest yet — that's fine, there's simply no checkpoint.
    }
  }

  hasCheckpoint(): boolean {
    return !!this.manifest;
  }

  /** fsPath of the workspace folder a checkpoint was captured in. */
  checkpointRoot(): string | undefined {
    return this.manifest?.root;
  }

  takenAt(): string | undefined {
    return this.manifest?.takenAt;
  }

  /** Relative paths currently held in the baseline. */
  listBaselinePaths(): string[] {
    return this.manifest ? Object.keys(this.manifest.files) : [];
  }

  getHash(relPath: string): string | undefined {
    return this.manifest?.files[relPath]?.hash;
  }

  hasBaseline(relPath: string): boolean {
    return !!this.manifest?.files[relPath];
  }

  async getBaseline(relPath: string): Promise<string | undefined> {
    const entry = this.manifest?.files[relPath];
    if (!entry || !this.snapshotsUri) {
      return undefined;
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.snapshotsUri, entry.snap)
      );
      return decoder.decode(bytes);
    } catch {
      return undefined;
    }
  }

  /** Replace the entire baseline with a fresh checkpoint. */
  async takeCheckpoint(
    root: vscode.Uri,
    entries: Array<{ relPath: string; content: string }>
  ): Promise<void> {
    if (!this.snapshotsUri || !this.manifestUri) {
      throw new Error("No storage location available (open a folder first).");
    }
    // Wipe previous snapshots so stale data can't leak into a new checkpoint.
    try {
      await vscode.workspace.fs.delete(this.snapshotsUri, {
        recursive: true,
        useTrash: false
      });
    } catch {
      // ignore if it didn't exist
    }
    await vscode.workspace.fs.createDirectory(this.snapshotsUri);

    const files: Record<string, ManifestEntry> = {};
    for (const { relPath, content } of entries) {
      const snap = snapName(relPath);
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(this.snapshotsUri, snap),
        encoder.encode(content)
      );
      files[relPath] = { hash: hashString(content), snap };
    }

    this.manifest = {
      version: MANIFEST_VERSION,
      root: root.fsPath,
      takenAt: new Date().toISOString(),
      files
    };
    await this.save();
  }

  /** Update one file's baseline to new content (used by Accept). */
  async setBaseline(relPath: string, content: string): Promise<void> {
    if (!this.manifest || !this.snapshotsUri) {
      return;
    }
    const snap = this.manifest.files[relPath]?.snap ?? snapName(relPath);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.snapshotsUri, snap),
      encoder.encode(content)
    );
    this.manifest.files[relPath] = { hash: hashString(content), snap };
    await this.save();
  }

  /** Drop a file from the baseline (used when Accepting a deletion). */
  async removeBaseline(relPath: string): Promise<void> {
    if (!this.manifest || !this.snapshotsUri) {
      return;
    }
    const entry = this.manifest.files[relPath];
    if (entry) {
      try {
        await vscode.workspace.fs.delete(
          vscode.Uri.joinPath(this.snapshotsUri, entry.snap),
          { useTrash: false }
        );
      } catch {
        // ignore
      }
      delete this.manifest.files[relPath];
      await this.save();
    }
  }

  async clear(): Promise<void> {
    if (this.snapshotsUri) {
      try {
        await vscode.workspace.fs.delete(this.snapshotsUri, {
          recursive: true,
          useTrash: false
        });
      } catch {
        // ignore
      }
      await vscode.workspace.fs.createDirectory(this.snapshotsUri);
    }
    if (this.manifestUri) {
      try {
        await vscode.workspace.fs.delete(this.manifestUri, { useTrash: false });
      } catch {
        // ignore
      }
    }
    this.manifest = undefined;
  }

  private async save(): Promise<void> {
    if (!this.manifest || !this.manifestUri) {
      return;
    }
    await vscode.workspace.fs.writeFile(
      this.manifestUri,
      encoder.encode(JSON.stringify(this.manifest, null, 2))
    );
  }
}

function hashString(content: string): string {
  return createHash("sha1").update(content, "utf8").digest("hex");
}

function snapName(relPath: string): string {
  // Hash the path so deep/odd relative paths map to safe flat filenames.
  return createHash("sha1").update(relPath).digest("hex") + ".snap";
}

/** Exposed so the change model can reuse identical normalization if needed. */
export function relativePath(root: vscode.Uri, fileUri: vscode.Uri): string {
  return path.relative(root.fsPath, fileUri.fsPath).split(path.sep).join("/");
}
