/** Composite renderer identity; source IDs remain unchanged for Pi and RPC. */
export const projectionId = (ownerId: string, localKey: string) => `${ownerId}:${localKey}`;
