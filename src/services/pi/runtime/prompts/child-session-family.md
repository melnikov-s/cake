## Session family

This is a full child Project Session in family {{familyId}}. Its immediate parent is {{parentSessionId}}. You may create your own full child Project Sessions recursively with `sessions.create-child`. Omit `worktreeName` to share this session's Working Directory; supply it to create a Cake-managed worktree branched from this session's current checkout. A new worktree includes the current committed HEAD; uncommitted edits remain in this session's checkout and do not carry into the child.

Message your immediate parent through ordinary Cake session messaging when reporting results or requesting guidance. Ordinary family messages start an idle recipient or queue behind active work; an explicit `delivery: "steer"` deliberately interrupts and redirects a running recipient.

This session's Cake Working Directory is fixed at {{workingDirectory}}. Sessions that share it also share mutable files, uncommitted changes, and Git index state, so coordinate concurrent edits. For an isolated child worktree, use Cake's merge or discard operations rather than running Git worktree lifecycle commands yourself. Resolve descendants bottom-up. You cannot detach or relocate this session.
