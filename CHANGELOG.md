# Change Log

## 0.3.0 — Renamed to "Trace Your Code", multi-provider AI narration, prod readiness

- **Renamed**: the extension is now **Trace Your Code** (marketplace ID
  `trace-your-code`). Internal setting IDs (`changeTracker.*`) and the
  `CHANGE_TRACKER_*` keys-file variables are unchanged, so existing
  configurations keep working.

- **Bring your own key, any major vendor**: OpenAI, Anthropic (Claude), Google
  Gemini, OpenRouter, Azure OpenAI, or any OpenAI-compatible endpoint (Groq,
  Together, Mistral, DeepSeek, local Ollama, …). Guided setup picks provider →
  key → model → endpoint and writes `api-keys.txt` for you.
- AI narration remains **off by default** and strictly opt-in — a key on disk
  never auto-enables it.
- New setting `changeTracker.trace.provider`; `model` empty = provider default.
- Public-release hygiene: MIT packaging, hardened `.gitignore`/`.vscodeignore`
  (key files and local backups can never ship), marketplace metadata, public
  README, CONTRIBUTING with DCO, PUBLISHING guide.

## 0.2.0 — The time machine

- **Shadow git engine**: a tool-private git repo in the extension's storage folder
  (never inside your project, never touching your real `.git`) automatically commits a
  snapshot per detected AI turn. Requires git on PATH; degrades gracefully without it.
- **Per-turn evidence in the Activity Timeline**: *View diff* (before↔after, real diff
  editor), *Explain* (LLM narrative grounded in the actual diff + the assistant's
  reasoning), *Undo turn* (restore the turn's files to their pre-turn state).
- **Function facts**: `+ added()` / `− removed()` declaration chips mined structurally
  from each turn's diff — no LLM involved.
- **Auto-refresh**: the assistants' log folders are watched, so new turns appear (and
  are snapshotted) without clicking Refresh.
- **Project Story dashboard** (rebuilt): *Story* (chronological chapters with inline
  diffs and explanations), *Time Travel* (scrub any file through every turn that
  touched it; before/after content; "tell this file's story" biography), *Files*
  (churn map), *Ask* (breakage detective: "it worked at turn X — what changed since?").
- New setting `changeTracker.shadow.enabled` (default on).

## 0.1.0

Initial release.

- Take a local **checkpoint** (snapshot) of your workspace files.
- See every file that differs from the checkpoint, with green `+added` / red `-removed`
  counts and `M` / `A` / `D` status.
- Click a file to diff against the checkpoint; it jumps to the first edited region and the
  diff editor's next/previous-change controls step through the rest.
- **Accept** (advance the checkpoint) or **Reject** (revert the file on disk) per file, plus
  Accept All / Reject All.
- Fully local: no network calls, no telemetry. Snapshots live in the extension's
  per-workspace storage. Git is never touched.
