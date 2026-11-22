#!/bin/sh
# Start the supervisor shim with the runner's Node, without modifying the app's PATH.
exec "${CAKE_QUEUED_ELECTRON_NODE:?Missing queue runner Node path}" "${0%/*}/electron-queue-executable.mjs" "$@"
