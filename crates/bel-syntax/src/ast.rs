use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

pub type BeliefDistribution = IndexMap<String, f64>;
pub type BeliefState = IndexMap<String, BeliefDistribution>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BeliefCardinality {
    #[default]
    Exclusive,
    Multi,
}

impl std::fmt::Display for BeliefCardinality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Exclusive => write!(f, "exclusive"),
            Self::Multi => write!(f, "multi"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BeliefDomain {
    Open,
    #[default]
    Closed,
}

impl std::fmt::Display for BeliefDomain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open => write!(f, "open"),
            Self::Closed => write!(f, "closed"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BeliefBlock {
    pub name: String,
    pub cardinality: BeliefCardinality,
    pub domain: BeliefDomain,
    pub values: BeliefDistribution,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConditionFunction {
    Confidence,
    Entropy,
}

impl std::fmt::Display for ConditionFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Confidence => write!(f, "confidence"),
            Self::Entropy => write!(f, "entropy"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Operator {
    #[serde(rename = ">")]
    Gt,
    #[serde(rename = ">=")]
    Gte,
    #[serde(rename = "<")]
    Lt,
    #[serde(rename = "<=")]
    Lte,
    #[serde(rename = "==")]
    Eq,
    #[serde(rename = "!=")]
    Neq,
}

impl Operator {
    pub fn as_str(&self) -> &'static str {
        match self {
            Operator::Gt => ">",
            Operator::Gte => ">=",
            Operator::Lt => "<",
            Operator::Lte => "<=",
            Operator::Eq => "==",
            Operator::Neq => "!=",
        }
    }
}

impl std::fmt::Display for Operator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ValueExpression {
    #[serde(rename = "number")]
    Number { value: f64 },
    #[serde(rename = "string")]
    String { value: String },
    #[serde(rename = "boolean")]
    Boolean { value: bool },
    #[serde(rename = "identifier")]
    Identifier { name: String },
    #[serde(rename = "metric")]
    Metric {
        #[serde(rename = "fn")]
        function: ConditionFunction,
        arg: String,
    },
    #[serde(rename = "call_expr")]
    Call {
        #[serde(rename = "toolName")]
        tool_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LetStatement {
    pub name: String,
    pub value: ValueExpression,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ObserveStatement {
    pub event_name: String,
    pub value: Option<ValueExpression>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InferStatement {
    pub source: ValueExpression,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MergeBeliefsStatement {
    pub source: ValueExpression,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum Action {
    #[serde(rename = "call")]
    Call {
        #[serde(rename = "toolName")]
        tool_name: String,
    },
    #[serde(rename = "ask_user")]
    AskUser { message: String },
    #[serde(rename = "assign_call")]
    AssignCall {
        #[serde(rename = "variableName")]
        variable_name: String,
        #[serde(rename = "toolName")]
        tool_name: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum ConditionExpression {
    #[serde(rename = "comparison")]
    Comparison {
        left: Box<ValueExpression>,
        op: Operator,
        right: Box<ValueExpression>,
    },
    #[serde(rename = "and")]
    And {
        left: Box<ConditionExpression>,
        right: Box<ConditionExpression>,
    },
    #[serde(rename = "or")]
    Or {
        left: Box<ConditionExpression>,
        right: Box<ConditionExpression>,
    },
    #[serde(rename = "not")]
    Not { expr: Box<ConditionExpression> },
    #[serde(rename = "truthy")]
    Truthy { expr: Box<ValueExpression> },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Rule {
    pub condition: ConditionExpression,
    pub action: Action,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Statement {
    #[serde(rename = "belief")]
    Belief(BeliefBlock),
    #[serde(rename = "let")]
    Let(LetStatement),
    #[serde(rename = "observe")]
    Observe(ObserveStatement),
    #[serde(rename = "infer")]
    Infer(InferStatement),
    #[serde(rename = "merge_beliefs")]
    MergeBeliefs(MergeBeliefsStatement),
    #[serde(rename = "rule")]
    Rule(Rule),
}
