# Contributing

Thanks for helping! The most-wanted contributions, in order:

1. **Parsers for more agents** — Cursor, Codex CLI, Gemini CLI, Aider. Look at
   `src/trace/claudeCodeParser.ts` for the pattern: read the agent's local logs,
   emit `TraceTurn[]`. Include a recorded log fixture in `test/` so format drift
   gets caught.
2. **Parser fixes** when an upstream log format changes (file an issue with a
   sample line even if you can't fix it yourself).
3. Bug fixes and UI polish.

## Dev setup

```bash
npm install
npm run compile   # or: npm run watch
npm test
```

Open the folder in VS Code and press **F5** to launch the Extension Development Host.

## Ground rules

- **Never commit secrets.** `api-keys.txt` and `.env` are gitignored — keep it
  that way. PRs containing keys are closed and the keys reported as compromised.
- The core promise is **local-only**: no PR that adds network calls, telemetry,
  or accounts to the free extension will be merged. (AI narration calls go only
  to the user's own configured provider.)
- Ground truth over claims: features must derive from real diffs/logs, not from
  model self-descriptions.
- Match the existing code style; keep dependencies at zero unless there's a very
  good reason.

## Sign-off (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
Sign each commit:

```bash
git commit -s -m "Add Cursor parser"
```

This adds a `Signed-off-by:` line certifying you have the right to contribute the
code under the MIT license. PRs with unsigned commits can't be merged.
