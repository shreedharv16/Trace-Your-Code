import * as vscode from "vscode";
import { BaselineStore } from "./baselineStore";

export const BASELINE_SCHEME = "changetracker";
const EMPTY_PATH = "/__empty__";

/**
 * Serves checkpoint (baseline) file content as virtual read-only documents so
 * VS Code's native diff editor can show "Checkpoint <-> Working" side by side.
 */
export class BaselineContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.onDidChangeEmitter.event;

  constructor(private readonly store: BaselineStore) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.path === EMPTY_PATH) {
      return "";
    }
    const relPath = uri.path.replace(/^\//, "");
    return (await this.store.getBaseline(relPath)) ?? "";
  }

  /** Tell the diff editor a baseline doc changed (after Accept/Reject). */
  refresh(relPath: string): void {
    this.onDidChangeEmitter.fire(baselineUri(relPath));
  }
}

/** URI for a file's baseline content. */
export function baselineUri(relPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: "/" + relPath });
}

/** URI that always resolves to an empty document (used for deleted files). */
export function emptyUri(): vscode.Uri {
  return vscode.Uri.from({ scheme: BASELINE_SCHEME, path: EMPTY_PATH });
}
