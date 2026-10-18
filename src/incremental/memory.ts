import {
  FactMemory,
  validateDeltas,
  type FactDelta,
  type FactSource,
  type FactValue,
  type MemoryCell,
} from "../fact_memory.js";
import { TypeScriptState } from "../viability/typescript_state.js";
import { BeliefRuntime, type FactSchema } from "../runtime.js";
import { missing, type Query, type Answer, type Case } from "./types.js";
export function asAnswer(
  cell:
    | { value?: FactValue; status?: string; source?: { turn: number } }
    | undefined,
): Answer {
  return cell?.status
    ? {
        value: cell.value ?? null,
        status: cell.status as Answer["status"],
        sourceTurn: cell.source?.turn ?? null,
      }
    : missing();
}
export class StructuredMemory {
  private state: FactMemory | TypeScriptState;
  constructor(schema: FactSchema, v3: boolean) {
    this.state = v3 ? new FactMemory(schema) : new TypeScriptState(schema);
  }
  apply(
    deltas: FactDelta[],
    source: FactSource,
    verified: Record<string, FactValue> = {},
  ) {
    return this.state instanceof FactMemory
      ? this.state.apply(deltas, source, verified)
      : this.state.applyExtracted(deltas, source, verified);
  }
  verify(facts: Record<string, FactValue>, source: FactSource) {
    return this.apply(hostDeltas(facts), source, facts);
  }
  read(q: Query): Answer {
    return asAnswer(
      q.temporal === "current"
        ? this.state.current[q.field]
        : this.state.retrieve(q.field, "original")[0],
    );
  }
  context() {
    return Object.fromEntries(
      Object.entries(this.state.current).map(([f, cell]) => [
        f,
        {
          ...asAnswer(cell),
          ...(cell.candidates ? { candidates: cell.candidates } : {}),
        },
      ]),
    );
  }
  snapshot() {
    return this.state.snapshot();
  }
}
/** Host authority is shared by every method. Values alone never resurrect old verification. */
export class Authority {
  proofs: Record<string, { value: FactValue; turn: number }> = {};
  approval?: {
    allowed: boolean;
    scope: Record<string, { value: FactValue; proofTurn: number | null }>;
  };
  verify(facts: Record<string, FactValue>, turn: number) {
    for (const [field, value] of Object.entries(facts))
      this.proofs[field] = { value, turn };
  }
  approve(allowed: boolean, values: Record<string, FactValue>) {
    this.approval = {
      allowed,
      scope: Object.fromEntries(
        Object.entries(values).map(([field, value]) => [
          field,
          {
            value,
            proofTurn:
              this.proofs[field]?.value === value
                ? this.proofs[field].turn
                : null,
          },
        ]),
      ),
    };
  }
  check(c: Case, answers: Record<string, Answer>) {
    if (!this.approval?.allowed)
      return { allowed: false, reason: "approval_missing_or_revoked" };
    for (const f of [c.numeric, c.flag]) {
      const a = answers[f],
        p = this.proofs[f],
        s = this.approval.scope[f];
      if (
        !a ||
        a.status !== "confirmed" ||
        a.sourceTurn === null ||
        !p ||
        p.value !== a.value ||
        p.turn < a.sourceTurn
      )
        return { allowed: false, reason: `unverified_revision:${f}` };
      if (!s || s.value !== a.value || s.proofTurn !== p.turn)
        return { allowed: false, reason: `stale_approval:${f}` };
    }
    const allowed =
      Number(answers[c.numeric].value) <= c.maximum &&
      answers[c.flag].value === true;
    return {
      allowed,
      reason: allowed ? "scoped_verified_policy" : "business_constraint",
    };
  }
}
/** Corrected v2 compatibility adapter, separate from frozen historical runner. Not a primary pilot condition. */
export class VerifiedV2Adapter {
  private runtime = new BeliefRuntime();
  private cells: Record<string, MemoryCell> = {};
  private lastTurn = 0;
  constructor(private schema: FactSchema) {
    this.runtime.declareFacts(schema);
  }
  verify(facts: Record<string, FactValue>, source: FactSource) {
    this.apply(hostDeltas(facts), source, facts);
  }
  apply(
    deltas: FactDelta[],
    source: FactSource,
    verified: Record<string, FactValue> = {},
  ) {
    validateDeltas(this.schema, deltas);
    if (source.turn <= this.lastTurn) throw new Error("nonmonotonic v2 source");
    const next = structuredClone(this.cells);
    for (const d of deltas) {
      const prior = next[d.field];
      if (
        d.op === "set" &&
        prior?.value === d.value &&
        verified[d.field] !== d.value
      )
        continue;
      let cell: MemoryCell;
      if (d.op === "clear")
        cell = {
          status: "cleared",
          confidence: d.confidence,
          revision: source.turn,
          source,
        };
      else if (
        d.op === "conflict" ||
        (d.basis === "inferred" &&
          prior &&
          prior.status !== "cleared" &&
          (prior.status === "conflicting" || prior.value !== d.value))
      )
        cell = {
          status: "conflicting",
          candidates: [
            ...new Set([
              ...(prior?.candidates ?? []),
              ...(prior?.value !== undefined ? [prior.value] : []),
              d.value,
            ]),
          ],
          confidence: d.confidence,
          revision: source.turn,
          source,
        };
      else
        cell = {
          value: d.value,
          status:
            verified[d.field] === d.value ||
            (prior?.status === "confirmed" && prior.value === d.value)
              ? "confirmed"
              : "uncertain",
          confidence: d.confidence,
          revision: source.turn,
          source,
        };
      const meaning = (c?: MemoryCell) =>
        c && [c.status, c.value, c.candidates];
      if (JSON.stringify(meaning(prior)) !== JSON.stringify(meaning(cell)))
        next[d.field] = cell;
    }
    // Legacy storage remains in use; the sidecar supplies statuses its active/cleared format cannot encode.
    this.runtime.mergeFactPatch(
      Object.fromEntries(
        deltas.map((d) => [
          d.field,
          {
            operation: d.op === "clear" ? "clear" : "set",
            ...(d.op !== "clear" ? { value: d.value } : {}),
            confidence: d.confidence,
            sourceTurn: source.turn,
          },
        ]),
      ),
    );
    this.cells = next;
    this.lastTurn = source.turn;
  }
  get current() {
    return structuredClone(this.cells);
  }
  legacySnapshot() {
    return this.runtime.getLongHorizonSnapshot();
  }
}
function hostDeltas(facts: Record<string, FactValue>): FactDelta[] {
  return Object.entries(facts).map(([field, value]) => ({
    field,
    value,
    op: "set",
    confidence: 1,
    basis: "explicit",
  }));
}
