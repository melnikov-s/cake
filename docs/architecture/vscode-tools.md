# VS Code navigation and selection tools

`vscode.open` is navigation only: `{ path, line? }`. Paths are Working
Directory-relative or absolute local paths; `line` is one-based. It opens the
file and optionally scrolls to that line, without changing text selection,
creating highlights or selection pills, or modifying the session's selection
set. It rejects range, column, diff and other selection fields. Its agent result
contains `opened`, `location` (path and optional line), and the actual `view`.
Authorized external files use Cake's read-only viewer.

## Source selections

`vscode.selections.add` and `vscode.selections.set` both accept:

```json
{
  "selections": [
    { "path": "src/main.ts", "line": 55, "endLine": 64 },
    {
      "path": "src/main.ts",
      "line": 92,
      "endLine": 108,
      "view": "changes",
      "side": "before",
      "base": "main"
    }
  ]
}
```

Each entry requires `path` and `line`. Optional `column`, `endLine` and
`endColumn` define one source range. Coordinates are one-based, bounded to
1–10,000,001. Omitted start column means the start of the line; omitted end line
means the start line; omitted end column means the end of the final line.
Explicit columns describe exclusive endpoints, as in the native editor.
Reversed ranges are invalid. Multiple entries express disjoint ranges or files;
a call accepts at most 50 entries. Unknown fields are rejected.

For diffs, `view` is `changes`, `side` defaults to `after`, and `base` defaults
to `HEAD` (uncommitted changes). A base such as `main` includes committed work.
`side` and `base` require `view: "changes"`. Invalid revision syntax is rejected.
If the companion cannot show a diff, it resolves a file range instead; the
returned reveal outcome reports the fallback (`no-changes`, `unknown-base`, or
`git-unavailable`). Native ranges are clamped to the actual document. External
read-only viewers cannot resolve selections and therefore fail the mutation.
Optional `group`, `preview` and `preserveFocus` retain editor presentation control
for selection navigation; they are not selection identity.

- **add** appends in request order, reusing IDs for identical resolved ranges.
  Repeated calls accumulate; an empty array is a no-op.
- **set** replaces the entire calling session's collection in request order,
  retaining IDs for identical ranges already present. An empty array clears it.
- Both validate the complete input and resolve every location before publishing
  any selection changes. A validation, file-opening or range-resolution failure
  leaves the prior collection intact. Resolution may navigate between files;
  navigation itself is not rolled back.
- Mutations are serialized with the Store's navigation/remove/clear operations.
  The collection is published coherently and highlights refresh once. A highlight
  projection failure returns a warning, without undoing the successful mutation.

The agent result includes session identity, a bounded page of selections in
one-based coordinates, `selectionIds` in resolved request order, `reveals` with
actual views/fallbacks and resolved locations, and any projection `warning`.
Use `vscode.selections.list` to page the complete collection (default 20, maximum
50, with optional path query). The renderer bridge carries the typed full state
and zero-based resolved locations; it is not a second collection authority.

## Ownership and retained operations

Each retained session's `EditorSelectionsStore` owns its ephemeral collection.
It is not persisted across restarts or sent as session identity/IDs to VS Code;
the native highlight payload contains locations only. Selection identity includes
file, range, actual view, and, for diffs, side and base.

`open`, `add`, and `set` require VS Code mode and the calling session selected.
Background calls never navigate another session's editor. `list`, `remove { id }`
and `clear {}` continue to address the caller's collection while hidden or while
another session is selected. Removing an unknown ID is idempotent. An unavailable
owning Store is an error, never a fallback to another session.

Clickable source links and pill reveal actions retain their existing source-range
behavior; they are not invocations of the navigation-only `vscode.open` tool.
