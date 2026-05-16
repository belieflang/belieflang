import type {
  Action,
  BeliefBlock,
  BeliefState,
  Rule,
  Statement,
} from "./ast.js";

export type Tool = () => void | Promise<void>;
export type ToolRegistry = Record<string, Tool>;

export class BeliefRuntime {
  private state: BeliefState = {};
  private tools: ToolRegistry;

  constructor(tools: ToolRegistry = {}) {
    this.tools = {
      search_flights: () => console.log("[tool] search_flights()"),
      search_hotels: () => console.log("[tool] search_hotels()"),
      ...tools,
    };
  }

  getState(): BeliefState {
    return structuredClone(this.state);
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

    if (probs.length <= 1) {
      return 0;
    }

    const raw = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
    const maxEntropy = Math.log2(probs.length);

    return raw / maxEntropy;
  }

  evalCondition(rule: Rule): boolean {
    const left =
      rule.leftFn === "confidence"
        ? this.confidence(rule.leftArg)
        : this.entropy(rule.leftArg);

    switch (rule.op) {
      case ">":
        return left > rule.right;
      case ">=":
        return left >= rule.right;
      case "<":
        return left < rule.right;
      case "<=":
        return left <= rule.right;
      case "==":
        return left === rule.right;
      default:
        throw new Error(`unknown operator ${rule.op}`);
    }
  }

  async executeAction(action: Action): Promise<void> {
    if (action.kind === "ask_user") {
      console.log(`[ask_user] ${action.message}`);
      return;
    }

    const tool = this.tools[action.toolName];

    if (!tool) {
      console.log(`[call] ${action.toolName}()`);
      return;
    }

    await tool();
  }

  async run(statements: Statement[]): Promise<void> {
    const rules: Rule[] = [];

    for (const statement of statements) {
      if (statement.kind === "belief") {
        this.loadBelief(statement);
      } else {
        rules.push(statement);
      }
    }

    this.printState();

    for (const rule of rules) {
      if (this.evalCondition(rule)) {
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
}
