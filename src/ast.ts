export type BeliefDistribution = Record<string, number>;
export type BeliefState = Record<string, BeliefDistribution>;

export type BeliefBlock = {
  kind: "belief";
  name: string;
  values: BeliefDistribution;
};

export type ConditionFunction = "confidence" | "entropy";
export type Operator = ">" | ">=" | "<" | "<=" | "==";

export type Action =
  | {
      kind: "call";
      toolName: string;
    }
  | {
      kind: "ask_user";
      message: string;
    };

export type Rule = {
  kind: "rule";
  leftFn: ConditionFunction;
  leftArg: string;
  op: Operator;
  right: number;
  action: Action;
};

export type Statement = BeliefBlock | Rule;
