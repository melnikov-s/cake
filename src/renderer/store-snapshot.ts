import { z } from "zod";
import type { StoreSnapshot } from "r-state-tree";
import { jsonValueSchema } from "../ipc/json-contract";

const storeChildSnapshotSchema: z.ZodType<StoreSnapshot & { key?: string | number }> = z.lazy(() =>
  z.object({
    key: z.union([z.string(), z.number()]).optional(),
    state: z.record(z.string(), jsonValueSchema),
    children: z.record(
      z.string(),
      z.union([storeChildSnapshotSchema, z.array(storeChildSnapshotSchema), z.null()]),
    ),
  }),
);

export const storeSnapshotSchema: z.ZodType<StoreSnapshot> = storeChildSnapshotSchema;
