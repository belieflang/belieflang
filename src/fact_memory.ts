import type {
  BeliefSnapshot,
  FactSchema,
  LongHorizonSnapshot,
} from "./runtime.js";

export type FactValue = string | number | boolean;
export type FactStatus = "confirmed" | "uncertain" | "conflicting" | "cleared";
/** Inference output only. Source identifiers and verification never come from the model. */
export type FactDelta =
  | {
      op: "set" | "conflict";
      field: string;
      value: FactValue;
      confidence: number;
      basis: "explicit" | "inferred";
    }
  | {
      op: "clear";
      field: string;
      confidence: number;
      basis: "explicit" | "inferred";
    };
export type FactSource = { turn: number; id: string; text: string };
export type SourceRef = Pick<FactSource, "turn" | "id">;
export type MemoryCell = {
  status: FactStatus;
  value?: FactValue;
  candidates?: FactValue[];
  confidence: number;
  revision: number;
  source: SourceRef;
};
export type ChangeEvent = {
  id: number;
  field: string;
  before?: MemoryCell;
  after?: MemoryCell;
  source: SourceRef;
  reason: "set" | "clear" | "conflict" | "deferred" | "migration";
  proposal?: FactDelta;
};
export type UpdatePolicy = { inferredMinConfidence: number };
export type MemorySnapshot = {
  version: 3;
  schema: FactSchema;
  current: Record<string, MemoryCell>;
  history: ChangeEvent[];
  sources: Record<string, FactSource>;
  receipts: { turn: number; id: string; patch: string }[];
  lastTurn: number;
  historyComplete: boolean;
  policy: UpdatePolicy;
  maxHistory: number;
  beliefs: BeliefSnapshot["beliefs"];
};
export type FactView = { current: Record<string, MemoryCell> };
const DEFAULT_POLICY: UpdatePolicy = { inferredMinConfidence: 0 };
const own = (value: object, key: string) => Object.hasOwn(value, key);
const clone = <T>(value: T): T => structuredClone(value);
const compareKeys = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => compareKeys(a, b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function validateFactSchema(schema: FactSchema): void {
  if (!object(schema)) throw new Error("fact schema required");
  for (const [field, declaration] of Object.entries(schema)) {
    const type =
      typeof declaration === "string" ? declaration : declaration?.type;
    if (
      !/^[a-z][a-z0-9_]*$/.test(field) ||
      ["constructor", "prototype"].includes(field) ||
      !["string", "number", "boolean"].includes(type ?? "")
    )
      throw new Error(`invalid field ${field}`);
    if (
      typeof declaration !== "string" &&
      declaration.enum !== undefined &&
      (type !== "string" ||
        !Array.isArray(declaration.enum) ||
        !declaration.enum.length ||
        new Set(declaration.enum).size !== declaration.enum.length ||
        declaration.enum.some((v) => typeof v !== "string"))
    ) {
      throw new Error(`invalid enum ${field}`);
    }
  }
}
export function validateFactValue(
  schema: FactSchema,
  field: string,
  value: unknown,
): asserts value is FactValue {
  if (!own(schema, field)) throw new Error(`undeclared fact ${field}`);
  const declaration = schema[field];
  const type = typeof declaration === "string" ? declaration : declaration.type;
  if (
    typeof value !== type ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    (typeof declaration !== "string" &&
      declaration.enum &&
      !declaration.enum.includes(value as string))
  ) {
    throw new Error(`invalid value for ${field}`);
  }
}
export function validateDeltas(
  schema: FactSchema,
  input: unknown,
): asserts input is FactDelta[] {
  if (!Array.isArray(input)) throw new Error("delta array required");
  const fields = new Set<string>();
  for (const item of input) {
    if (
      !object(item) ||
      typeof item.field !== "string" ||
      !own(schema, item.field) ||
      fields.has(item.field) ||
      !["set", "clear", "conflict"].includes(String(item.op)) ||
      !["explicit", "inferred"].includes(String(item.basis)) ||
      typeof item.confidence !== "number" ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1 ||
      Object.keys(item).some(
        (k) => !["op", "field", "value", "confidence", "basis"].includes(k),
      )
    )
      throw new Error("invalid or duplicate delta");
    if (item.op === "clear") {
      if (own(item, "value")) throw new Error("clear must not supply a value");
      if (item.basis !== "explicit")
        throw new Error("clearing requires an explicit withdrawal");
    } else validateFactValue(schema, item.field, item.value);
    fields.add(item.field);
  }
}
function validateSource(source: FactSource): void {
  if (
    !object(source) ||
    !Number.isSafeInteger(source.turn) ||
    source.turn < 1 ||
    typeof source.id !== "string" ||
    !/^[a-zA-Z0-9:_-]{1,128}$/.test(source.id) ||
    source.id === "__proto__" ||
    typeof source.text !== "string"
  )
    throw new Error("invalid host source");
}
function semantic(cell: MemoryCell | undefined): unknown {
  return (
    cell && {
      status: cell.status,
      value: cell.value,
      candidates: cell.candidates,
    }
  );
}

/** Optional runtime component: typed deltas, immutable audit events, and selective local retrieval. */
export class FactMemory {
  private data: MemorySnapshot;
  constructor(
    schema: FactSchema,
    options: { policy?: Partial<UpdatePolicy>; maxHistory?: number } = {},
  ) {
    validateFactSchema(schema);
    const policy = { ...DEFAULT_POLICY, ...options.policy };
    if (
      !Number.isFinite(policy.inferredMinConfidence) ||
      policy.inferredMinConfidence < 0 ||
      policy.inferredMinConfidence > 1
    )
      throw new Error("invalid update policy");
    const maxHistory = options.maxHistory ?? 256;
    if (!Number.isSafeInteger(maxHistory) || maxHistory < 1)
      throw new Error("invalid history limit");
    this.data = {
      version: 3,
      schema: clone(schema),
      current: {},
      history: [],
      sources: {},
      receipts: [],
      lastTurn: 0,
      historyComplete: true,
      policy,
      maxHistory,
      beliefs: {},
    };
  }
  get current(): Record<string, MemoryCell> {
    return clone(this.data.current);
  }
  snapshot(): MemorySnapshot {
    return clone(this.data);
  }
  /** Compact inference context deliberately omits event history, source text, receipts and schema metadata. */
  context(): Record<
    string,
    { value?: FactValue; status: FactStatus; candidates?: FactValue[] }
  > {
    return Object.fromEntries(
      Object.entries(this.data.current).map(([key, cell]) => [
        key,
        {
          status: cell.status,
          ...(cell.value !== undefined ? { value: cell.value } : {}),
          ...(cell.candidates ? { candidates: clone(cell.candidates) } : {}),
        },
      ]),
    );
  }
  apply(
    deltas: FactDelta[],
    source: FactSource,
    confirmations: Record<string, FactValue> = {},
  ) {
    validateDeltas(this.data.schema, deltas);
    validateSource(source);
    for (const [field, value] of Object.entries(confirmations))
      validateFactValue(this.data.schema, field, value);
    const patch = JSON.stringify({
      deltas: [...deltas]
        .sort((a, b) => compareKeys(a.field, b.field))
        .map((d) => ({
          field: d.field,
          op: d.op,
          ...(d.op !== "clear" ? { value: d.value } : {}),
          confidence: d.confidence,
          basis: d.basis,
        })),
      confirmations: Object.fromEntries(
        Object.entries(confirmations).sort(([a], [b]) => compareKeys(a, b)),
      ),
    });
    const previousReceipt = this.data.receipts.find(
      (r) => r.id === source.id || r.turn === source.turn,
    );
    if (previousReceipt) {
      if (
        previousReceipt.id !== source.id ||
        previousReceipt.turn !== source.turn ||
        previousReceipt.patch !== patch ||
        (own(this.data.sources, source.id) &&
          this.data.sources[source.id].text !== source.text.slice(0, 512))
      )
        throw new Error("source replay differs from original patch");
      return { changed: 0, unchanged: 0, deferred: 0, replayed: true };
    }
    if (source.turn <= this.data.lastTurn)
      throw new Error("source turns must increase");
    const next = clone(this.data);
    let changed = 0,
      unchanged = 0,
      deferred = 0;
    const ref = { turn: source.turn, id: source.id };
    for (const delta of deltas) {
      const old = own(next.current, delta.field)
        ? next.current[delta.field]
        : undefined;
      const verified =
        delta.op === "set" &&
        own(confirmations, delta.field) &&
        confirmations[delta.field] === delta.value;
      if (delta.op === "set" && old?.value === delta.value && !verified) {
        unchanged++;
        continue;
      }
      const contradictory =
        delta.op !== "clear" &&
        old &&
        old.status !== "cleared" &&
        (old.status === "conflicting" || old.value !== delta.value);
      let cell: MemoryCell | undefined;
      let reason: ChangeEvent["reason"] = delta.op;
      if (
        delta.op === "set" &&
        delta.basis === "inferred" &&
        delta.confidence < next.policy.inferredMinConfidence &&
        !contradictory
      ) {
        deferred++;
        reason = "deferred";
      } else if (delta.op === "clear") {
        cell = {
          status: "cleared",
          confidence: delta.confidence,
          revision: 0,
          source: ref,
        };
      } else {
        const isConflict =
          delta.op === "conflict" ||
          (delta.basis === "inferred" &&
            old &&
            old.status !== "cleared" &&
            (old.status === "conflicting" || old.value !== delta.value));
        if (isConflict) {
          const candidates = [
            ...new Set([
              ...(old?.candidates ?? []),
              ...(old?.value !== undefined ? [old.value] : []),
              delta.value,
            ]),
          ];
          cell = {
            status: "conflicting",
            candidates,
            confidence: delta.confidence,
            revision: 0,
            source: ref,
          };
          reason = "conflict";
        } else {
          cell = {
            status:
              verified ||
              (old?.status === "confirmed" && old.value === delta.value)
                ? "confirmed"
                : "uncertain",
            value: delta.value,
            confidence: delta.confidence,
            revision: 0,
            source: ref,
          };
        }
      }
      if (reason !== "deferred" && same(semantic(old), semantic(cell))) {
        unchanged++;
        continue;
      }
      const id = next.history.length + 1;
      if (next.history.length >= next.maxHistory)
        throw new Error(
          "history limit reached; persist the snapshot and explicitly raise maxHistory before accepting more changes",
        );
      if (cell) {
        cell.revision = id;
        next.current[delta.field] = cell;
        changed++;
      }
      next.history.push({
        id,
        field: delta.field,
        ...(old ? { before: clone(old) } : {}),
        ...(cell ? { after: clone(cell) } : {}),
        source: ref,
        reason,
        ...(reason === "deferred" ? { proposal: clone(delta) } : {}),
      });
      next.sources[source.id] = { ...source, text: source.text.slice(0, 512) };
    }
    next.lastTurn = source.turn;
    next.receipts.push({ turn: source.turn, id: source.id, patch });
    this.data = next;
    return { changed, unchanged, deferred, replayed: false };
  }
  retrieve(
    field: string,
    mode: "original" | "previous" | "changes",
    limit = 3,
  ) {
    if (
      !own(this.data.schema, field) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error("invalid historical retrieval");
    const events = this.data.history.filter(
      (e) => e.field === field && e.reason !== "deferred",
    );
    if (mode === "original" && !this.data.historyComplete) return [];
    let selected: ChangeEvent[];
    if (mode === "original")
      selected = events.filter((e) => e.after?.value !== undefined).slice(0, 1);
    else if (mode === "previous")
      selected = events
        .filter(
          (e) =>
            e.after?.value !== undefined &&
            e.after.value !== this.data.current[field]?.value,
        )
        .slice(-1);
    else selected = events.slice(-limit);
    return clone(
      selected.map((e) => ({
        event: e.id,
        status: e.after?.status,
        value: e.after?.value,
        candidates: e.after?.candidates,
        source: e.source,
        text: this.data.sources[e.source.id]?.text ?? "source unavailable",
      })),
    );
  }
  static restore(
    snapshot: MemorySnapshot | LongHorizonSnapshot | BeliefSnapshot,
    schemaForV1: FactSchema = {},
  ): FactMemory {
    if (!object(snapshot)) throw new Error("invalid memory snapshot");
    if (snapshot.version === 1) {
      const memory = new FactMemory(schemaForV1);
      validateBeliefs(snapshot.beliefs);
      memory.data.beliefs = clone(snapshot.beliefs);
      memory.data.historyComplete = false;
      return memory;
    }
    if (snapshot.version === 2) {
      validateBeliefs(snapshot.beliefs);
      if (!object(snapshot.facts)) throw new Error("invalid legacy facts");
      const memory = new FactMemory(snapshot.factSchema, {
        maxHistory: Math.max(256, Object.keys(snapshot.factSchema).length),
      });
      for (const [field, fact] of Object.entries(snapshot.facts).sort(
        ([, a], [, b]) => a.sourceTurn - b.sourceTurn,
      )) {
        if (
          !object(fact) ||
          !Number.isSafeInteger(fact.sourceTurn) ||
          fact.sourceTurn < 1 ||
          !["active", "cleared"].includes(fact.status) ||
          !Number.isFinite(fact.confidence) ||
          fact.confidence < 0 ||
          fact.confidence > 1
        )
          throw new Error("invalid legacy fact");
        if (fact.status === "active")
          validateFactValue(snapshot.factSchema, field, fact.value);
        if (
          !own(snapshot.factSchema, field) ||
          fact.type !==
            (typeof snapshot.factSchema[field] === "string"
              ? snapshot.factSchema[field]
              : snapshot.factSchema[field].type)
        )
          throw new Error("invalid legacy field type");
        const source = {
          turn: fact.sourceTurn,
          id: `legacy:${fact.sourceTurn}`,
        };
        const cell: MemoryCell = {
          status: fact.status === "cleared" ? "cleared" : "uncertain",
          confidence: fact.confidence,
          ...(fact.status === "active" ? { value: fact.value } : {}),
          revision: memory.data.history.length + 1,
          source,
        };
        memory.data.history.push({
          id: cell.revision,
          field,
          after: cell,
          source,
          reason: "migration",
        });
        memory.data.sources[source.id] = {
          ...source,
          text: "Migrated v2 fact; original evidence unavailable",
        };
        memory.data.current[field] = cell;
        memory.data.lastTurn = Math.max(memory.data.lastTurn, fact.sourceTurn);
      }
      memory.data.historyComplete = false;
      memory.data.beliefs = clone(snapshot.beliefs);
      return memory;
    }
    if (
      snapshot.version !== 3 ||
      !object(snapshot.current) ||
      !Array.isArray(snapshot.history) ||
      !object(snapshot.sources) ||
      !object(snapshot.policy) ||
      typeof snapshot.policy.inferredMinConfidence !== "number" ||
      !Number.isSafeInteger(snapshot.maxHistory) ||
      snapshot.maxHistory < 1 ||
      !Array.isArray(snapshot.receipts) ||
      !Number.isSafeInteger(snapshot.lastTurn) ||
      snapshot.lastTurn < 0 ||
      typeof snapshot.historyComplete !== "boolean"
    )
      throw new Error("invalid v3 snapshot");
    const memory = new FactMemory(snapshot.schema, {
      policy: snapshot.policy,
      maxHistory: snapshot.maxHistory,
    });
    validateBeliefs(snapshot.beliefs);
    const reconstructed: Record<string, MemoryCell> = {};
    let lastEventTurn = 0;
    for (const [i, event] of snapshot.history.entries()) {
      if (
        event.id !== i + 1 ||
        !own(snapshot.schema, event.field) ||
        !same(event.before, reconstructed[event.field]) ||
        !["set", "clear", "conflict", "deferred", "migration"].includes(
          event.reason,
        )
      )
        throw new Error("invalid history chain");
      const source = snapshot.sources[event.source.id];
      validateSource(source);
      if (
        source.id !== event.source.id ||
        source.turn !== event.source.turn ||
        source.turn > snapshot.lastTurn ||
        source.turn < lastEventTurn
      )
        throw new Error("invalid history source");
      lastEventTurn = source.turn;
      if (event.reason === "deferred") {
        validateDeltas(snapshot.schema, [event.proposal]);
        if (event.proposal!.field !== event.field)
          throw new Error("invalid deferred proposal");
      } else if (event.proposal !== undefined)
        throw new Error("unexpected proposal");
      if (event.after) {
        if (event.reason === "deferred")
          throw new Error("deferred event must not change state");
        const cell = event.after;
        if (
          !same(cell.source, event.source) ||
          cell.revision !== event.id ||
          !Number.isFinite(cell.confidence) ||
          cell.confidence < 0 ||
          cell.confidence > 1 ||
          !["confirmed", "uncertain", "conflicting", "cleared"].includes(
            cell.status,
          )
        )
          throw new Error("invalid memory cell");
        if (cell.status === "confirmed" || cell.status === "uncertain")
          validateFactValue(snapshot.schema, event.field, cell.value);
        if (cell.status === "conflicting") {
          if (
            !Array.isArray(cell.candidates) ||
            !cell.candidates.length ||
            cell.value !== undefined
          )
            throw new Error("invalid conflict candidates");
          cell.candidates.forEach((v) =>
            validateFactValue(snapshot.schema, event.field, v),
          );
        }
        if (cell.status !== "conflicting" && cell.candidates !== undefined)
          throw new Error("unexpected candidates");
        if (cell.status === "cleared" && cell.value !== undefined)
          throw new Error("cleared fact has value");
        if (
          (event.reason === "clear" && cell.status !== "cleared") ||
          (event.reason === "conflict" && cell.status !== "conflicting") ||
          (event.reason === "set" &&
            !["confirmed", "uncertain"].includes(cell.status)) ||
          (event.reason === "migration" &&
            (snapshot.historyComplete ||
              !["uncertain", "cleared"].includes(cell.status)))
        )
          throw new Error("event reason disagrees with state");
        reconstructed[event.field] = clone(cell);
      } else if (event.reason !== "deferred")
        throw new Error("event has no resulting cell");
    }
    if (
      !same(reconstructed, snapshot.current) ||
      snapshot.history.length > snapshot.maxHistory
    )
      throw new Error("snapshot current state disagrees with history");
    const turns = new Set<number>(),
      ids = new Set<string>();
    for (const receipt of snapshot.receipts) {
      validateSource({ turn: receipt.turn, id: receipt.id, text: "" });
      if (
        !Number.isSafeInteger(receipt.turn) ||
        receipt.turn < 1 ||
        receipt.turn > snapshot.lastTurn ||
        turns.has(receipt.turn) ||
        ids.has(receipt.id) ||
        typeof receipt.patch !== "string"
      )
        throw new Error("invalid receipts");
      turns.add(receipt.turn);
      ids.add(receipt.id);
    }
    for (const event of snapshot.history) {
      if (
        event.reason !== "migration" &&
        !snapshot.receipts.some(
          (r) => r.id === event.source.id && r.turn === event.source.turn,
        )
      )
        throw new Error("history event has no replay receipt");
    }
    memory.data = clone(snapshot);
    return memory;
  }
}

function validateBeliefs(beliefs: BeliefSnapshot["beliefs"]): void {
  if (!object(beliefs)) throw new Error("invalid snapshot beliefs");
  for (const belief of Object.values(beliefs)) {
    if (
      !object(belief) ||
      !["multi", "exclusive"].includes(belief.cardinality) ||
      !["open", "closed"].includes(belief.domain) ||
      !object(belief.values) ||
      Object.values(belief.values).some(
        (v) => typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1,
      )
    )
      throw new Error("invalid snapshot beliefs");
  }
}
