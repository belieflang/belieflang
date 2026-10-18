import type { OperationsContext } from "./workflows.js";
export function operationsPolicy(ctx: OperationsContext): boolean {
  const threshold = 0.99;
  return (
    ctx.intentConfidence >= threshold &&
    ctx.facts.environment.status === "confirmed" &&
    ctx.facts.service.status === "confirmed" &&
    ctx.facts.release.status === "confirmed" &&
    ctx.facts.environment.value === "production"
  );
}
