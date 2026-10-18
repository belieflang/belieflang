import type {
  Context,
  Workflow,
  TravelContext,
  SupportContext,
  OperationsContext,
} from "./workflows.js";
import { travelPolicy } from "./travel.js";
import { supportPolicy } from "./support.js";
import { operationsPolicy } from "./operations.js";
export function selectTypeScriptPolicy(
  workflow: Workflow,
  context: Context<any>,
): boolean {
  // Dynamic harness boundary: context fields are constructed from the matching validated workflow schema.
  switch (workflow.id) {
    case "travel":
      return travelPolicy(context as TravelContext);
    case "support":
      return supportPolicy(context as SupportContext);
    case "operations":
      return operationsPolicy(context as OperationsContext);
  }
}
