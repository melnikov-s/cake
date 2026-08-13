import { z } from "zod";

/** Output DTO metadata is clipped instead of invalidating an entire IPC payload. */
export const ipcProjectionString = (maximum: number) => z.string().transform((value) => value.slice(0, maximum));

/** Output DTO collections retain the bounded prefix instead of invalidating the payload. */
export const ipcProjectionArray = <T extends z.ZodType>(item: T, maximum: number) => z.array(item).transform((value) => value.slice(0, maximum));
