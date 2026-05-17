import type {
  Action,
  BeliefBlock,
  BeliefDistribution,
  ConditionOperand,
  LetStatement,
  Rule,
  Statement,
  ValueExpression,
} from "./ast.js";

const BELIEF_BLOCK_RE = /belief\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g;
const ITEM_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([0-9]*\.?[0-9]+)/g;
const LET_RE = /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/gm;
const RULE_RE =
  /when\s+(.+?)\s*(>=|<=|==|>|<)\s*(.+?)\s*:\s*\n\s*(call\s+[A-Za-z_][A-Za-z0-9_]*\(\)|ask_user\(".*?"\)|let\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*call\s+[A-Za-z_][A-Za-z0-9_]*\(\))/gs;

const CALL_RE = /^call\s+([A-Za-z_][A-Za-z0-9_]*)\(\)$/;
const ASK_RE = /^ask_user\("(.*?)"\)$/;
const ASSIGN_CALL_RE =
  /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*call\s+([A-Za-z_][A-Za-z0-9_]*)\(\)$/;
const FN_OPERAND_RE =
  /^(confidence|entropy)\(([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\)$/;

export function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.split("#", 1)[0])
    .join("\n");
}

function parseValueExpression(source: string): ValueExpression {
  const trimmed = source.trim();

  const callMatch = CALL_RE.exec(trimmed);
  if (callMatch) return { kind: "call_expr", toolName: callMatch[1] };

  if (/^[0-9]*\.?[0-9]+$/.test(trimmed)) {
    return { kind: "number", value: Number(trimmed) };
  }

  if (trimmed === "true" || trimmed === "false") {
    return { kind: "boolean", value: trimmed === "true" };
  }

  const stringMatch = /^"(.*)"$/.exec(trimmed);
  if (stringMatch) return { kind: "string", value: stringMatch[1] };

  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(trimmed)) {
    return { kind: "identifier", name: trimmed };
  }

  throw new SyntaxError(`Invalid value expression: ${source}`);
}

function parseConditionOperand(source: string): ConditionOperand {
  const trimmed = source.trim();

  const fnMatch = FN_OPERAND_RE.exec(trimmed);
  if (fnMatch) {
    return {
      kind: "fn",
      fn: fnMatch[1] as ConditionOperand["fn"],
      arg: fnMatch[2],
    };
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(trimmed)) {
    return { kind: "ref", path: trimmed };
  }

  throw new SyntaxError(`Invalid condition operand: ${source}`);
}

function parseAction(source: string): Action {
  const trimmed = source.trim();

  const assignCallMatch = ASSIGN_CALL_RE.exec(trimmed);
  if (assignCallMatch) {
    return {
      kind: "assign_call",
      variableName: assignCallMatch[1],
      toolName: assignCallMatch[2],
    };
  }

  const callMatch = CALL_RE.exec(trimmed);
  if (callMatch) return { kind: "call", toolName: callMatch[1] };

  const askMatch = ASK_RE.exec(trimmed);
  if (askMatch) return { kind: "ask_user", message: askMatch[1] };

  throw new SyntaxError(`Invalid action: ${source}`);
}

function parseBeliefBlocks(clean: string): BeliefBlock[] {
  const blocks: BeliefBlock[] = [];

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

    blocks.push({ kind: "belief", name, values });
  }

  return blocks;
}

function parseLets(clean: string): LetStatement[] {
  const lets: LetStatement[] = [];

  for (const match of clean.matchAll(LET_RE)) {
    const [, name, rawValue] = match;
    const previousLine = clean.slice(0, match.index).split("\n").at(-1) ?? "";

    if (previousLine.trim().endsWith(":")) continue;

    lets.push({
      kind: "let",
      name,
      value: parseValueExpression(rawValue),
    });
  }

  return lets;
}

function parseRules(clean: string): Rule[] {
  const rules: Rule[] = [];

  for (const match of clean.matchAll(RULE_RE)) {
    const [, left, op, right, actionSource] = match;

    rules.push({
      kind: "rule",
      left: parseConditionOperand(left),
      op: op as Rule["op"],
      right: parseValueExpression(right),
      action: parseAction(actionSource),
    });
  }

  return rules;
}

export function parse(source: string): Statement[] {
  const clean = stripComments(source);
  const statements: Statement[] = [
    ...parseBeliefBlocks(clean),
    ...parseLets(clean),
    ...parseRules(clean),
  ];

  if (statements.length === 0) {
    throw new SyntaxError("No BeliefLang statements found");
  }

  return statements;
}
