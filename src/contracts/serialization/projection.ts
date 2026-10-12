import { Schema, SchemaGetter } from "effect";

/** Output DTO metadata is clipped instead of invalidating an entire IPC payload. */
export const ipcProjectionString = (maximum: number) =>
  Schema.String.pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.slice(0, maximum)),
      encode: SchemaGetter.transform((value) => value.slice(0, maximum)),
    }),
  );

/** Output DTO collections retain the bounded prefix instead of invalidating the payload. */
export const ipcProjectionArray = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.Array(item).pipe(
    Schema.decode({
      decode: SchemaGetter.transform((value) => value.slice(0, maximum)),
      encode: SchemaGetter.transform((value) => value.slice(0, maximum)),
    }),
  );
