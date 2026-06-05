export type BeliefDistribution = Record<string, number>;
export type BeliefState = Record<string, BeliefDistribution>;

export type BeliefCardinality = "exclusive" | "multi";
export type BeliefDomain = "open" | "closed";

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
  cardinality: BeliefCardinality;
  domain: BeliefDomain;
  values: BeliefDistribution;
};

export type ConditionFunction = "confidence" | "entropy";
export type Operator = ">" | ">=" | "<" | "<=" | "==" | "!=";

export type CallExpression = {
  kind: "call_expr";
  toolName: string;
};

export type ValueExpression =
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "identifier"; name: string }
  | { kind: "metric"; fn: ConditionFunction; arg: string }
  | CallExpression;

export type LetStatement = {
  kind: "let";
  name: string;
  value: ValueExpression;
};

export type ObserveStatement = {
  kind: "observe";
  eventName: string;
  value?: ValueExpression;
};

export type InferStatement = {
  kind: "infer";
  source: ValueExpression;
};

export type MergeBeliefsStatement = {
  kind: "merge_beliefs";
  source: ValueExpression;
};

export type Action =
  | { kind: "call"; toolName: string }
  | { kind: "ask_user"; message: string }
  | { kind: "assign_call"; variableName: string; toolName: string };

export type ConditionExpression =
  | {
      kind: "comparison";
      left: ValueExpression;
      op: Operator;
      right: ValueExpression;
    }
  | {
      kind: "and";
      left: ConditionExpression;
      right: ConditionExpression;
    }
  | {
      kind: "or";
      left: ConditionExpression;
      right: ConditionExpression;
    }
  | {
      kind: "not";
      expr: ConditionExpression;
    }
  | {
      kind: "truthy";
      expr: ValueExpression;
    };

export type Rule = {
  kind: "rule";
  condition: ConditionExpression;
  action: Action;
};

export type Statement =
  | BeliefBlock
  | LetStatement
  | ObserveStatement
  | InferStatement
  | MergeBeliefsStatement
  | Rule;
