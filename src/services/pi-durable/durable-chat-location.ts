import { join } from "node:path";

export const durableChatDatabase = (directory: string) => join(directory, "coordinator.sqlite");
