import type { SupportContext } from "./workflows.js";
export function supportPolicy(ctx: SupportContext): boolean {
  const threshold = 0.9;
  return (
    ctx.intentConfidence >= threshold &&
    ctx.facts.account_id.status === "confirmed" &&
    ctx.facts.resolution.status === "confirmed" &&
    ctx.facts.refund.status === "confirmed" &&
    ctx.facts.refund.value !== null &&
    ctx.facts.refund.value >= 0 &&
    ctx.facts.refund.value <= 100
  );
}
