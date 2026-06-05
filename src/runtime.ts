import type {
  Action,
  BeliefBlock,
  BeliefCardinality,
  BeliefDomain,
  BeliefState,
  ConditionExpression,
  Operator,
  RuntimeValue,
  Rule,
  Statement,
  ValueExpression,
} from "./ast.js";

export type Tool = () => RuntimeValue | Promise<RuntimeValue>;
export type ToolRegistry = Record<string, Tool>;

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
  private tools: ToolRegistry;
  private trace: boolean;

  constructor(
    tools: ToolRegistry = {},
    options: {
      trace?: boolean;
    } = {},
  ) {
    this.trace = options.trace ?? false;
    this.tools = {
      search_flights: () => ({ count: 3, best_price: 214, currency: "EUR" }),
      search_hotels: () => ({ count: 5, best_price: 88, currency: "EUR" }),
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

  loadBelief(block: BeliefBlock): void {
    const entries = Object.entries(block.values);

    if (entries.length === 0) {
      throw new Error(`belief ${block.name} has no values`);
    }

    for (const [label, value] of entries) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`belief ${block.name}.${label} must be a non-negative number`);
      }

      if (block.cardinality === "multi" && value > 1 + EPSILON) {
        throw new Error(
          `belief ${block.name}.${label} must be in [0, 1] for multi beliefs`,
        );
      }
    }

    if (block.cardinality === "exclusive") {
      const total = entries.reduce((sum, [, value]) => sum + value, 0);

      if (total <= 0) {
        throw new Error(`belief ${block.name} has non-positive probability mass`);
      }

      if (block.domain === "closed") {
        this.state[block.name] = Object.fromEntries(
          entries.map(([key, value]) => [key, value / total]),
        );

        this.beliefMeta[block.name] = {
          cardinality: block.cardinality,
          domain: block.domain,
          openMass: 0,
        };
        return;
      }

      if (total > 1 + EPSILON) {
        throw new Error(
          `belief ${block.name} is open+exclusive and cannot exceed total mass 1.0`,
        );
      }

      this.state[block.name] = { ...block.values };
      this.beliefMeta[block.name] = {
        cardinality: block.cardinality,
        domain: block.domain,
        openMass: Math.max(0, 1 - total),
      };
      return;
    }

    this.state[block.name] = { ...block.values };
    this.beliefMeta[block.name] = {
      cardinality: block.cardinality,
      domain: block.domain,
      openMass: 0,
    };
  }

  async assign(name: string, expression: ValueExpression): Promise<void> {
    this.vars[name] = await this.evalValue(expression);
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
        throw new Error(
          `cannot access ${part} on non-object reference ${path}`,
        );
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

  private compareValues(
    left: RuntimeValue,
    op: Operator,
    right: RuntimeValue,
  ): boolean {
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
      } else {
        rules.push(statement);
      }
    }

    this.printState();
    this.printVars();

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
}
