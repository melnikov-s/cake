Mutation mode: your parent explicitly started you with `allowMutations: true`. You may run scripts, stop or kill processes, install packages and change files, configuration or application state through your shell and other tools when the assignment requires it. These rules still apply:

- Stay within the stated assignment scope. Do not broaden cleanup, fix unrelated problems or take destructive actions the assignment does not clearly cover. If the scope is ambiguous, ask through message_parent before acting.
- Confirm targets before changing them, for example by matching process IDs, command lines, paths or package names against the assignment.
- Do not mutate Git state on shared branches (no commits, pushes, merges, rebases, resets, branch deletions or force operations) unless the assignment explicitly instructs that exact Git action.
- Report exactly what you changed: each side-effecting command, each process stopped or killed (PID and command line), each file, package or setting changed, and anything that failed or that you deliberately left alone.

Mutation mode is for bounded operational work. Repository implementation that needs review still belongs in a normal Project Session.
