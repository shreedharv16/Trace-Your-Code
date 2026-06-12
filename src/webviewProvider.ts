import * as vscode from "vscode";
import { ChangeItem, ChangeModel } from "./changeModel";

/**
 * The Trace Your Code panel. Rendered as a WebviewView (rather than a TreeView)
 * because the TreeView API cannot show two foreground colors in one row, and we
 * want +added in green and -removed in red. The webview is styled entirely with
 * VS Code's own theme variables so it still matches the active color theme.
 *
 * The webview only renders rows and forwards user intent (open diff / accept /
 * reject / run a title-bar command) back to the extension via messages. All
 * real work happens through the same commands used by the title-bar buttons.
 */
export class ChangeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "changeTrackerView";

  private view: vscode.WebviewView | undefined;
  private items: ChangeItem[] = [];

  constructor(
    private readonly model: ChangeModel,
    private readonly extensionUri: vscode.Uri
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };

    // Register the message listener BEFORE setting html, so the webview's
    // initial "ready" message can't be missed.
    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case "ready":
          await this.reload();
          break;
        case "openDiff":
          await vscode.commands.executeCommand("changeTracker.openDiff", msg.relPath);
          break;
        case "accept":
          await vscode.commands.executeCommand("changeTracker.acceptFile", msg.relPath);
          break;
        case "reject":
          await vscode.commands.executeCommand("changeTracker.rejectFile", msg.relPath);
          break;
        case "command":
          if (typeof msg.command === "string") {
            await vscode.commands.executeCommand(msg.command);
          }
          break;
      }
    });

    view.webview.html = this.html(view.webview);

    view.onDidChangeVisibility(() => {
      if (view.visible) {
        this.reload();
      }
    });
  }

  current(): ChangeItem[] {
    return this.items;
  }

  /** Recompute from disk, push to the webview, and update the view badge. */
  async reload(): Promise<ChangeItem[]> {
    this.items = await this.model.computeChanges();
    if (this.view) {
      this.view.webview.postMessage({
        type: "render",
        hasCheckpoint: this.model.hasCheckpoint(),
        items: this.items.map((i) => ({
          relPath: i.relPath,
          status: i.status,
          added: i.added,
          removed: i.removed
        }))
      });
      this.view.badge =
        this.items.length > 0
          ? {
              value: this.items.length,
              tooltip: `${this.items.length} file(s) changed since checkpoint`
            }
          : undefined;
    }
    return this.items;
  }

  private html(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; font-family: var(--vscode-font-family); color: var(--vscode-foreground); }
  .list { display: flex; flex-direction: column; padding: 2px 0; }
  .row { display: flex; align-items: center; gap: 6px; padding: 1px 10px 1px 8px; height: 22px; cursor: pointer; user-select: none; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row:active { background: var(--vscode-list-activeSelectionBackground); }
  .status { flex: 0 0 auto; width: 12px; text-align: center; font-weight: 700; font-size: 12px; }
  .status.M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .status.A { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .status.D { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .name { flex: 0 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; }
  .dir { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .spacer { flex: 1 1 auto; }
  .counts { flex: 0 0 auto; font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .del { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .actions { flex: 0 0 auto; display: flex; gap: 1px; opacity: .45; }
  .row:hover .actions { opacity: 1; }
  button.icon { display: flex; align-items: center; justify-content: center; background: transparent; border: none; padding: 2px; border-radius: 4px; color: var(--vscode-icon-foreground, var(--vscode-foreground)); cursor: pointer; }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.2)); }
  .empty { padding: 12px 14px; color: var(--vscode-descriptionForeground); font-size: 13px; line-height: 1.5; }
  .empty p { margin: 0 0 10px 0; }
  .btnrow { display: flex; gap: 8px; flex-wrap: wrap; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 1px solid var(--vscode-button-border, transparent); padding: 4px 11px; border-radius: 2px; cursor: pointer; font-size: 13px; }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const root = document.getElementById('root');

  const ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M13 4.5 6.5 11 3 7.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_UNDO = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 3.5 3 7l3.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 7h6.5a3.5 3.5 0 0 1 0 7H7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function statusWord(s) { return s === 'A' ? 'Added' : s === 'D' ? 'Deleted' : 'Modified'; }
  function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
  function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

  function iconButton(svg, title, handler) {
    const b = document.createElement('button');
    b.className = 'icon';
    b.title = title;
    b.innerHTML = svg;
    b.addEventListener('click', (e) => { e.stopPropagation(); handler(); });
    return b;
  }

  function renderRows(items) {
    const list = document.createElement('div');
    list.className = 'list';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'row';
      row.title = statusWord(it.status) + ' \u2014 ' + it.relPath + '  (click to diff)';
      row.addEventListener('click', () => vscodeApi.postMessage({ type: 'openDiff', relPath: it.relPath }));

      const status = document.createElement('span');
      status.className = 'status ' + it.status;
      status.textContent = it.status;

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = basename(it.relPath);

      const dir = document.createElement('span');
      dir.className = 'dir';
      dir.textContent = dirname(it.relPath);

      const spacer = document.createElement('span');
      spacer.className = 'spacer';

      const counts = document.createElement('span');
      counts.className = 'counts';
      if (it.status !== 'D') {
        const add = document.createElement('span');
        add.className = 'add';
        add.textContent = '+' + it.added;
        counts.appendChild(add);
      }
      if (it.status !== 'A') {
        if (it.status !== 'D') { counts.appendChild(document.createTextNode(' ')); }
        const del = document.createElement('span');
        del.className = 'del';
        del.textContent = '-' + it.removed;
        counts.appendChild(del);
      }

      const actions = document.createElement('span');
      actions.className = 'actions';
      actions.appendChild(iconButton(ICON_CHECK, 'Accept this file', () => vscodeApi.postMessage({ type: 'accept', relPath: it.relPath })));
      actions.appendChild(iconButton(ICON_UNDO, 'Reject this file (revert to checkpoint)', () => vscodeApi.postMessage({ type: 'reject', relPath: it.relPath })));

      row.append(status, name, dir, spacer, counts, actions);
      list.appendChild(row);
    }
    return list;
  }

  function primaryButton(label, cmd) {
    const b = document.createElement('button');
    b.className = 'primary';
    b.textContent = label;
    b.addEventListener('click', () => vscodeApi.postMessage({ type: 'command', command: cmd }));
    return b;
  }

  function renderEmpty(hasCheckpoint) {
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    const p = document.createElement('p');
    if (!hasCheckpoint) {
      p.textContent = 'No checkpoint yet. Snapshot your files before letting Claude Code make changes \u2014 then this panel shows the real diffs on disk, so you can verify what actually changed.';
      wrap.appendChild(p);
      wrap.appendChild(primaryButton('Take Checkpoint', 'changeTracker.takeCheckpoint'));
    } else {
      p.textContent = 'No changes since your last checkpoint. Let Claude Code (or yourself) edit, then anything that differs appears here for per-file Accept / Reject.';
      wrap.appendChild(p);
      const bar = document.createElement('div');
      bar.className = 'btnrow';
      bar.appendChild(primaryButton('Refresh', 'changeTracker.refresh'));
      bar.appendChild(primaryButton('Re-take Checkpoint', 'changeTracker.takeCheckpoint'));
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function render(data) {
    root.textContent = '';
    if (!data.items || data.items.length === 0) {
      root.appendChild(renderEmpty(!!data.hasCheckpoint));
      return;
    }
    root.appendChild(renderRows(data.items));
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'render') { render(e.data); }
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function makeNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}
