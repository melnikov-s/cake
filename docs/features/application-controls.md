# Application controls and notifications

## Control routing

`NavigationStore` owns semantic cross-Store intents such as `openSession`,
`createSession`, and `openCakeChat`. UI and application controls invoke these
intents directly instead of assembling navigation recipes. Navigation coordinates
shell and pane transitions with focused workflow owners; Root only composes
dependencies.

`ApplicationControlStore` owns Project Session and Cake Chat control acceptance,
deduplication, invocation, response delivery, and lifetime cancellation. Its typed
host adapter composes focused capabilities; `NavigationStore` owns cross-Store
navigation and `ProjectSessionPlacementStore` owns Session Family presentation.
Root wires these owners rather than interpreting the protocol.

Definitions under `src/renderer/app-control` couple argument Schema, discovery
metadata, and typed handler. One immutable registry derives global and assistant
catalogs and dispatches by command name. Internal controls remain invocable without
advertising. Explicitly targeted Project controls share live-catalog validation.
Settings Schema/discovery stays renderer-independent; execution uses the originating
window's host. Plugin command interpretation stays at its own boundary. Adapters
neither duplicate workflows nor expose transport to ordinary Stores.

Renderer-owned actions use the process-scoped reverse-request coordinator and
existing RPC/native-event paths. Acknowledgement follows completed persistence;
request correlation is transient, not a second state authority.

## Notifications

Window-owned infrastructure routes native lifecycle events outside the Store tree.
`NotificationStore` owns transient agent notification delivery: a three-second
trailing debounce per calling Cake Session retains only the latest item in a burst.
Each Session has stable native group/notification identity. Agent-selected levels
do not bypass debouncing. Delivery presents an in-window toast and an Electron
operating-system notification.

## Verification

- [Notification workflow](../../tests/app/renderer/notification-workflow.test.tsx)
- [Navigation workflow](../../tests/app/renderer/project-navigation-workflow.test.tsx)
- [Application command registry](../../tests/app/renderer/application-commands.test.ts)
- Control routing and Schema changes should be verified through the relevant
  focused application-control workflow and agent operation tests.
