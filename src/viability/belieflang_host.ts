import { BeliefRuntime } from "../runtime.js";
import { parse } from "../parser.js";
import type { RuntimeValue } from "../ast.js";
import type { Context } from "./workflows.js";
import type { FactMemory } from "../fact_memory.js";
// The current interpreter prints application state even with trace:false.
// Suppress only presentation in these library-hosted examples; interpreter semantics are unchanged.
export class QuietRuntime extends BeliefRuntime {
  override printState() {}
  override printVars() {}
  override printObservations() {}
}
/** Genuine .bel execution, including merge_beliefs and confidence(), with a guarded host tool. */
export async function runBeliefLangPolicy(
  source: string,
  context: Context<any>,
  memory: FactMemory,
  execute: () => Promise<void>,
) {
  const runtime = new QuietRuntime(
    {
      read_context: () => context as unknown as RuntimeValue,
      read_intent: () => ({
        intent: {
          cardinality: "exclusive",
          domain: "closed",
          values: {
            execute: context.intentConfidence,
            abstain: 1 - context.intentConfidence,
          },
        },
      }),
      execute_guarded: async () => {
        await execute();
        return null;
      },
    },
    { memory },
  );
  await runtime.run(parse(source));
}
