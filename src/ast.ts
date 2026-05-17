export type BeliefDistribution = Record<string, number>;
export type BeliefState = Record<string, BeliefDistribution>;

export type RuntimeValue =
  | string
  | number
  | boolean
  | null
  | RuntimeValue[]
  | { [key: string]: RuntimeValue };

export type BeliefBlock = {
  kind: "belief";
  name: string;
  values: BeliefDistribution;
};

export type ConditionFunction = "confidence" | "entropy";
export type Operator = ">" | ">=" | "<" | "<=" | "==";

export type CallExpression = {
  kind: "call_expr";
  toolName: string;
};

export type ValueExpression =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "identifier"; name: string }
  | CallExpression;

export type LetStatement = {
  kind: "let";
  name: string;
  value: ValueExpression;
};

export type Action =
  | { kind: "call"; toolName: string }
  | { kind: "ask_user"; message: string }
  | { kind: "assign_call"; variableName: string; toolName: string };

export type ConditionOperand =
  | { kind: "fn"; fn: ConditionFunction; arg: string }
  | { kind: "ref"; path: string };

export type Rule = {
  kind: "rule";
  left: ConditionOperand;
  op: Operator;
  right: ValueExpression;
  action: Action;
};

export type Statement = BeliefBlock | LetStatement | Rule;
