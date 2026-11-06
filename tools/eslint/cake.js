import { rule } from "./ast.js";
import viewCapabilityBoundaries from "./view-capability-boundaries.js";
import reactEffectOwnership from "./react-effect-ownership.js";
import reactiveCollectionContract from "./reactive-collection-contract.js";
import { nativeOrchestration, causeRecovery, namedOperations } from "./effect-conventions.js";
import deterministicTestWaits from "./deterministic-test-waits.js";

export default {
  rules: {
    "view-capability-boundaries": viewCapabilityBoundaries,
    "react-effect-ownership": reactEffectOwnership,
    "reactive-collection-contract": reactiveCollectionContract,
    "domain-native-orchestration": nativeOrchestration,
    "cause-recovery-boundaries": causeRecovery,
    "named-effect-operations": namedOperations,
    "deterministic-test-waits": deterministicTestWaits,
    "authoritative-controls": rule(
      "Use Cake's shared UI controls outside primitive implementations.",
      { control: "Use the authoritative Cake UI primitive instead of a raw {{tag}} control." },
      (context) => ({
        JSXOpeningElement(node) {
          if (
            node.name.type === "JSXIdentifier" &&
            ["button", "input", "select", "textarea"].includes(node.name.name)
          )
            context.report({ node, messageId: "control", data: { tag: node.name.name } });
        },
      }),
    ),
  },
};
