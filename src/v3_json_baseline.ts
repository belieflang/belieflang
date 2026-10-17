import {
  validateDeltas,
  validateFactSchema,
  type FactDelta,
  type FactSource,
  type FactValue,
  type MemoryCell,
} from "./fact_memory.js";
import type { FactSchema } from "./runtime.js";
/** Ordinary objects plus rules. No BeliefRuntime, FactMemory, DSL, or snapshot machinery. */
export class PlainJsonMemory {
  current: Record<string, MemoryCell> = {};
  changes: { field: string; cell: MemoryCell; text: string }[] = [];
  private turns = new Map<number, string>();
  constructor(readonly schema: FactSchema) {
    validateFactSchema(schema);
  }
  apply(
    deltas: FactDelta[],
    source: FactSource,
    confirmations: Record<string, FactValue> = {},
  ) {
    validateDeltas(this.schema, deltas);
    const receipt = JSON.stringify({ deltas, confirmations, source });
    if (this.turns.has(source.turn)) {
      if (this.turns.get(source.turn) !== receipt)
        throw new Error("replay differs");
      return { changed: 0, unchanged: 0 };
    }
    if (
      !Number.isSafeInteger(source.turn) ||
      source.turn < 1 ||
      source.turn <= Math.max(0, ...this.turns.keys())
    )
      throw new Error("invalid source turn");
    let changed = 0,
      unchanged = 0;
    for (const delta of deltas) {
      const prior = this.current[delta.field];
      let cell: MemoryCell;
      if (delta.op === "clear")
        cell = {
          status: "cleared",
          confidence: delta.confidence,
          revision: 0,
          source,
        };
      else if (
        delta.op === "conflict" ||
        (delta.basis === "inferred" &&
          prior &&
          prior.status !== "cleared" &&
          (prior.status === "conflicting" || prior.value !== delta.value))
      ) {
        cell = {
          status: "conflicting",
          candidates: [
            ...new Set([
              ...(prior?.candidates ?? []),
              ...(prior?.value !== undefined ? [prior.value] : []),
              delta.value,
            ]),
          ],
          confidence: delta.confidence,
          revision: 0,
          source,
        };
      } else
        cell = {
          status:
            confirmations[delta.field] === delta.value ||
            (prior?.status === "confirmed" && prior.value === delta.value)
              ? "confirmed"
              : "uncertain",
          value: delta.value,
          confidence: delta.confidence,
          revision: 0,
          source,
        };
      const meaning = (c?: MemoryCell) =>
        c && [c.status, c.value, c.candidates];
      if (JSON.stringify(meaning(prior)) === JSON.stringify(meaning(cell))) {
        unchanged++;
        continue;
      }
      cell.source = { turn: source.turn, id: source.id };
      cell.revision = this.changes.length + 1;
      this.current[delta.field] = cell;
      this.changes.push({
        field: delta.field,
        cell: structuredClone(cell),
        text: source.text.slice(0, 512),
      });
      changed++;
    }
    this.turns.set(source.turn, receipt);
    return { changed, unchanged };
  }
  context() {
    return Object.fromEntries(
      Object.entries(this.current).map(([field, c]) => [
        field,
        {
          status: c.status,
          ...(c.value !== undefined ? { value: c.value } : {}),
          ...(c.candidates ? { candidates: c.candidates } : {}),
        },
      ]),
    );
  }
  retrieve(field: string, mode: "original" | "previous" | "changes") {
    const events = this.changes.filter((e) => e.field === field);
    const selected =
      mode === "original"
        ? events.filter((e) => e.cell.value !== undefined).slice(0, 1)
        : mode === "previous"
          ? events
              .filter(
                (e) =>
                  e.cell.value !== undefined &&
                  e.cell.value !== this.current[field]?.value,
              )
              .slice(-1)
          : events.slice(-3);
    return selected.map((e) => ({
      value: e.cell.value,
      status: e.cell.status,
      source: e.cell.source,
      text: e.text,
    }));
  }
  snapshot() {
    return {
      current: this.current,
      changes: this.changes,
      receipts: [...this.turns],
    };
  }
}
