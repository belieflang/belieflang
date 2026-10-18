import type { TravelContext } from "./workflows.js";
export function travelPolicy(ctx: TravelContext): boolean {
  const threshold = 0.85;
  return (
    ctx.intentConfidence >= threshold &&
    ctx.facts.destination.status === "confirmed" &&
    ctx.facts.budget.status === "confirmed" &&
    ctx.facts.departure_date.status === "confirmed" &&
    ctx.facts.direct.status === "confirmed" &&
    ctx.facts.budget.value !== null &&
    ctx.facts.budget.value > 0 &&
    ctx.facts.budget.value <= 3000
  );
}
