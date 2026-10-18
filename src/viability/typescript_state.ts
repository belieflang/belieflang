import type { FactSchema } from "../runtime.js";
import type {
  FactDelta,
  FactSource,
  FactValue,
  MemoryCell,
  ChangeEvent,
} from "../fact_memory.js";

export type TypedDelta<T extends object> = {
  [K in keyof T & string]:
    | {
        field: K;
        op: "set" | "conflict";
        value: T[K];
        confidence: number;
        basis: "explicit" | "inferred";
      }
    | { field: K; op: "clear"; confidence: number; basis: "explicit" };
}[keyof T & string];
type Input = {
  patch: FactDelta[];
  source: FactSource;
  verified: Record<string, FactValue>;
};
type Snapshot = {
  version: 1;
  schema: FactSchema;
  inputs: Input[];
  minConfidence: number;
  maxHistory: number;
};
const copy = <T>(value: T): T => structuredClone(value);
const isObject = (value: unknown): value is Record<string, any> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
function exactKeys(value: object, keys: string[]) {
  if (!equal(Object.keys(value).sort(), [...keys].sort()))
    throw new Error("unexpected or missing properties");
}
/** Equivalent runtime validation, independently implemented; imports above are type-only. */
export class TypeScriptState<T extends object = Record<string, FactValue>> {
  private cells: Record<string, MemoryCell> = {};
  private events: ChangeEvent[] = [];
  private inputs: Input[] = [];
  private readonly schema: FactSchema;
  readonly minConfidence: number;
  readonly maxHistory: number;
  constructor(
    schema: FactSchema,
    options: { minConfidence?: number; maxHistory?: number } = {},
  ) {
    if (!isObject(schema)) throw new Error("invalid schema");
    for (const [field, declaration] of Object.entries(schema)) {
      const type =
        typeof declaration === "string" ? declaration : declaration?.type;
      if (
        !/^[a-z][a-z0-9_]*$/.test(field) ||
        ["constructor", "prototype"].includes(field) ||
        !["number", "boolean", "string"].includes(type)
      )
        throw new Error("invalid schema field");
      if (
        typeof declaration !== "string" &&
        declaration.enum !== undefined &&
        (type !== "string" ||
          !Array.isArray(declaration.enum) ||
          !declaration.enum.length ||
          new Set(declaration.enum).size !== declaration.enum.length ||
          declaration.enum.some((v) => typeof v !== "string"))
      )
        throw new Error("invalid enum");
    }
    this.schema = copy(schema);
    this.minConfidence = options.minConfidence ?? 0;
    this.maxHistory = options.maxHistory ?? 256;
    if (
      !Number.isFinite(this.minConfidence) ||
      this.minConfidence < 0 ||
      this.minConfidence > 1 ||
      !Number.isSafeInteger(this.maxHistory) ||
      this.maxHistory < 1
    )
      throw new Error("invalid policy");
  }
  private validateValue(
    field: string,
    value: unknown,
  ): asserts value is FactValue {
    if (!Object.hasOwn(this.schema, field)) throw new Error("unknown field");
    const declaration = this.schema[field],
      type = typeof declaration === "string" ? declaration : declaration.type;
    if (
      typeof value !== type ||
      (typeof value === "number" && !Number.isFinite(value)) ||
      (typeof declaration !== "string" &&
        declaration.enum &&
        !declaration.enum.includes(value as string))
    )
      throw new Error("invalid typed value");
  }
  get current() {
    return copy(this.cells);
  }
  get<K extends keyof T & string>(
    field: K,
  ): (Omit<MemoryCell, "value"> & { value?: T[K] }) | undefined {
    return copy(this.cells[field]) as
      | (Omit<MemoryCell, "value"> & { value?: T[K] })
      | undefined;
  }
  applyTyped(
    patch: TypedDelta<T>[],
    source: FactSource,
    verified: Partial<T> = {},
  ) {
    return this.applyExtracted(patch, source, verified);
  }
  applyExtracted(
    input: unknown,
    source: FactSource,
    verification: unknown = {},
  ) {
    if (!Array.isArray(input) || !isObject(source) || !isObject(verification))
      throw new Error("invalid update");
    exactKeys(source, ["turn", "id", "text"]);
    if (
      !Number.isSafeInteger(source.turn) ||
      source.turn < 1 ||
      typeof source.id !== "string" ||
      !/^[A-Za-z0-9:_-]{1,128}$/.test(source.id) ||
      source.id === "__proto__" ||
      typeof source.text !== "string"
    )
      throw new Error("invalid source");
    const fields = new Set<string>();
    for (const delta of input) {
      if (!isObject(delta)) throw new Error("invalid delta");
      exactKeys(
        delta,
        delta.op === "clear"
          ? ["field", "op", "confidence", "basis"]
          : ["field", "op", "value", "confidence", "basis"],
      );
      if (
        typeof delta.field !== "string" ||
        !Object.hasOwn(this.schema, delta.field) ||
        fields.has(delta.field) ||
        !["set", "clear", "conflict"].includes(delta.op) ||
        !["explicit", "inferred"].includes(delta.basis) ||
        !Number.isFinite(delta.confidence) ||
        delta.confidence < 0 ||
        delta.confidence > 1
      )
        throw new Error("invalid delta");
      if (delta.op === "clear") {
        if (delta.basis !== "explicit") throw new Error("implicit clear");
      } else this.validateValue(delta.field, delta.value);
      fields.add(delta.field);
    }
    for (const [field, value] of Object.entries(verification))
      this.validateValue(field, value);
    const patch = input as FactDelta[],
      verified = verification as Record<string, FactValue>;
    const entry: Input = {
      patch: copy(
        [...patch].sort((a, b) =>
          a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
        ),
      ),
      source: { ...source, text: source.text.slice(0, 512) },
      verified: copy(verified),
    };
    const previous = this.inputs.find(
      (x) => x.source.id === source.id || x.source.turn === source.turn,
    );
    if (previous) {
      if (
        !equal(
          {
            ...previous,
            patch: [...previous.patch].sort((a, b) =>
              a.field < b.field ? -1 : a.field > b.field ? 1 : 0,
            ),
          },
          entry,
        )
      )
        throw new Error("inconsistent replay");
      return { changed: 0, unchanged: 0, deferred: 0, replayed: true };
    }
    if (source.turn <= (this.inputs.at(-1)?.source.turn ?? 0))
      throw new Error("nonmonotonic source");
    const cells = copy(this.cells),
      events = copy(this.events),
      ref = { turn: source.turn, id: source.id };
    let changed = 0,
      unchanged = 0,
      deferred = 0;
    // Iterate original patch order: a deterministic batch's event IDs reflect its declared order.
    for (const delta of patch) {
      const old = cells[delta.field],
        independentlyVerified =
          delta.op === "set" &&
          Object.hasOwn(verified, delta.field) &&
          verified[delta.field] === delta.value;
      if (
        delta.op === "set" &&
        old?.value === delta.value &&
        !independentlyVerified
      ) {
        unchanged++;
        continue;
      }
      const contradiction =
        delta.op !== "clear" &&
        old &&
        old.status !== "cleared" &&
        (old.status === "conflicting" || old.value !== delta.value);
      let cell: MemoryCell | undefined,
        reason: ChangeEvent["reason"] = delta.op;
      if (
        delta.op === "set" &&
        delta.basis === "inferred" &&
        delta.confidence < this.minConfidence &&
        !contradiction
      ) {
        reason = "deferred";
        deferred++;
      } else if (delta.op === "clear")
        cell = {
          status: "cleared",
          confidence: delta.confidence,
          revision: 0,
          source: ref,
        };
      else if (
        delta.op === "conflict" ||
        (delta.basis === "inferred" && contradiction)
      ) {
        cell = {
          status: "conflicting",
          candidates: [
            ...new Set([
              ...(old?.candidates ?? []),
              ...(old?.value !== undefined ? [old.value] : []),
              delta.value,
            ]),
          ],
          confidence: delta.confidence,
          revision: 0,
          source: ref,
        };
        reason = "conflict";
      } else
        cell = {
          status:
            independentlyVerified ||
            (old?.status === "confirmed" && old.value === delta.value)
              ? "confirmed"
              : "uncertain",
          value: delta.value,
          confidence: delta.confidence,
          revision: 0,
          source: ref,
        };
      const meaning = (c?: MemoryCell) =>
        c && [c.status, c.value, c.candidates];
      if (reason !== "deferred" && equal(meaning(old), meaning(cell))) {
        unchanged++;
        continue;
      }
      if (events.length >= this.maxHistory) throw new Error("history limit");
      const id = events.length + 1;
      if (cell) {
        cell.revision = id;
        cells[delta.field] = cell;
        changed++;
      }
      events.push({
        id,
        field: delta.field,
        ...(old ? { before: copy(old) } : {}),
        ...(cell ? { after: copy(cell) } : {}),
        source: ref,
        reason,
        ...(reason === "deferred" ? { proposal: copy(delta) } : {}),
      });
    }
    // Commit only after all validation and capacity checks. Caller-owned input is never retained.
    this.cells = cells;
    this.events = events;
    this.inputs.push({ ...entry, patch: copy(patch) });
    return { changed, unchanged, deferred, replayed: false };
  }
  retrieve(
    field: string,
    mode: "original" | "previous" | "changes",
    limit = 3,
  ) {
    if (
      !Object.hasOwn(this.schema, field) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20
    )
      throw new Error("invalid retrieval");
    const entries = this.events.filter(
      (e) => e.field === field && e.reason !== "deferred",
    );
    const selected =
      mode === "original"
        ? entries.filter((e) => e.after?.value !== undefined).slice(0, 1)
        : mode === "previous"
          ? entries
              .filter(
                (e) =>
                  e.after?.value !== undefined &&
                  e.after.value !== this.cells[field]?.value,
              )
              .slice(-1)
          : entries.slice(-limit);
    return copy(
      selected.map((e) => ({
        event: e.id,
        value: e.after?.value,
        status: e.after?.status,
        candidates: e.after?.candidates,
        source: e.source,
        text: this.inputs.find((x) => x.source.id === e.source.id)!.source.text,
      })),
    );
  }
  context() {
    return Object.fromEntries(
      Object.entries(this.cells).map(([field, cell]) => [
        field,
        {
          status: cell.status,
          ...(cell.value !== undefined ? { value: cell.value } : {}),
          ...(cell.candidates ? { candidates: copy(cell.candidates) } : {}),
        },
      ]),
    );
  }
  snapshot(): Snapshot {
    return copy({
      version: 1,
      schema: this.schema,
      inputs: this.inputs,
      minConfidence: this.minConfidence,
      maxHistory: this.maxHistory,
    });
  }
  static restore<T extends object>(snapshot: unknown): TypeScriptState<T> {
    if (!isObject(snapshot)) throw new Error("invalid snapshot");
    exactKeys(snapshot, [
      "version",
      "schema",
      "inputs",
      "minConfidence",
      "maxHistory",
    ]);
    if (
      snapshot.version !== 1 ||
      !Array.isArray(snapshot.inputs) ||
      typeof snapshot.minConfidence !== "number" ||
      typeof snapshot.maxHistory !== "number"
    )
      throw new Error("invalid snapshot version/policy");
    const store = new TypeScriptState<T>(snapshot.schema, {
      minConfidence: snapshot.minConfidence,
      maxHistory: snapshot.maxHistory,
    });
    for (const entry of snapshot.inputs) {
      if (!isObject(entry)) throw new Error("invalid input journal");
      exactKeys(entry, ["patch", "source", "verified"]);
      store.applyExtracted(entry.patch, entry.source, entry.verified);
    }
    if (store.inputs.length !== snapshot.inputs.length)
      throw new Error("duplicate journal entry");
    return store;
  }
}
