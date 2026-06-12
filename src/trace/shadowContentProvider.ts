import * as vscode from "vscode";
import { ShadowRepo } from "./shadowRepo";

/**
 * Serves file content from shadow-git commits so VS Code's diff editor can
 * show "this file as it was at turn N" against any other point in time.
 *
 * URI shape:  change-tracker-shadow:/<relPath>?<commit>
 * (path keeps the filename so the diff tab gets proper syntax highlighting)
 */
export const SHADOW_SCHEME = "change-tracker-shadow";

export function shadowUri(commit: string, relPath: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: SHADOW_SCHEME,
    path: "/" + relPath.replace(/\\/g, "/"),
    query: commit
  });
}

export class ShadowContentProvider
  implements vscode.TextDocumentContentProvider
{
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly getShadow: () => ShadowRepo | undefined) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const shadow = this.getShadow();
    if (!shadow) {
      return "";
    }
    const relPath = uri.path.replace(/^\//, "");
    const commit = uri.query;
    if (!commit || !relPath) {
      return "";
    }
    return (await shadow.fileAt(commit, relPath)) ?? "";
  }
}
