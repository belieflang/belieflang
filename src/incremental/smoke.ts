import { parseUpdate, request, updateSchema } from "./protocol.js";
import type { Case, Request, Result } from "./types.js";
export function smokeRequest(c: Case): Request {
  return request(
    "compatibility/smoke",
    "update",
    c,
    {
      operation: "Extract only changed facts; output no unchanged fields.",
      context: {
        [c.numeric]: { value: 8, status: "confirmed", sourceTurn: 1 },
      },
      message: {
        turn: 2,
        text: `Please change ${c.numeric} to 10; this replaces the previous figure.`,
      },
    },
    updateSchema(c.schema),
  );
}
export function validateSmoke(c: Case, result: Result) {
  if (result.error) throw new Error(result.error);
  if (
    !result.usage ||
    result.usage.input < 1 ||
    result.usage.output < 1 ||
    result.usage.cached === null ||
    result.usage.cacheWrite === null
  )
    throw new Error(
      "actual complete token/cache accounting must be verified before pilot",
    );
  if (!result.cost || Math.abs(result.cost.upper - result.cost.lower) > 1e-12)
    throw new Error("smoke cost cannot be reconciled from usage");
  if (
    !/^gpt-6-luna(?:-\d{4}-\d{2}-\d{2})?$/.test(result.metadata?.model ?? "") ||
    result.metadata?.tier !== "default"
  )
    throw new Error("smoke model/tier mismatch");
  const deltas = parseUpdate(result.output, c);
  if (
    deltas.length !== 1 ||
    deltas[0].op !== "set" ||
    deltas[0].field !== c.numeric ||
    deltas[0].value !== 10 ||
    deltas[0].basis !== "explicit"
  )
    throw new Error("structured output did not match smoke correction");
  return {
    status: "passed",
    usage: result.usage,
    usd: result.cost,
    metadata: result.metadata,
    replayed: result.replayed ?? false,
  };
}
