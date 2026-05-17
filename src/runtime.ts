import type {
  Action,
  BeliefBlock,
  BeliefState,
  ConditionOperand,
  RuntimeValue,
  Rule,
  Statement,
  ValueExpression,
} from "./ast.js";

export type Tool = () => RuntimeValue | Promise<RuntimeValue>;
export type ToolRegistry = Record<string, Tool>;

export class BeliefRuntime {
  private state: BeliefState = {};
  private vars: Record<string, RuntimeValue> = {};
  private tools: ToolRegistry;

  constructor(tools: ToolRegistry = {}) {
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
    const total = Object.values(block.values).reduce(
      (sum, value) => sum + value,
      0,
    );

    if (total <= 0) {
      throw new Error(`belief ${block.name} has non-positive probability mass`);
    }

    this.state[block.name] = Object.fromEntries(
      Object.entries(block.values).map(([key, value]) => [key, value / total]),
    );
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

      value = value[part];

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

    return this.state[beliefName]?.[key] ?? 0;
  }

  entropy(beliefName: string): number {
    const dist = this.state[beliefName];

    if (!dist) {
      throw new Error(`unknown belief ${beliefName}`);
    }

    const probs = Object.values(dist).filter((p) => p > 0);

    if (probs.length <= 1) return 0;

    const raw = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
    const maxEntropy = Math.log2(probs.length);

    return raw / maxEntropy;
  }

  evalOperand(operand: ConditionOperand): RuntimeValue {
    if (operand.kind === "fn") {
      return operand.fn === "confidence"
        ? this.confidence(operand.arg)
        : this.entropy(operand.arg);
    }

    return this.resolvePath(operand.path);
  }

  async evalCondition(rule: Rule): Promise<boolean> {
    const left = this.evalOperand(rule.left);
    const right = await this.evalValue(rule.right);

    switch (rule.op) {
      case ">":
        return Number(left) > Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<":
        return Number(left) < Number(right);
      case "<=":
        return Number(left) <= Number(right);
      case "==":
        return left === right;
    }
  }

  async callTool(toolName: string): Promise<RuntimeValue> {
    const tool = this.tools[toolName];

    if (!tool) {
      console.log(`[call] ${toolName}()`);
      return null;
    }

    return await tool();
  }

  async executeAction(action: Action): Promise<void> {
    if (action.kind === "ask_user") {
      console.log(`[ask_user] ${action.message}`);
      return;
    }

    if (action.kind === "assign_call") {
      this.vars[action.variableName] = await this.callTool(action.toolName);
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

    for (const rule of rules) {
      if (await this.evalCondition(rule)) {
        await this.executeAction(rule.action);
      }
    }
  }

  printState(): void {
    console.log("[state]");

    for (const [name, dist] of Object.entries(this.state)) {
      const body = Object.entries(dist)
        .map(([key, value]) => `${key}=${value.toFixed(3)}`)
        .join(", ");

      console.log(`  ${name}: ${body}`);
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
