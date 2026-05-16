import type {
  Action,
  BeliefBlock,
  BeliefDistribution,
  Rule,
  Statement,
} from "./ast.js";

const BELIEF_BLOCK_RE = /belief\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
const ITEM_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9]*\.?[0-9]+)/g;

const RULE_RE =
  /when\s+(confidence|entropy)\(([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\)\s*(>=|<=|==|>|<)\s*([0-9]*\.?[0-9]+)\s*:\s*\n\s*(call\s+[A-Za-z_][A-Za-z0-9_]*\(\)|ask_user\(".*?"\))/gs;

const CALL_RE = /^call\s+([A-Za-z_][A-Za-z0-9_]*)\(\)$/;
const ASK_RE = /^ask_user\("(.*?)"\)$/;

export function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.split("#", 1)[0])
    .join("\n");
}

function parseAction(source: string): Action {
  const trimmed = source.trim();

  const callMatch = CALL_RE.exec(trimmed);
  if (callMatch) {
    return {
      kind: "call",
      toolName: callMatch[1],
    };
  }

  const askMatch = ASK_RE.exec(trimmed);
  if (askMatch) {
    return {
      kind: "ask_user",
      message: askMatch[1],
    };
  }

  throw new SyntaxError(`Invalid action: ${source}`);
}

export function parse(source: string): Statement[] {
  const clean = stripComments(source);
  const statements: Statement[] = [];

  for (const match of clean.matchAll(BELIEF_BLOCK_RE)) {
    const [, name, body] = match;
    const values: BeliefDistribution = {};

    for (const item of body.matchAll(ITEM_RE)) {
      const [, key, value] = item;
      values[key] = Number(value);
    }

    if (Object.keys(values).length === 0) {
      throw new SyntaxError(`belief ${name} has no values`);
    }

    const block: BeliefBlock = {
      kind: "belief",
      name,
      values,
    };

    statements.push(block);
  }

  for (const match of clean.matchAll(RULE_RE)) {
    const [, leftFn, leftArg, op, right, actionSource] = match;

    const rule: Rule = {
      kind: "rule",
      leftFn: leftFn as Rule["leftFn"],
      leftArg,
      op: op as Rule["op"],
      right: Number(right),
      action: parseAction(actionSource),
    };

    statements.push(rule);
  }

  if (statements.length === 0) {
    throw new SyntaxError("No BeliefLang statements found");
  }

  return statements;
}
