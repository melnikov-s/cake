# Interview ownership and lifecycle

An Interview is structured user input, not a reusable Artifact. `interview.open`
accepts a `cake.request/v1` definition and waits for one validated answer or
cancellation. The definition has either trusted form fields or a sandboxed
HTML/React widget. The public input protocol is independent of `cake.artifact/v1`.

## Authority and transport

- `src/contracts/interviews/interview.ts` owns interview definitions, records,
  result/response schemas, validation, and errors.
- Each invocation is identified by its Pi tool-call ID plus its session ID. The
  definition's agent-supplied `id` does not conflate separate invocations.
- The runtime appends `cake.interview/v1` custom metadata to the Pi session with
  originating assistant-entry/tool-call provenance. Pi remains the only
  transcript authority; Cake does not store a second transcript or an artifact
  blob, revision, digest, catalog link, or artifact pointer for the interview.
- Projection attaches the definition and eventual tool result to the originating
  tool part on the active Pi branch. Orphaned or wrongly correlated metadata does
  not create a synthetic transcript row.
- Main's renderer-request coordinator owns live correlation and settlement. It
  dispatches `interview-requested` through the application event stream, not the
  artifact event stream. Responses use the separate `interviews.respond` RPC and
  interview domain/handler path.
- Connection, session, and request correlations must match. Invalid answers leave
  the request open. Duplicate or stale interview responses fail rather than
  claiming a new successful settlement. Cancellation, abort, session/runtime
  disposal, and loss of the owning connection settle the pending request; the
  runtime distinguishes user cancellation from interruption of the Pi turn.

## Renderer ownership

The complete ownership branch is:

```text
RootStore
└── SessionRegistryStore
    └── ProjectSessionStore (keyed by session)
        └── InterviewStore[] (keyed by invocation)
```

`ProjectSessionStore` derives its keyed interview children from projected
interviews and live requests. A live request can supply the record before the Pi
metadata arrives. When the transcript projection catches up, the same keyed
child remains; answer state is not transferred through React or another Store.

Each `InterviewStore` owns partial form answers, freeform **Other** selections,
the current question/review step, single-flight submission, errors, and the local
acknowledged result. Its React views only render that workflow. Viewport
virtualization, remounting, and selecting another Cake Session do not remove the
owning Project Session Store or its interview children.

These editable values are in-memory renderer workflow state, not snapshot-marked
composer drafts or Draft Sessions. They do not survive restarting Cake. Completed
answers are restored from Pi tool results, not a new Cake persistence mechanism.

## Retention and cleanup

- Failed validation or delivery retains answers and navigation for correction or
  retry. A concurrent second submission cannot start another request.
- Successful submission or explicit cancellation clears editable answer state.
  If the invocation remains in the transcript, the child remains as its completed
  presentation using the result retained by Pi/the local acknowledgement.
- Terminal projected tool state or renderer unavailability removes the live
  request correlation. Unanswered historical interviews may submit an ordinary
  prompt (or steer while running), rather than responding to an expired request.
- An invocation absent from both the current transcript and live requests is
  removed from the keyed child collection and disposed. Removing/disposal of the
  owning session disposes every interview child and cancels its renderer work.
  Merely unmounting a view is not a removal event.

## Views and shared infrastructure

`Interview`, `InterviewForm`, and `InterviewWidget` are the authoritative views;
`BlockingInterviews` covers live requests not yet present in the transcript.
Trusted forms default selects to the first recommended option and always provide
an **Other** freeform option. Partial form answers belong to the interview Store.
Custom widgets retain their own sandbox-local UI until they submit; there is no
partial-widget-answer protocol.

Widgets reuse Cake's compilation and sandbox primitives. HTML receives
`cakeRequest.submit(value)`/`cakeRequest.cancel()`; React receives `submit` and
`cancel` props. Frame identity and compilation tokens gate submitted messages.
This infrastructure sharing does not grant artifacts response APIs or make an
interview an artifact.

Regression coverage exercises remount restoration, independent invocation and
session identities, request-to-transcript continuity, failed delivery/retry,
historical completion, cancellation, child/session disposal, and token-bound
widget submission. Hidden Electron tests verify actual DOM input, navigation,
dictation, and transcript-row unmount/remount behavior.
