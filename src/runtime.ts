import type {
  Action,
  BeliefBlock,
  BeliefCardinality,
  BeliefDistribution,
  BeliefDomain,
  BeliefState,
  ConditionExpression,
  InferStatement,
  MergeBeliefsStatement,
  ObserveStatement,
  Operator,
  RuntimeValue,
  Rule,
  Statement,
  ValueExpression,
} from "./ast.js";

export type Tool = () => RuntimeValue | Promise<RuntimeValue>;
export type ToolRegistry = Record<string, Tool>;

export type BeliefPatchEntry = {
  values: BeliefDistribution;
  cardinality?: BeliefCardinality;
  domain?: BeliefDomain;
};

export type BeliefPatch = Record<string, BeliefPatchEntry | BeliefDistribution>;

export type ObservationRecord = {
  id: number;
  eventName: string;
  value: RuntimeValue;
  timestamp: number;
};

export type ProvenanceOrigin = "load" | "merge" | "infer";

export type ProvenanceRecord = {
  id: number;
  timestamp: number;
  beliefName: string;
  label: string;
  value: number;
  cardinality: BeliefCardinality;
  domain: BeliefDomain;
  source: string;
  origin: ProvenanceOrigin;
};

export type InferContext = {
  observations: ObservationRecord[];
  state: BeliefState;
  vars: Record<string, RuntimeValue>;
};

export type InferBeliefsAdapter = (
  source: RuntimeValue,
  context: InferContext,
) => BeliefPatch | Promise<BeliefPatch>;

export type RuntimeOptions = {
  trace?: boolean;
  inferBeliefs?: InferBeliefsAdapter;
  now?: () => number;
};

type BeliefMeta = {
  cardinality: BeliefCardinality;
  domain: BeliefDomain;
  openMass: number;
};

const EPSILON = 1e-9;

export class BeliefRuntime {
  private state: BeliefState = {};
  private vars: Record<string, RuntimeValue> = {};
  private beliefMeta: Record<string, BeliefMeta> = {};
  private observations: ObservationRecord[] = [];
  private provenance: ProvenanceRecord[] = [];
  private tools: ToolRegistry;
  private trace: boolean;
  private inferBeliefs: InferBeliefsAdapter;
  private now: () => number;
  private nextObservationId = 1;
  private nextProvenanceId = 1;

  constructor(tools: ToolRegistry = {}, options: RuntimeOptions = {}) {
    this.trace = options.trace ?? false;
    this.now = options.now ?? (() => Date.now());
    this.inferBeliefs = options.inferBeliefs ?? this.defaultInferBeliefs;

    this.tools = {
      search_flights: () => ({ count: 3, best_price: 214, currency: "EUR" }),
      search_hotels: () => ({ count: 5, best_price: 88, currency: "EUR" }),
      extract_patch: () => ({
        intent: {
          cardinality: "exclusive",
          domain: "closed",
          values: {
            book_flight: 0.92,
            book_hotel: 0.08,
          },
        },
        user: {
          cardinality: "multi",
          domain: "closed",
          values: {
            budget_sensitive: 0.86,
            prefers_direct: 0.88,
          },
        },
      }),
      rank_flights: () => {
        console.log("[tool] rank_flights()");
        return null;
      },
      ...tools,
    };
  }

  getState(): BeliefState {
    return structuredClone(this.state);
  }

  getVars(): Record<string, RuntimeValue> {
    return structuredClone(this.vars);
  }

  getObservations(): ObservationRecord[] {
    return structuredClone(this.observations);
  }

  getProvenance(): ProvenanceRecord[] {
    return structuredClone(this.provenance);
  }

  explainBelief(path: string): ProvenanceRecord[] {
    const [beliefName, label, ...rest] = path.split(".");
    if (!beliefName || rest.length > 0) {
      throw new Error(`explainBelief() expects belief or belief.label, got ${path}`);
    }

    return this.provenance.filter((record) => {
      if (record.beliefName !== beliefName) return false;
      if (!label) return true;
      return record.label === label;
    });
  }

  loadBelief(block: BeliefBlock): void {
    this.setBelief(
      block.name,
      block.values,
      block.cardinality,
      block.domain,
      {
        origin: "load",
        source: `belief ${block.name}`,
      },
      { clampMulti: false },
    );
  }

  async assign(name: string, expression: ValueExpression): Promise<void> {
    this.vars[name] = await this.evalValue(expression);
  }

  async observe(eventName: string, value?: ValueExpression): Promise<void> {
    await this.executeObserve({
      kind: "observe",
      eventName,
      value,
    });
  }

  async infer(source: ValueExpression): Promise<void> {
    await this.executeInfer({
      kind: "infer",
      source,
    });
  }

  mergeBeliefsFromRuntimeValue(
    value: RuntimeValue,
    provenance: { origin: ProvenanceOrigin; source: string },
  ): void {
    const patch = this.asBeliefPatch(value);
    this.mergeBeliefPatch(patch, provenance);
  }

  async evalValue(expression: ValueExpression): Promise<RuntimeValue> {
    switch (expression.kind) {
      case "number":
      case "string":
      case "boolean":
        return expression.value;
      case "identifier":
        return this.resolvePath(expression.name);
      case "metric":
        return expression.fn === "confidence"
          ? this.confidence(expression.arg)
          : this.entropy(expression.arg);
      case "call_expr":
        return await this.callTool(expression.toolName);
    }
  }

  resolvePath(path: string): RuntimeValue {
    const [root, ...parts] = path.split(".");
    let value: RuntimeValue | undefined = this.vars[root];

    if (value === undefined && this.state[root]) {
      value = this.state[root] as unknown as RuntimeValue;
    }

    if (value === undefined) {
      throw new Error(`unknown reference ${path}`);
    }

    for (const part of parts) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`cannot access ${part} on non-object reference ${path}`);
      }

      const objectValue = value as { [key: string]: RuntimeValue };
      value = objectValue[part];

      if (value === undefined) {
        throw new Error(`unknown property ${part} in reference ${path}`);
      }
    }

    return value;
  }

  confidence(path: string): number {
    const [beliefName, key, ...rest] = path.split(".");

    if (!beliefName || !key || rest.length > 0) {
      throw new Error(`confidence() expects name.key, got ${path}`);
    }

    const belief = this.state[beliefName];
    if (!belief) return 0;

    if (belief[key] !== undefined) {
      return belief[key];
    }

    const meta = this.beliefMeta[beliefName];
    if (
      meta &&
      meta.cardinality === "exclusive" &&
      meta.domain === "open" &&
      key === "other"
    ) {
      return meta.openMass;
    }

    return 0;
  }

  entropy(beliefName: string): number {
    const belief = this.state[beliefName];
    const meta = this.beliefMeta[beliefName];

    if (!belief || !meta) {
      throw new Error(`unknown belief ${beliefName}`);
    }

    if (meta.cardinality === "exclusive") {
      const probs = Object.values(belief).filter((p) => p > 0);

      if (meta.domain === "open" && meta.openMass > 0) {
        probs.push(meta.openMass);
      }

      if (probs.length <= 1) return 0;

      const raw = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
      const maxEntropy = Math.log2(probs.length);
      return raw / maxEntropy;
    }

    const probs = Object.values(belief);
    if (probs.length === 0) return 0;

    const averageBinaryEntropy =
      probs.reduce((sum, p) => sum + this.binaryEntropy(p), 0) / probs.length;

    return averageBinaryEntropy;
  }

  private binaryEntropy(probability: number): number {
    if (probability <= 0 || probability >= 1) return 0;

    return (
      -probability * Math.log2(probability) -
      (1 - probability) * Math.log2(1 - probability)
    );
  }

  private compareValues(left: RuntimeValue, op: Operator, right: RuntimeValue): boolean {
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;

    const leftNumber = Number(left);
    const rightNumber = Number(right);

    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      throw new Error(`Operator ${op} requires numeric operands`);
    }

    switch (op) {
      case ">":
        return leftNumber > rightNumber;
      case ">=":
        return leftNumber >= rightNumber;
      case "<":
        return leftNumber < rightNumber;
      case "<=":
        return leftNumber <= rightNumber;
      default:
        throw new Error(`Unsupported operator ${op}`);
    }
  }

  private async evalConditionExpression(
    expression: ConditionExpression,
    traceLines: string[],
  ): Promise<boolean> {
    switch (expression.kind) {
      case "comparison": {
        const left = await this.evalValue(expression.left);
        const right = await this.evalValue(expression.right);
        const result = this.compareValues(left, expression.op, right);

        traceLines.push(
          `${this.describeValueExpression(expression.left)}=${this.formatValue(left)} ${expression.op} ${this.describeValueExpression(expression.right)}=${this.formatValue(right)} -> ${result}`,
        );

        return result;
      }
      case "truthy": {
        const value = await this.evalValue(expression.expr);
        const result = this.toBoolean(value);
        traceLines.push(
          `${this.describeValueExpression(expression.expr)}=${this.formatValue(value)} -> ${result}`,
        );
        return result;
      }
      case "not": {
        const result = !(await this.evalConditionExpression(expression.expr, traceLines));
        traceLines.push(`not -> ${result}`);
        return result;
      }
      case "and": {
        const left = await this.evalConditionExpression(expression.left, traceLines);
        if (!left) {
          traceLines.push("and short-circuit -> false");
          return false;
        }

        const right = await this.evalConditionExpression(expression.right, traceLines);
        const result = left && right;
        traceLines.push(`and -> ${result}`);
        return result;
      }
      case "or": {
        const left = await this.evalConditionExpression(expression.left, traceLines);
        if (left) {
          traceLines.push("or short-circuit -> true");
          return true;
        }

        const right = await this.evalConditionExpression(expression.right, traceLines);
        const result = left || right;
        traceLines.push(`or -> ${result}`);
        return result;
      }
    }
  }

  private toBoolean(value: RuntimeValue): boolean {
    if (value === null) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return Object.keys(value).length > 0;
  }

  private describeValueExpression(expression: ValueExpression): string {
    switch (expression.kind) {
      case "number":
        return String(expression.value);
      case "string":
        return JSON.stringify(expression.value);
      case "boolean":
        return String(expression.value);
      case "identifier":
        return expression.name;
      case "metric":
        return `${expression.fn}(${expression.arg})`;
      case "call_expr":
        return `call ${expression.toolName}()`;
    }
  }

  private describeCondition(expression: ConditionExpression): string {
    switch (expression.kind) {
      case "comparison":
        return `${this.describeValueExpression(expression.left)} ${expression.op} ${this.describeValueExpression(expression.right)}`;
      case "truthy":
        return this.describeValueExpression(expression.expr);
      case "not":
        return `!(${this.describeCondition(expression.expr)})`;
      case "and":
        return `(${this.describeCondition(expression.left)} && ${this.describeCondition(expression.right)})`;
      case "or":
        return `(${this.describeCondition(expression.left)} || ${this.describeCondition(expression.right)})`;
    }
  }

  private describeAction(action: Action): string {
    if (action.kind === "call") {
      return `call ${action.toolName}()`;
    }

    if (action.kind === "ask_user") {
      return `ask_user(${JSON.stringify(action.message)})`;
    }

    return `let ${action.variableName} = call ${action.toolName}()`;
  }

  private formatValue(value: RuntimeValue): string {
    if (typeof value === "number") {
      return Number.isInteger(value) ? String(value) : value.toFixed(3);
    }

    if (typeof value === "string") {
      return JSON.stringify(value);
    }

    if (typeof value === "boolean" || value === null) {
      return String(value);
    }

    return JSON.stringify(value);
  }

  private logTrace(message: string): void {
    if (this.trace) {
      console.log(`[trace] ${message}`);
    }
  }

  private setBelief(
    beliefName: string,
    values: BeliefDistribution,
    cardinality: BeliefCardinality,
    domain: BeliefDomain,
    provenance: { origin: ProvenanceOrigin; source: string },
    options: { clampMulti: boolean },
  ): void {
    const normalized = this.normalizeBelief(
      beliefName,
      values,
      cardinality,
      domain,
      options,
    );

    this.state[beliefName] = normalized.values;
    this.beliefMeta[beliefName] = {
      cardinality,
      domain,
      openMass: normalized.openMass,
    };

    this.recordProvenance(beliefName, this.state[beliefName], this.beliefMeta[beliefName], {
      origin: provenance.origin,
      source: provenance.source,
    });
  }

  private normalizeBelief(
    beliefName: string,
    values: BeliefDistribution,
    cardinality: BeliefCardinality,
    domain: BeliefDomain,
    options: { clampMulti: boolean },
  ): { values: BeliefDistribution; openMass: number } {
    const entries = Object.entries(values);
    if (entries.length === 0) {
      throw new Error(`belief ${beliefName} has no values`);
    }

    if (cardinality === "multi") {
      const normalizedEntries: Array<[string, number]> = [];

      for (const [label, rawValue] of entries) {
        if (!Number.isFinite(rawValue)) {
          throw new Error(`belief ${beliefName}.${label} must be finite`);
        }

        let value = rawValue;
        if (options.clampMulti) {
          value = Math.max(0, Math.min(1, rawValue));
          if (Math.abs(value - rawValue) > EPSILON) {
            this.logTrace(
              `clamped ${beliefName}.${label} from ${rawValue.toFixed(3)} to ${value.toFixed(3)}`,
            );
          }
        } else if (value < 0 || value > 1 + EPSILON) {
          throw new Error(
            `belief ${beliefName}.${label} must be in [0, 1] for multi beliefs`,
          );
        }

        normalizedEntries.push([label, value]);
      }

      return {
        values: Object.fromEntries(normalizedEntries),
        openMass: 0,
      };
    }

    for (const [label, value] of entries) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`belief ${beliefName}.${label} must be a non-negative number`);
      }
    }

    const total = entries.reduce((sum, [, value]) => sum + value, 0);
    if (total <= 0) {
      throw new Error(`belief ${beliefName} has non-positive probability mass`);
    }

    if (domain === "closed") {
      return {
        values: Object.fromEntries(entries.map(([label, value]) => [label, value / total])),
        openMass: 0,
      };
    }

    if (total > 1 + EPSILON) {
      throw new Error(
        `belief ${beliefName} is open+exclusive and cannot exceed total mass 1.0`,
      );
    }

    return {
      values: Object.fromEntries(entries),
      openMass: Math.max(0, 1 - total),
    };
  }

  private recordProvenance(
    beliefName: string,
    values: BeliefDistribution,
    meta: BeliefMeta,
    source: { origin: ProvenanceOrigin; source: string },
  ): void {
    const timestamp = this.now();

    for (const [label, value] of Object.entries(values)) {
      this.provenance.push({
        id: this.nextProvenanceId,
        timestamp,
        beliefName,
        label,
        value,
        cardinality: meta.cardinality,
        domain: meta.domain,
        source: source.source,
        origin: source.origin,
      });

      this.nextProvenanceId += 1;
    }

    if (meta.cardinality === "exclusive" && meta.domain === "open") {
      this.provenance.push({
        id: this.nextProvenanceId,
        timestamp,
        beliefName,
        label: "other",
        value: meta.openMass,
        cardinality: meta.cardinality,
        domain: meta.domain,
        source: source.source,
        origin: source.origin,
      });

      this.nextProvenanceId += 1;
    }
  }

  private defaultInferBeliefs(source: RuntimeValue): BeliefPatch {
    if (typeof source !== "string") {
      return {};
    }

    const text = source.toLowerCase();
    const intentValues: BeliefDistribution = {};

    if (text.includes("flight")) {
      intentValues.book_flight = 0.85;
    }

    if (text.includes("hotel")) {
      intentValues.book_hotel = 0.85;
    }

    if (Object.keys(intentValues).length === 0) {
      intentValues.unknown = 1;
    }

    const patch: BeliefPatch = {
      intent: {
        cardinality: "exclusive",
        domain: "closed",
        values: intentValues,
      },
    };

    const userValues: BeliefDistribution = {};
    if (text.includes("cheap")) {
      userValues.budget_sensitive = 0.9;
    }

    if (text.includes("direct")) {
      userValues.prefers_direct = 0.85;
    }

    if (Object.keys(userValues).length > 0) {
      patch.user = {
        cardinality: "multi",
        domain: "closed",
        values: userValues,
      };
    }

    return patch;
  }

  private coercePatchEntry(
    beliefName: string,
    entry: BeliefPatchEntry | BeliefDistribution,
  ): BeliefPatchEntry {
    const raw = entry as Record<string, unknown>;

    if (
      Object.prototype.hasOwnProperty.call(raw, "values") &&
      typeof raw.values === "object" &&
      raw.values !== null &&
      !Array.isArray(raw.values)
    ) {
      const values = this.asBeliefDistribution(raw.values as Record<string, RuntimeValue>, beliefName);

      const cardinalityRaw = raw.cardinality;
      if (
        cardinalityRaw !== undefined &&
        cardinalityRaw !== "exclusive" &&
        cardinalityRaw !== "multi"
      ) {
        throw new Error(
          `invalid cardinality '${String(cardinalityRaw)}' for belief ${beliefName}`,
        );
      }

      const domainRaw = raw.domain;
      if (domainRaw !== undefined && domainRaw !== "open" && domainRaw !== "closed") {
        throw new Error(`invalid domain '${String(domainRaw)}' for belief ${beliefName}`);
      }

      return {
        values,
        cardinality: cardinalityRaw,
        domain: domainRaw,
      };
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`belief patch for ${beliefName} must be an object`);
    }

    return {
      values: this.asBeliefDistribution(raw as Record<string, RuntimeValue>, beliefName),
    };
  }

  private asBeliefDistribution(
    source: Record<string, RuntimeValue>,
    beliefName: string,
  ): BeliefDistribution {
    const entries = Object.entries(source);
    if (entries.length === 0) {
      throw new Error(`belief patch for ${beliefName} has no values`);
    }

    const values: BeliefDistribution = {};

    for (const [label, rawValue] of entries) {
      if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        throw new Error(
          `belief patch ${beliefName}.${label} must be a finite number`,
        );
      }

      values[label] = rawValue;
    }

    return values;
  }

  private asBeliefPatch(value: RuntimeValue): BeliefPatch {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("merge/infer source must evaluate to an object");
    }

    const patch: BeliefPatch = {};

    for (const [beliefName, rawEntry] of Object.entries(
      value as Record<string, RuntimeValue>,
    )) {
      if (rawEntry === null || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
        throw new Error(`belief patch entry '${beliefName}' must be an object`);
      }

      patch[beliefName] = this.coercePatchEntry(
        beliefName,
        rawEntry as unknown as BeliefPatchEntry | BeliefDistribution,
      );
    }

    return patch;
  }

  private mergeBeliefPatch(
    patch: BeliefPatch,
    provenance: { origin: ProvenanceOrigin; source: string },
  ): void {
    for (const [beliefName, patchEntry] of Object.entries(patch)) {
      const entry = this.coercePatchEntry(beliefName, patchEntry);
      const currentMeta = this.beliefMeta[beliefName] ?? {
        cardinality: "exclusive" as const,
        domain: "closed" as const,
        openMass: 0,
      };

      const cardinality = entry.cardinality ?? currentMeta.cardinality;
      const domain = entry.domain ?? currentMeta.domain;
      const mergedValues = {
        ...(this.state[beliefName] ?? {}),
        ...entry.values,
      };

      this.setBelief(beliefName, mergedValues, cardinality, domain, provenance, {
        clampMulti: true,
      });
    }
  }

  private async executeObserve(statement: ObserveStatement): Promise<void> {
    const observedValue = statement.value ? await this.evalValue(statement.value) : null;
    const observation: ObservationRecord = {
      id: this.nextObservationId,
      eventName: statement.eventName,
      value: observedValue,
      timestamp: this.now(),
    };

    this.nextObservationId += 1;

    this.observations.push(observation);

    if (statement.value) {
      this.vars[statement.eventName] = observedValue;
    }

    this.logTrace(
      `observe ${statement.eventName}=${this.formatValue(observedValue)}`,
    );
  }

  private async executeInfer(statement: InferStatement): Promise<void> {
    const sourceValue = await this.evalValue(statement.source);
    const patch = await this.inferBeliefs(sourceValue, {
      observations: this.getObservations(),
      state: this.getState(),
      vars: this.getVars(),
    });

    this.logTrace(
      `infer beliefs from ${this.describeValueExpression(statement.source)}`,
    );

    const normalizedPatch = this.asBeliefPatch(patch as unknown as RuntimeValue);
    this.mergeBeliefPatch(normalizedPatch, {
      origin: "infer",
      source: `infer ${this.describeValueExpression(statement.source)}`,
    });
  }

  private async executeMergeBeliefs(statement: MergeBeliefsStatement): Promise<void> {
    const sourceValue = await this.evalValue(statement.source);
    const patch = this.asBeliefPatch(sourceValue);

    this.logTrace(
      `merge beliefs from ${this.describeValueExpression(statement.source)}`,
    );

    this.mergeBeliefPatch(patch, {
      origin: "merge",
      source: `merge ${this.describeValueExpression(statement.source)}`,
    });
  }

  async evalCondition(rule: Rule, index: number): Promise<boolean> {
    const traceLines: string[] = [];
    const result = await this.evalConditionExpression(rule.condition, traceLines);

    this.logTrace(`rule ${index + 1} when ${this.describeCondition(rule.condition)} => ${result}`);
    for (const line of traceLines) {
      this.logTrace(`  ${line}`);
    }

    return result;
  }

  async callTool(toolName: string): Promise<RuntimeValue> {
    const tool = this.tools[toolName];

    this.logTrace(`call ${toolName}()`);

    if (!tool) {
      console.log(`[call] ${toolName}()`);
      return null;
    }

    return await tool();
  }

  async executeAction(action: Action): Promise<void> {
    this.logTrace(`action ${this.describeAction(action)}`);

    if (action.kind === "ask_user") {
      console.log(`[ask_user] ${action.message}`);
      return;
    }

    if (action.kind === "assign_call") {
      this.vars[action.variableName] = await this.callTool(action.toolName);
      this.logTrace(
        `assigned ${action.variableName}=${this.formatValue(this.vars[action.variableName])}`,
      );
      return;
    }

    await this.callTool(action.toolName);
  }

  async run(statements: Statement[]): Promise<void> {
    const rules: Rule[] = [];

    for (const statement of statements) {
      if (statement.kind === "belief") {
        this.loadBelief(statement);
      } else if (statement.kind === "let") {
        await this.assign(statement.name, statement.value);
      } else if (statement.kind === "observe") {
        await this.executeObserve(statement);
      } else if (statement.kind === "infer") {
        await this.executeInfer(statement);
      } else if (statement.kind === "merge_beliefs") {
        await this.executeMergeBeliefs(statement);
      } else {
        rules.push(statement);
      }
    }

    this.printState();
    this.printVars();
    this.printObservations();

    for (let i = 0; i < rules.length; i += 1) {
      const rule = rules[i];
      if (await this.evalCondition(rule, i)) {
        await this.executeAction(rule.action);
      }
    }
  }

  printState(): void {
    console.log("[state]");

    for (const [name, dist] of Object.entries(this.state)) {
      const meta = this.beliefMeta[name];
      const values = Object.entries(dist)
        .map(([key, value]) => `${key}=${value.toFixed(3)}`)
        .join(", ");

      const openOther =
        meta?.cardinality === "exclusive" && meta.domain === "open" && meta.openMass > 0
          ? `, other=${meta.openMass.toFixed(3)}`
          : "";

      const label = meta ? `${name} [${meta.cardinality}/${meta.domain}]` : name;
      console.log(`  ${label}: ${values}${openOther}`);
    }
  }

  printVars(): void {
    const entries = Object.entries(this.vars);
    if (entries.length === 0) return;

    console.log("[vars]");

    for (const [name, value] of entries) {
      console.log(`  ${name}: ${JSON.stringify(value)}`);
    }
  }

  printObservations(): void {
    if (this.observations.length === 0) return;

    console.log("[observations]");

    for (const observation of this.observations) {
      console.log(
        `  ${observation.id} ${observation.eventName}: ${this.formatValue(observation.value)}`,
      );
    }
  }
}
