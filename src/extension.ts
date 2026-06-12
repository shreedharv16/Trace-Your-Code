import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { BaselineStore } from "./baselineStore";
import { ChangeModel, ChangeItem } from "./changeModel";
import { ChangeViewProvider } from "./webviewProvider";
import {
  BaselineContentProvider,
  BASELINE_SCHEME,
  baselineUri,
  emptyUri
} from "./baselineContentProvider";
import { TraceService } from "./trace/traceService";
import { Summarizer } from "./trace/summarizer";
import { TraceViewProvider } from "./trace/traceViewProvider";
import { DashboardServer } from "./trace/dashboardServer";
import {
  ShadowContentProvider,
  SHADOW_SCHEME,
  shadowUri
} from "./trace/shadowContentProvider";
import { TraceTurn, TurnSnapshot } from "./trace/traceTypes";

const encoder = new TextEncoder();

let store: BaselineStore;
let model: ChangeModel;
let provider: ChangeViewProvider;
let contentProvider: BaselineContentProvider;

// Activity-trace layer (sits on top of the diff engine).
let traceService: TraceService;
let summarizer: Summarizer;
let traceProvider: TraceViewProvider;
let dashboard: DashboardServer;
let shadowContentProvider: ShadowContentProvider;

// Set while we mutate files ourselves, so the file watcher doesn't trigger
// overlapping reloads mid-operation.
let suspendWatch = false;

export async function activate(context: vscode.ExtensionContext) {
  store = new BaselineStore(context);
  await store.init();
  model = new ChangeModel(store);
  contentProvider = new BaselineContentProvider(store);
  provider = new ChangeViewProvider(model, context.extensionUri);

  // --- Activity-trace layer ------------------------------------------------
  traceService = new TraceService(context);
  await traceService.load();
  summarizer = new Summarizer(context);
  shadowContentProvider = new ShadowContentProvider(() => traceService.shadow);
  dashboard = new DashboardServer({
    getTurns: () => traceService.turns,
    getSnapshot: (id) => traceService.snapshotFor(id),
    diffOfTurn: diffOfTurnHandler,
    fileAt: fileAtHandler,
    explain: explainTurnById,
    fileStory: fileStoryHandler,
    investigate: investigateHandler,
    restore: (turnId) => restoreTurn(turnId),
    aiStatus: () => aiState(),
    setAi: async (on) => {
      await setAiNarration(on);
      return aiState();
    }
  });
  traceProvider = new TraceViewProvider(context.extensionUri, {
    refresh: refreshTrace,
    summarizeAll: summarizeTrace,
    revertPrompt: revertPrompt,
    openFile: openTracedFile,
    openDashboard: openDashboard,
    setApiKey: setApiKeyAndRefresh,
    toggleAi: setAiNarration,
    openTurnDiff: openTurnDiff,
    explainTurn: explainTurnFromTimeline,
    restoreTurn: restoreTurn
  });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(
      BASELINE_SCHEME,
      contentProvider
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      SHADOW_SCHEME,
      shadowContentProvider
    ),
    vscode.window.registerWebviewViewProvider(
      ChangeViewProvider.viewType,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      TraceViewProvider.viewType,
      traceProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    { dispose: () => dashboard.stop() }
  );

  await setHasCheckpointContext();

  // Push any already-loaded trace into the timeline, then parse fresh in the
  // background so activation stays fast.
  traceProvider.setTurns(traceService.turns);
  void refreshTrace();

  // Watch the assistants' log folders so new turns are picked up (and shadow-
  // committed) automatically — no manual Refresh needed. fs.watch is used
  // because these folders live OUTSIDE the workspace.
  watchAssistantLogs(context);

  // Auto-refresh on disk changes (debounced).
  const watcher = vscode.workspace.createFileSystemWatcher("**/*");
  const onFs = debounce(() => {
    const auto = vscode.workspace
      .getConfiguration("changeTracker")
      .get<boolean>("autoRefresh", true);
    if (auto && !suspendWatch) {
      provider.reload();
    }
  }, 400);
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(onFs),
    watcher.onDidCreate(onFs),
    watcher.onDidDelete(onFs)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("changeTracker.takeCheckpoint", takeCheckpoint),
    vscode.commands.registerCommand("changeTracker.refresh", () => provider.reload()),
    vscode.commands.registerCommand("changeTracker.clearCheckpoint", clearCheckpoint),
    vscode.commands.registerCommand("changeTracker.acceptAll", acceptAll),
    vscode.commands.registerCommand("changeTracker.rejectAll", rejectAll),
    vscode.commands.registerCommand("changeTracker.acceptFile", (relPath: string) =>
      acceptFile(findItem(relPath))
    ),
    vscode.commands.registerCommand("changeTracker.rejectFile", (relPath: string) =>
      rejectFile(findItem(relPath))
    ),
    vscode.commands.registerCommand("changeTracker.openDiff", (relPath: string) =>
      openDiff(findItem(relPath))
    ),
    vscode.commands.registerCommand("changeTracker.refreshTrace", refreshTrace),
    vscode.commands.registerCommand("changeTracker.summarizeTrace", summarizeTrace),
    vscode.commands.registerCommand("changeTracker.setTraceApiKey", () =>
      setApiKeyAndRefresh()
    ),
    vscode.commands.registerCommand("changeTracker.openDashboard", openDashboard)
  );
}

export function deactivate() {
  dashboard?.stop();
  // Nothing else persistent to tear down; storage is flushed on each write.
}

function findItem(relPath: string): ChangeItem | undefined {
  return provider.current().find((i) => i.relPath === relPath);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function takeCheckpoint(): Promise<void> {
  if (!store.usable) {
    vscode.window.showWarningMessage(
      "Trace Your Code: open a folder before taking a checkpoint."
    );
    return;
  }
  const root = model.rootFolder();
  if (!root) {
    vscode.window.showWarningMessage(
      "Trace Your Code: no workspace folder is open."
    );
    return;
  }
  if ((vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
    vscode.window.showInformationMessage(
      `Trace Your Code tracks the first workspace folder only ("${root.name}").`
    );
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Trace Your Code" },
    async (progress) => {
      progress.report({ message: "Snapshotting current files\u2026" });
      const files = await model.collectFiles(progress);
      await store.takeCheckpoint(root.uri, files);
    }
  );

  await setHasCheckpointContext();
  const items = await provider.reload();
  vscode.window.showInformationMessage(
    `Checkpoint saved. ${store.listBaselinePaths().length} files snapshotted` +
      (items.length ? `; ${items.length} already differ.` : ".")
  );
}

async function clearCheckpoint(): Promise<void> {
  const pick = await vscode.window.showWarningMessage(
    "Clear the checkpoint? This only deletes the local snapshot \u2014 your files are untouched.",
    { modal: true },
    "Clear"
  );
  if (pick !== "Clear") {
    return;
  }
  await store.clear();
  await setHasCheckpointContext();
  await provider.reload();
}

async function openDiff(item?: ChangeItem): Promise<void> {
  if (!item) {
    return;
  }
  const base = path.basename(item.relPath);
  const title = `${base} (Checkpoint \u2194 Working)`;

  let left: vscode.Uri;
  let right: vscode.Uri;
  if (item.status === "A") {
    left = emptyUri();
    right = item.uri;
  } else if (item.status === "D") {
    left = baselineUri(item.relPath);
    right = emptyUri();
  } else {
    left = baselineUri(item.relPath);
    right = item.uri;
  }

  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true
  });

  // Jump to the first edited region. The diff editor needs a moment to compute
  // its changes; then "Go to Next Change" lands the cursor on the first one.
  // From there the diff editor's own next/previous-change arrows (and the
  // keyboard shortcuts) let you step through every edit in the file.
  await sleep(250);
  try {
    await vscode.commands.executeCommand(
      "workbench.action.compareEditor.nextChange"
    );
  } catch {
    // If it's not ready, the diff simply stays at the top \u2014 no harm.
  }
}

async function acceptFile(item?: ChangeItem): Promise<void> {
  if (!item) {
    return;
  }
  suspendWatch = true;
  try {
    await applyAccept(item);
  } finally {
    suspendWatch = false;
  }
  contentProvider.refresh(item.relPath);
  await provider.reload();
}

async function rejectFile(item?: ChangeItem): Promise<void> {
  if (!item) {
    return;
  }
  suspendWatch = true;
  try {
    await applyReject(item);
  } finally {
    suspendWatch = false;
  }
  contentProvider.refresh(item.relPath);
  await provider.reload();
}

async function acceptAll(): Promise<void> {
  const items = provider.current();
  if (items.length === 0) {
    return;
  }
  suspendWatch = true;
  try {
    for (const item of items) {
      await applyAccept(item);
      contentProvider.refresh(item.relPath);
    }
  } finally {
    suspendWatch = false;
  }
  await provider.reload();
  vscode.window.showInformationMessage(
    `Accepted ${items.length} file change(s). Checkpoint advanced.`
  );
}

async function rejectAll(): Promise<void> {
  const items = provider.current();
  if (items.length === 0) {
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Revert ${items.length} file(s) back to the checkpoint? This overwrites current contents on disk.`,
    { modal: true },
    "Revert All"
  );
  if (pick !== "Revert All") {
    return;
  }
  suspendWatch = true;
  try {
    for (const item of items) {
      await applyReject(item);
      contentProvider.refresh(item.relPath);
    }
  } finally {
    suspendWatch = false;
  }
  await provider.reload();
  vscode.window.showInformationMessage(
    `Reverted ${items.length} file(s) to the checkpoint.`
  );
}

// ---------------------------------------------------------------------------
// Accept / Reject primitives (always whole-file)
// ---------------------------------------------------------------------------

/** Keep the change: advance the baseline to match the current file. */
async function applyAccept(item: ChangeItem): Promise<void> {
  if (item.status === "D") {
    await store.removeBaseline(item.relPath);
    return;
  }
  const maxBytes =
    vscode.workspace
      .getConfiguration("changeTracker")
      .get<number>("maxFileSizeKB", 1024) * 1024;
  const text = await model.readText(item.uri, maxBytes);
  if (text === undefined) {
    return;
  }
  await store.setBaseline(item.relPath, text);
}

/** Discard the change: restore the file to its checkpoint state. */
async function applyReject(item: ChangeItem): Promise<void> {
  if (item.status === "A") {
    // Was not in the checkpoint -> remove the new file (to Trash, recoverable).
    try {
      await vscode.workspace.fs.delete(item.uri, {
        recursive: false,
        useTrash: true
      });
    } catch {
      await vscode.workspace.fs.delete(item.uri, { useTrash: false });
    }
    return;
  }

  // Modified or Deleted -> write the baseline content back to disk.
  const baseText = (await store.getBaseline(item.relPath)) ?? "";
  await ensureParentDir(item.uri);
  await vscode.workspace.fs.writeFile(item.uri, encoder.encode(baseText));
}

async function ensureParentDir(fileUri: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(path.dirname(fileUri.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // already exists
  }
}

// ---------------------------------------------------------------------------
// Activity-trace layer
// ---------------------------------------------------------------------------

/** Re-parse Claude Code + Copilot Chat logs and push to the timeline view. */
async function refreshTrace(): Promise<void> {
  try {
    const turns = await traceService.refresh();
    traceProvider.setAi(aiState());
    traceProvider.setTurns(turns);
  } catch (err) {
    console.error("Trace Your Code: trace refresh failed", err);
  }
}

/** Current AI-narration state, shared by the timeline panel + dashboard. */
function aiState(): { on: boolean; hasKey: boolean; llm: boolean } {
  return {
    on: summarizer.on,
    hasKey: summarizer.hasKey,
    llm: summarizer.enabled
  };
}

/**
 * Flip the AI-narration master toggle. Turning it ON without a key configured
 * leads straight into the key+endpoint input flow (in VS Code). The toggle is
 * persisted as a workspace setting, so it survives restarts — and it is OFF
 * by default even when a key exists on disk.
 */
async function setAiNarration(on: boolean): Promise<void> {
  await summarizer.setOn(on);
  if (on && !summarizer.hasKey) {
    await summarizer.promptKeyAndEndpoint();
  }
  traceProvider.setAi(aiState());
}

/** Run the key-setup flow, then refresh the AI-status indicator. */
async function setApiKeyAndRefresh(): Promise<void> {
  await summarizer.setApiKey();
  traceProvider.setAi(aiState());
}

/** Summarize any turns that don't yet have an LLM summary (opt-in). */
async function summarizeTrace(): Promise<void> {
  if (!summarizer.enabled) {
    const pick = await vscode.window.showInformationMessage(
      "Trace summarization is off. Enable it in Settings (changeTracker.trace.summarize) and set an API key.",
      "Set API Key"
    );
    if (pick === "Set API Key") {
      await summarizer.setApiKey();
    }
    return;
  }
  const pending = traceService.unsummarized();
  if (pending.length === 0) {
    vscode.window.showInformationMessage("Trace Your Code: all turns are already summarized.");
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Trace Your Code" },
    async (progress) => {
      let done = 0;
      for (const turn of pending) {
        progress.report({
          message: `Summarizing turns ${++done}/${pending.length}\u2026`
        });
        let diff: string | undefined;
        if (summarizer.sendDiffs) {
          diff = await diffForFiles(turn.filesTouched);
        }
        const summary = await summarizer.summarizeTurn(turn, diff);
        if (summary) {
          await traceService.setSummary(turn.id, summary);
        }
      }
    }
  );
  traceProvider.setTurns(traceService.turns);
}

/** Build a small combined diff (baseline -> current) for the LLM, if allowed. */
async function diffForFiles(relPaths: string[]): Promise<string | undefined> {
  if (relPaths.length === 0) {
    return undefined;
  }
  const items = provider.current().filter((i) => relPaths.includes(i.relPath));
  const chunks: string[] = [];
  for (const item of items.slice(0, 5)) {
    const base = (await store.getBaseline(item.relPath)) ?? "";
    const maxBytes =
      vscode.workspace
        .getConfiguration("changeTracker")
        .get<number>("maxFileSizeKB", 1024) * 1024;
    const cur = (await model.readText(item.uri, maxBytes)) ?? "";
    chunks.push(
      `# ${item.relPath}\n--- baseline\n${base.slice(0, 800)}\n+++ current\n${cur.slice(0, 800)}`
    );
  }
  return chunks.join("\n\n");
}

/** Revert every file a prompt touched back to the checkpoint (reuses reject). */
async function revertPrompt(relPaths: string[]): Promise<void> {
  const items = provider
    .current()
    .filter((i) => relPaths.includes(i.relPath));
  if (items.length === 0) {
    vscode.window.showInformationMessage(
      "Trace Your Code: none of this prompt's files currently differ from the checkpoint."
    );
    return;
  }
  const pick = await vscode.window.showWarningMessage(
    `Revert ${items.length} file(s) from this prompt back to the checkpoint? This overwrites current contents on disk.`,
    { modal: true },
    "Revert"
  );
  if (pick !== "Revert") {
    return;
  }
  suspendWatch = true;
  try {
    for (const item of items) {
      await applyReject(item);
      contentProvider.refresh(item.relPath);
    }
  } finally {
    suspendWatch = false;
  }
  await provider.reload();
  vscode.window.showInformationMessage(
    `Reverted ${items.length} file(s) from the selected prompt.`
  );
}

/** Open a workspace-relative file referenced by a trace turn. */
async function openTracedFile(relPath: string): Promise<void> {
  const root = model.rootFolder();
  if (!root) {
    return;
  }
  const uri = vscode.Uri.joinPath(root.uri, ...relPath.split("/"));
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: true });
  } catch {
    vscode.window.showWarningMessage(
      `Trace Your Code: could not open ${relPath} (it may have been deleted).`
    );
  }
}

// ---------------------------------------------------------------------------
// Time machine (shadow git) — per-turn diff / explain / restore
// ---------------------------------------------------------------------------

/** Resolve a turn + a usable snapshot (changed, non-historical, has parent). */
function turnWithSnapshot(
  turnId: string
): { turn: TraceTurn; snap: TurnSnapshot } | undefined {
  const turn = traceService.turns.find((t) => t.id === turnId);
  const snap = traceService.snapshotFor(turnId);
  if (!turn || !snap) {
    return undefined;
  }
  return { turn, snap };
}

function noSnapshotMessage(snap: TurnSnapshot | undefined): string {
  if (!snap) {
    return "No shadow snapshot exists for this turn yet (is git installed?).";
  }
  if (snap.historical) {
    return "This turn happened before Trace Your Code started recording — no per-turn snapshot exists.";
  }
  return "This turn didn't change any files (or it shares a snapshot with a neighbouring turn).";
}

/** Files this turn's snapshot actually changed (fallback to git name-status). */
async function filesOfTurn(turn: TraceTurn, snap: TurnSnapshot): Promise<string[]> {
  if (turn.filesTouched.length) {
    return turn.filesTouched;
  }
  const shadow = traceService.shadow;
  if (shadow && snap.parent && snap.changed) {
    return (await shadow.nameStatus(snap.parent, snap.commit)).map((e) => e.relPath);
  }
  return [];
}

/** "View diff as it happened": before-turn ↔ after-turn from the shadow repo. */
async function openTurnDiff(turnId: string): Promise<void> {
  const found = turnWithSnapshot(turnId);
  if (!found || !found.snap.parent || !found.snap.changed || found.snap.historical) {
    vscode.window.showInformationMessage(
      `Trace Your Code: ${noSnapshotMessage(found?.snap)}`
    );
    return;
  }
  const { turn, snap } = found;
  const parent = found.snap.parent;
  const files = await filesOfTurn(turn, snap);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      "Trace Your Code: this turn recorded no file changes."
    );
    return;
  }
  let pickPath = files[0];
  if (files.length > 1) {
    const sel = await vscode.window.showQuickPick(files, {
      placeHolder: "Pick the file to diff as it happened in this turn"
    });
    if (!sel) {
      return;
    }
    pickPath = sel;
  }
  await vscode.commands.executeCommand(
    "vscode.diff",
    shadowUri(parent, pickPath),
    shadowUri(snap.commit, pickPath),
    `${path.basename(pickPath)} (as it happened — before ↔ after turn)`,
    { preview: true }
  );
}

/** Real per-turn diff from the shadow repo (scoped to the turn's files). */
async function diffOfTurnHandler(turnId: string): Promise<string> {
  const found = turnWithSnapshot(turnId);
  const shadow = traceService.shadow;
  if (!found || !shadow || !found.snap.parent || !found.snap.changed || found.snap.historical) {
    return "";
  }
  const scope = found.turn.filesTouched.length
    ? found.turn.filesTouched
    : undefined;
  return shadow.diffBetween(found.snap.parent, found.snap.commit, scope);
}

/** File content at a turn boundary, for the dashboard's time travel view. */
async function fileAtHandler(
  turnId: string,
  relPath: string,
  when: "before" | "after"
): Promise<string | undefined> {
  const found = turnWithSnapshot(turnId);
  const shadow = traceService.shadow;
  if (!found || !shadow) {
    return undefined;
  }
  const commit = when === "before" ? found.snap.parent : found.snap.commit;
  if (!commit) {
    return undefined;
  }
  return shadow.fileAt(commit, relPath);
}

/** Grounded LLM explanation for a turn; cached on the turn after first run. */
async function explainTurnById(turnId: string): Promise<string | undefined> {
  const turn = traceService.turns.find((t) => t.id === turnId);
  if (!turn) {
    return undefined;
  }
  if (turn.explanation) {
    return turn.explanation;
  }
  if (!summarizer.enabled) {
    return undefined;
  }
  const diff = await diffOfTurnHandler(turnId);
  const text = await summarizer.explainTurn(turn, diff);
  if (text) {
    await traceService.setExplanation(turnId, text);
    traceProvider.setTurns(traceService.turns);
  }
  return text;
}

/** Timeline button wrapper around explainTurnById (progress + error UX). */
async function explainTurnFromTimeline(turnId: string): Promise<void> {
  if (!summarizer.enabled) {
    const pick = await vscode.window.showInformationMessage(
      "Explain needs the LLM. Set an API key (api-keys.txt) or enable changeTracker.trace.summarize.",
      "Set API Key"
    );
    if (pick === "Set API Key") {
      await summarizer.setApiKey();
    }
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Trace Your Code" },
    async (progress) => {
      progress.report({ message: "Explaining this change from the real diff…" });
      const text = await explainTurnById(turnId);
      if (!text) {
        vscode.window.showWarningMessage(
          "Trace Your Code: explanation failed (endpoint/key problem, or no diff for this turn)."
        );
      }
    }
  );
}

/** Restore the files a turn touched back to the state BEFORE that turn. */
async function restoreTurn(turnId: string): Promise<boolean> {
  const found = turnWithSnapshot(turnId);
  const shadow = traceService.shadow;
  if (!found || !shadow || !found.snap.parent || found.snap.historical) {
    vscode.window.showInformationMessage(
      `Trace Your Code: ${noSnapshotMessage(found?.snap)}`
    );
    return false;
  }
  const { turn, snap } = found;
  const parent = found.snap.parent;
  const files = await filesOfTurn(turn, snap);
  if (files.length === 0) {
    vscode.window.showInformationMessage(
      "Trace Your Code: this turn recorded no file changes to undo."
    );
    return false;
  }
  const pick = await vscode.window.showWarningMessage(
    `Restore ${files.length} file(s) to their state BEFORE this turn? ` +
      `Later edits to these files will be overwritten on disk.`,
    { modal: true },
    "Restore"
  );
  if (pick !== "Restore") {
    return false;
  }
  suspendWatch = true;
  try {
    await shadow.restorePaths(parent, files);
  } finally {
    suspendWatch = false;
  }
  await provider.reload();
  vscode.window.showInformationMessage(
    `Restored ${files.length} file(s) to before the selected turn.`
  );
  return true;
}

/** Build "Tell me this file's story" — per-chapter real diffs → LLM narrative. */
async function fileStoryHandler(relPath: string): Promise<string | undefined> {
  const shadow = traceService.shadow;
  if (!shadow || !summarizer.enabled) {
    return undefined;
  }
  const chapters: Array<{ when: string; prompt: string; diff: string }> = [];
  for (const turn of traceService.turns) {
    if (!turn.filesTouched.includes(relPath)) {
      continue;
    }
    const snap = traceService.snapshotFor(turn.id);
    if (!snap || !snap.parent || !snap.changed || snap.historical) {
      continue;
    }
    const diff = await shadow.diffBetween(snap.parent, snap.commit, [relPath]);
    chapters.push({ when: turn.timestamp, prompt: turn.prompt, diff });
    if (chapters.length >= 12) {
      break; // keep the LLM input bounded
    }
  }
  if (chapters.length === 0) {
    return undefined;
  }
  return summarizer.fileStory(relPath, chapters);
}

/**
 * Breakage detective: cumulative real diff from "last known good" turn to the
 * current state of the disk (a fresh snapshot is taken so unsaved-to-shadow
 * edits are included). The ground truth (changed files + diff) works with NO
 * API key; the LLM's ranked-suspects analysis is layered on top when enabled.
 */
async function investigateHandler(
  fromTurnId: string,
  description: string
): Promise<
  { changed: string[]; diff: string; analysis?: string } | undefined
> {
  const shadow = traceService.shadow;
  const from = traceService.snapshotFor(fromTurnId);
  const fromTurn = traceService.turns.find((t) => t.id === fromTurnId);
  if (!shadow || !from) {
    return undefined;
  }
  // Capture anything that changed since the last recorded turn too.
  const now = await shadow.commitSnapshot("auto: investigate snapshot");
  if (!now) {
    return undefined;
  }
  const changedEntries = await shadow.nameStatus(from.commit, now.commit);
  const changed = changedEntries.map((e) => `${e.status} ${e.relPath}`);
  const diff = await shadow.diffBetween(from.commit, now.commit);
  let analysis: string | undefined;
  if (summarizer.enabled) {
    const label = fromTurn
      ? `turn "${fromTurn.prompt.slice(0, 80)}" (${fromTurn.timestamp})`
      : fromTurnId;
    analysis = await summarizer.investigate(description, label, diff, changed);
  }
  return { changed, diff, analysis };
}

/**
 * Watch the assistants' log folders (outside the workspace) so new turns are
 * parsed + shadow-committed shortly after they happen.
 */
function watchAssistantLogs(context: vscode.ExtensionContext): void {
  const debouncedRefresh = debounce(() => void refreshTrace(), 2000);
  const dirs = [path.join(os.homedir(), ".claude", "projects")];
  const storage = context.storageUri;
  if (storage) {
    dirs.push(path.join(path.dirname(storage.fsPath), "chatSessions"));
  }
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) {
        continue;
      }
      const watcher = fs.watch(dir, { recursive: true }, () => debouncedRefresh());
      context.subscriptions.push({ dispose: () => watcher.close() });
    } catch {
      // fs.watch can fail on some filesystems — manual Refresh still works.
    }
  }
}

/** Start the local dashboard server (if needed) and open it in a browser. */
async function openDashboard(): Promise<void> {
  try {
    const url = await dashboard.start();
    await vscode.env.openExternal(vscode.Uri.parse(url));
    vscode.window.showInformationMessage(`Trace Your Code dashboard: ${url}`);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Trace Your Code: could not start dashboard (${String(err)}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function setHasCheckpointContext(): Promise<void> {
  await vscode.commands.executeCommand(
    "setContext",
    "changeTracker.hasCheckpoint",
    store.hasCheckpoint()
  );
}

function debounce(fn: () => void, ms: number): () => void {
  let handle: NodeJS.Timeout | undefined;
  return () => {
    if (handle) {
      clearTimeout(handle);
    }
    handle = setTimeout(fn, ms);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
