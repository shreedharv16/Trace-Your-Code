# Manual QA checklist

Unit tests (`npm test`) cover the diff-count math. The rest touches the live VS Code API
and the filesystem, so run through this once in the Extension Development Host (press F5)
before publishing a release.

## Setup
- [ ] Open a throwaway folder with a few text files (and at least one subfolder).
- [ ] Open the **Trace Your Code** panel from the activity bar.
- [ ] Empty state shows the "No checkpoint yet" message with a **Take Checkpoint** button.

## Checkpoint + detection
- [ ] Click **Take Checkpoint**. Notification confirms N files snapshotted.
- [ ] Panel now shows the "No changes since your last checkpoint" state.
- [ ] Edit a file (change/add/remove some lines). Within ~1s it appears as `M` with the
      correct green `+` / red `-` counts.
- [ ] Create a new file → appears as `A` (green `+only`).
- [ ] Delete a tracked file → appears as `D` (red `-only`).
- [ ] The view badge shows the number of changed files.

## Diff + navigation
- [ ] Click a modified file → diff opens and the cursor lands on the **first** change, not
      the top.
- [ ] The diff editor's next/previous-change arrows step through multiple edits.
- [ ] Added file diff shows everything as added; deleted file diff shows everything removed.

## Accept (whole file)
- [ ] Accept a modified file → it leaves the list; editing it again re-detects from the new
      baseline.
- [ ] Accept an added file → leaves the list; the file is unchanged on disk.
- [ ] Accept a deleted file → leaves the list; the file stays deleted.

## Reject (whole file)
- [ ] Reject a modified file → file content on disk is restored to the checkpoint.
- [ ] Reject an added file → the new file is removed (check Trash/Recycle Bin to confirm it
      was trashed, not hard-deleted).
- [ ] Reject a deleted file → the file is recreated with its checkpoint content.

## Bulk
- [ ] **Accept All** clears the list and advances the checkpoint.
- [ ] **Reject All** prompts for confirmation, then reverts every file.

## Edge cases
- [ ] A file larger than `changeTracker.maxFileSizeKB` is ignored (not listed).
- [ ] A binary file (e.g. a small PNG) is ignored.
- [ ] **Clear Checkpoint** returns the panel to the "No checkpoint yet" state and leaves
      your files untouched.
- [ ] Reload the window (Developer: Reload Window) → the checkpoint persists and the same
      changes are still listed.
