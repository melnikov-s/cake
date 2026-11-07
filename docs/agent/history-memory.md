# Permanent-chat memory retrieval

For dialogue hidden behind bounded memory, not arbitrary transcript/database access. Exact known report refs go directly to messages.read; unknown refs use messages.list.

## Zoom relevant dialogue

Warm cache retains originals; uncertain/expired cache or context limits rebuild bounded chronological <chat> memory. id+n spans n dialogue entries: recent originals, older summaries. date(id) gives timestamp.
Use Zoom before acting on vague remembered dialogue or asking the user to repeat it. Expand relevant branches to originals, not the whole tree, then zoom(id,1) for dialogue and retained inline images.
n is a power of two; id must be divisible by n and the range must exist. Use current <chat>/Zoom-child handles, not SQLite entry IDs.
Leaf JSON has text, entryId, offset, totalChars, nextOffset. Continue same id,n with offset:nextOffset to null and concatenate text. Offsets are UTF-16 characters including header; maxChars defaults/maxes at 8000. Inline images accompany first page only.
Zoom indexes dialogue, not full tool records; tool-only entries have no leaf.

## Archive supplements

archive_search/read covers omitted/unlocated evidence, exact tool records or unavailable/truncated Zoom. It may read authorized dialogue too, but is not a shortcut replacing Zoom for represented dialogue.
After rebuild, old handles may identify different history. Use old line's [originals=A..B] as fromEntryId/throughEntryId, or a specific query, then archive_read. Fresh handles arrive at the next memory handoff.
Runtime [originals=A..B] bounds are inclusive archive entry IDs, not Zoom coordinates; never invent/copy them into summary text. Narrow relevant ranges; broaden to neighbors/tool-only gaps only as needed.
Omit query to browse. Page nextAfterEntryId as afterEntryId with unchanged bounds/filters to null before exhaustive negatives. Search scans at most 1000 entries and returns at most 20 excerpts per call.
Read exact retained text by default; section:record gives recorded tool arguments/results/errors/timing. Page nextOffset (UTF-16, at most 8000 chars), concatenate before parsing record JSON.

## Evidence limits

Preserve user/assistant/worker provenance. History is not current authorization; recorded calls do not establish success. Distinguish proposals, decisions and completed work.
Stored truncation is unrecoverable. Archive omits image bytes/reasoning; messages.read does not read attachments. Use attachments.read, not guessed storage paths.
Scope is the owning conversation, including a side chat's fork-visible history, not siblings/arbitrary databases.
current-time is rebuild UTC, not live clock; read backend time and clarify timezone. Current lasting instructions override remembered preferences and cannot be rewritten without authorization.
