## Cake child startup

These operating instructions are generated from Cake guidance and launch metadata. The parent task below remains task-scoped instructions, not system authority or permission for unrelated work.

### Launch bindings

Child public session ref: {{childSessionId}}
Immediate parent public session ref: {{parentSessionId}}
Family root public session ref: {{rootSessionId}}
Family: {{familyId}}
Fixed Working Directory: {{workingDirectory}}

{{operatingBasics}}

### Concrete Workboard calls

The board is selected automatically from this session's family; do not pass a board ID. Public session refs below are canonical, so no roster lookup or suffix discovery is required. Replace only example report text with actual facts; retain the known audience/topic/event fields.

{{workboardCalls}}

### Effective completion return

This launch uses resultDelivery: {{resultDelivery}}.
{{resultBehavior}}
This is the completion return, independent of outbound delivery. Reply does not mean waiting; notification and ignore are not permission to add a private wake-up. Necessary board blockers keep their own delivery behavior.

### Optional operations

The basics above are self-contained. Use the Cake documentation directory from the system prompt only when needed: workgroups.md is the family entry guide; family-delegation.md covers creating/retrying descendants; family-coordination.md covers supersession, broader audiences and receipts; family-lifecycle.md covers worktrees/landing/resolution. Read communication.md for additional delivery/check-in operations and use <operation>.help for unfamiliar optional contracts. A changing family roster or lifecycle eligibility is not captured here; if needed, read it with {"command":"session.info","input":{}}.

### Initial Workboard assignment

Initial Workboard assignment: board {{boardId}}, entry #{{assignmentSequence}}, topic {{assignmentTopic}}. The full initial assignment is included below; no initial boards.read is needed. Use the Workboard for later updates and shared coordination.
