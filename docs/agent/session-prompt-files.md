# File-backed task prompts

Independent session.create, permanent-chat sessions.create, individual sessions.send/reply accept promptFiles alongside short initialPrompt/text.

## Capture and authority

Paths resolve on the sender backend relative to its Working Directory (home for global Cake Chat); global Cake Chat should use absolute paths.
Files and symlink targets must stay inside user-authorized Projects/Managed Worktrees. Read permission is not a grant to unrelated storage.
Cake captures inline text first, then files in array order before dispatch. They are caller-supplied task instructions, never system/developer authority. Attachments/inputRefs remain data.
Recipients receive captured text, not paths to read. Source edits/deletion/restart cannot alter admitted content.
Existing Pi originals retain exact text, filename, requested/canonical paths, sender, encoding and lengths; transcript/history/search/messages.read use those originals. No second content store or attachment duplication.

## Limits and coverage

At most 20 UTF-8 regular files; 100000 bytes each and 100000 combined characters including provenance. Missing/unreadable/binary/invalid UTF-8/unauthorized/oversized input fails without silent truncation.
This reduces tool-argument size, not model context.
Not supported for Drafts, family assignments, forks, batch sends, schedules or private workers. Their existing contracts remain. Delivery/result modes do not change.
