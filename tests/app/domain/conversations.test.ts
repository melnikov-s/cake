import { describe, expect, it } from "vitest";
import { projectQueuedMessages } from "../../../src/domain/conversations";

describe("conversation projections", () => {
  it("maps Pi queue state into a detached Cake conversation value", () => {
    const piQueue = { steering: ["change direction"], followUp: ["do this next"] };

    const projected = projectQueuedMessages(piQueue);
    piQueue.steering.push("later");

    expect(projected).toEqual({
      steering: ["change direction"],
      followUp: ["do this next"],
    });
  });
});
