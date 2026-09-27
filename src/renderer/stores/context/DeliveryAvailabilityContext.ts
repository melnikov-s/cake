import { createContext } from "r-state-tree";

/** Host-owned command availability, used to disable chat submission before queueing. */
export const DeliveryAvailabilityContext = createContext<() => boolean>();
