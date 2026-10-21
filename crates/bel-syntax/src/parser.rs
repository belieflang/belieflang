use crate::ast::*;
use crate::lexer::{tokenize, SyntaxError, Token, TokenKind};
use indexmap::IndexMap;

pub struct Parser {
    tokens: Vec<Token>,
    index: usize,
}

impl Parser {
    pub fn new(tokens: Vec<Token>) -> Self {
        Self { tokens, index: 0 }
    }

    pub fn parse_program(&mut self) -> Result<Vec<Statement>, SyntaxError> {
        let mut statements = Vec::new();
        self.consume_newlines();

        while !self.is_eof() {
            statements.push(self.parse_statement()?);
            self.consume_newlines();
        }

        if statements.is_empty() {
            return Err(self.fail("No BeliefLang statements found"));
        }

        Ok(statements)
    }

    fn parse_statement(&mut self) -> Result<Statement, SyntaxError> {
        if self.is_keyword("belief") {
            return self.parse_belief().map(Statement::Belief);
        }
        if self.is_keyword("let") {
            return self.parse_let().map(Statement::Let);
        }
        if self.is_keyword("observe") {
            return self.parse_observe().map(Statement::Observe);
        }
        if self.is_keyword("infer") {
            return self.parse_infer().map(Statement::Infer);
        }
        if self.is_keyword("merge") {
            return self.parse_merge_beliefs().map(Statement::MergeBeliefs);
        }
        if self.is_keyword("when") {
            return self.parse_rule().map(Statement::Rule);
        }

        let desc = self.describe_token(&self.current().kind);
        Err(self.fail(&format!("Unexpected token '{desc}'")))
    }

    fn parse_belief(&mut self) -> Result<BeliefBlock, SyntaxError> {
        self.expect_keyword("belief")?;
        let name = self.expect_identifier()?;

        let mut cardinality = BeliefCardinality::Exclusive;
        let mut domain = BeliefDomain::Closed;
        let mut cardinality_set = false;
        let mut domain_set = false;

        while let TokenKind::Identifier(modifier) = &self.current().kind {
            if modifier == "exclusive" || modifier == "multi" {
                if cardinality_set {
                    return Err(self.fail("Belief cardinality already declared"));
                }
                cardinality = if modifier == "exclusive" {
                    BeliefCardinality::Exclusive
                } else {
                    BeliefCardinality::Multi
                };
                cardinality_set = true;
                self.advance();
                continue;
            }

            if modifier == "open" || modifier == "closed" {
                if domain_set {
                    return Err(self.fail("Belief domain already declared"));
                }
                domain = if modifier == "open" {
                    BeliefDomain::Open
                } else {
                    BeliefDomain::Closed
                };
                domain_set = true;
                self.advance();
                continue;
            }

            break;
        }

        self.expect(TokenKind::LBrace)?;
        self.consume_newlines();

        let mut values = IndexMap::new();

        while !self.is(&TokenKind::RBrace) {
            let key = self.expect_identifier()?;
            self.expect(TokenKind::Colon)?;
            let value = self.expect_number()?;
            values.insert(key, value);

            if self.is(&TokenKind::RBrace) {
                break;
            }
            self.require_at_least_one_newline()?;
            self.consume_newlines();
        }

        self.expect(TokenKind::RBrace)?;

        if values.is_empty() {
            return Err(self.fail(&format!("belief {name} has no values")));
        }

        Ok(BeliefBlock {
            name,
            cardinality,
            domain,
            values,
        })
    }

    fn parse_let(&mut self) -> Result<LetStatement, SyntaxError> {
        self.expect_keyword("let")?;
        let name = self.expect_identifier()?;
        self.expect(TokenKind::Eq)?;
        let value = self.parse_value_expression(true, true)?;

        Ok(LetStatement { name, value })
    }

    fn parse_observe(&mut self) -> Result<ObserveStatement, SyntaxError> {
        self.expect_keyword("observe")?;
        let event_name = self.expect_identifier()?;
        self.expect(TokenKind::LParen)?;

        let value = if !self.is(&TokenKind::RParen) {
            Some(self.parse_value_expression(true, true)?)
        } else {
            None
        };

        self.expect(TokenKind::RParen)?;

        Ok(ObserveStatement { event_name, value })
    }

    fn parse_infer(&mut self) -> Result<InferStatement, SyntaxError> {
        self.expect_keyword("infer")?;
        self.expect_keyword("beliefs")?;
        self.expect_keyword("from")?;

        let source = self.parse_value_expression(true, true)?;
        Ok(InferStatement { source })
    }

    fn parse_merge_beliefs(&mut self) -> Result<MergeBeliefsStatement, SyntaxError> {
        self.expect_keyword("merge")?;
        self.expect_keyword("beliefs")?;
        self.expect_keyword("from")?;

        let source = self.parse_value_expression(true, true)?;
        Ok(MergeBeliefsStatement { source })
    }

    fn parse_rule(&mut self) -> Result<Rule, SyntaxError> {
        self.expect_keyword("when")?;
        let condition = self.parse_condition_expression()?;
        self.expect(TokenKind::Colon)?;
        self.require_at_least_one_newline()?;
        self.consume_newlines();
        let action = self.parse_action()?;

        Ok(Rule { condition, action })
    }

    fn parse_action(&mut self) -> Result<Action, SyntaxError> {
        if self.is_keyword("call") {
            let tool_name = self.parse_tool_invocation_from_call_keyword()?;
            return Ok(Action::Call { tool_name });
        }

        if self.is_keyword("ask_user") {
            self.expect_keyword("ask_user")?;
            self.expect(TokenKind::LParen)?;
            let message = self.expect_string()?;
            self.expect(TokenKind::RParen)?;
            return Ok(Action::AskUser { message });
        }

        if self.is_keyword("let") {
            self.expect_keyword("let")?;
            let variable_name = self.expect_identifier()?;
            self.expect(TokenKind::Eq)?;
            let tool_name = self.parse_tool_invocation_from_call_keyword()?;
            return Ok(Action::AssignCall {
                variable_name,
                tool_name,
            });
        }

        Err(self.fail("Invalid rule action"))
    }

    fn parse_tool_invocation_from_call_keyword(&mut self) -> Result<String, SyntaxError> {
        self.expect_keyword("call")?;
        let tool_name = self.expect_identifier()?;
        self.expect(TokenKind::LParen)?;
        self.expect(TokenKind::RParen)?;
        Ok(tool_name)
    }

    fn parse_condition_expression(&mut self) -> Result<ConditionExpression, SyntaxError> {
        self.parse_or_condition()
    }

    fn parse_or_condition(&mut self) -> Result<ConditionExpression, SyntaxError> {
        let mut left = self.parse_and_condition()?;

        while self.match_token(&TokenKind::Or) {
            let right = self.parse_and_condition()?;
            left = ConditionExpression::Or {
                left: Box::new(left),
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    fn parse_and_condition(&mut self) -> Result<ConditionExpression, SyntaxError> {
        let mut left = self.parse_not_condition()?;

        while self.match_token(&TokenKind::And) {
            let right = self.parse_not_condition()?;
            left = ConditionExpression::And {
                left: Box::new(left),
                right: Box::new(right),
            };
        }

        Ok(left)
    }

    fn parse_not_condition(&mut self) -> Result<ConditionExpression, SyntaxError> {
        if self.match_token(&TokenKind::Not) {
            let expr = self.parse_not_condition()?;
            return Ok(ConditionExpression::Not {
                expr: Box::new(expr),
            });
        }

        self.parse_condition_primary()
    }

    fn parse_condition_primary(&mut self) -> Result<ConditionExpression, SyntaxError> {
        if self.match_token(&TokenKind::LParen) {
            let expression = self.parse_condition_expression()?;
            self.expect(TokenKind::RParen)?;
            return Ok(expression);
        }

        self.parse_comparison_or_truthy()
    }

    fn parse_comparison_or_truthy(&mut self) -> Result<ConditionExpression, SyntaxError> {
        let left = self.parse_value_expression(false, true)?;

        let op = match &self.current().kind {
            TokenKind::Gt => Some(Operator::Gt),
            TokenKind::Gte => Some(Operator::Gte),
            TokenKind::Lt => Some(Operator::Lt),
            TokenKind::Lte => Some(Operator::Lte),
            TokenKind::EqEq => Some(Operator::Eq),
            TokenKind::Neq => Some(Operator::Neq),
            _ => None,
        };

        if let Some(op) = op {
            self.advance();
            let right = self.parse_value_expression(false, true)?;
            return Ok(ConditionExpression::Comparison {
                left: Box::new(left),
                op,
                right: Box::new(right),
            });
        }

        Ok(ConditionExpression::Truthy {
            expr: Box::new(left),
        })
    }

    fn parse_value_expression(
        &mut self,
        allow_call_expression: bool,
        allow_metric: bool,
    ) -> Result<ValueExpression, SyntaxError> {
        let token = self.current().clone();

        if let TokenKind::Number(val) = &token.kind {
            self.advance();
            let parsed: f64 = val
                .parse()
                .map_err(|_| self.fail("Invalid number literal"))?;
            return Ok(ValueExpression::Number { value: parsed });
        }

        if let TokenKind::StringLit(val) = &token.kind {
            self.advance();
            return Ok(ValueExpression::String { value: val.clone() });
        }

        if let TokenKind::Identifier(val) = &token.kind {
            if val == "true" || val == "false" {
                let boolean_val = val == "true";
                self.advance();
                return Ok(ValueExpression::Boolean { value: boolean_val });
            }

            if allow_metric
                && (val == "confidence" || val == "entropy")
                && self.peek(1).kind == TokenKind::LParen
            {
                let fn_kind = if val == "confidence" {
                    ConditionFunction::Confidence
                } else {
                    ConditionFunction::Entropy
                };
                self.advance();
                self.expect(TokenKind::LParen)?;
                let arg = self.parse_path()?;
                self.expect(TokenKind::RParen)?;
                return Ok(ValueExpression::Metric {
                    function: fn_kind,
                    arg,
                });
            }

            if allow_call_expression && val == "call" {
                let tool_name = self.parse_tool_invocation_from_call_keyword()?;
                return Ok(ValueExpression::Call { tool_name });
            }

            let path = self.parse_path()?;
            return Ok(ValueExpression::Identifier { name: path });
        }

        Err(self.fail("Invalid value expression"))
    }

    fn parse_path(&mut self) -> Result<String, SyntaxError> {
        let mut parts = vec![self.expect_identifier()?];

        while self.match_token(&TokenKind::Dot) {
            parts.push(self.expect_identifier()?);
        }

        Ok(parts.join("."))
    }

    fn consume_newlines(&mut self) {
        while self.match_token(&TokenKind::Newline) {}
    }

    fn require_at_least_one_newline(&mut self) -> Result<(), SyntaxError> {
        if !self.match_token(&TokenKind::Newline) {
            return Err(self.fail("Expected newline"));
        }
        Ok(())
    }

    fn is(&self, kind: &TokenKind) -> bool {
        std::mem::discriminant(&self.current().kind) == std::mem::discriminant(kind)
    }

    fn is_eof(&self) -> bool {
        matches!(self.current().kind, TokenKind::Eof)
    }

    fn current(&self) -> &Token {
        self.tokens
            .get(self.index)
            .unwrap_or_else(|| self.tokens.last().expect("tokens cannot be empty"))
    }

    fn peek(&self, offset: usize) -> &Token {
        self.tokens
            .get(self.index + offset)
            .unwrap_or_else(|| self.tokens.last().expect("tokens cannot be empty"))
    }

    fn advance(&mut self) -> Token {
        let token = self.current().clone();
        if self.index < self.tokens.len() {
            self.index += 1;
        }
        token
    }

    fn match_token(&mut self, kind: &TokenKind) -> bool {
        if self.is(kind) {
            self.advance();
            true
        } else {
            false
        }
    }

    fn expect(&mut self, kind: TokenKind) -> Result<Token, SyntaxError> {
        if self.is(&kind) {
            Ok(self.advance())
        } else {
            let expected_desc = self.describe_token(&kind);
            let got_desc = self.describe_token(&self.current().kind);
            Err(self.fail(&format!("Expected '{expected_desc}', got '{got_desc}'")))
        }
    }

    fn is_keyword(&self, keyword: &str) -> bool {
        if let TokenKind::Identifier(val) = &self.current().kind {
            val == keyword
        } else {
            false
        }
    }

    fn expect_keyword(&mut self, keyword: &str) -> Result<(), SyntaxError> {
        if self.is_keyword(keyword) {
            self.advance();
            Ok(())
        } else {
            Err(self.fail(&format!("Expected keyword '{keyword}'")))
        }
    }

    fn expect_identifier(&mut self) -> Result<String, SyntaxError> {
        if let TokenKind::Identifier(val) = &self.current().kind {
            let result = val.clone();
            self.advance();
            Ok(result)
        } else {
            Err(self.fail("Expected identifier"))
        }
    }

    fn expect_number(&mut self) -> Result<f64, SyntaxError> {
        if let TokenKind::Number(val) = &self.current().kind {
            let parsed: f64 = val.parse().map_err(|_| self.fail("Expected number"))?;
            self.advance();
            Ok(parsed)
        } else {
            Err(self.fail("Expected number"))
        }
    }

    fn expect_string(&mut self) -> Result<String, SyntaxError> {
        if let TokenKind::StringLit(val) = &self.current().kind {
            let result = val.clone();
            self.advance();
            Ok(result)
        } else {
            Err(self.fail("Expected string"))
        }
    }

    fn describe_token(&self, kind: &TokenKind) -> String {
        match kind {
            TokenKind::Identifier(s) => s.clone(),
            TokenKind::Number(s) => s.clone(),
            TokenKind::StringLit(s) => format!("\"{s}\""),
            TokenKind::LBrace => "{".to_string(),
            TokenKind::RBrace => "}".to_string(),
            TokenKind::LParen => "(".to_string(),
            TokenKind::RParen => ")".to_string(),
            TokenKind::Colon => ":".to_string(),
            TokenKind::Dot => ".".to_string(),
            TokenKind::Eq => "=".to_string(),
            TokenKind::Gt => ">".to_string(),
            TokenKind::Gte => ">=".to_string(),
            TokenKind::Lt => "<".to_string(),
            TokenKind::Lte => "<=".to_string(),
            TokenKind::EqEq => "==".to_string(),
            TokenKind::Neq => "!=".to_string(),
            TokenKind::And => "&&".to_string(),
            TokenKind::Or => "||".to_string(),
            TokenKind::Not => "!".to_string(),
            TokenKind::Newline => "newline".to_string(),
            TokenKind::Eof => "eof".to_string(),
        }
    }

    fn fail(&self, message: &str) -> SyntaxError {
        let tok = self.current();
        SyntaxError {
            message: message.to_string(),
            line: tok.line,
            col: tok.col,
        }
    }
}

pub fn parse(source: &str) -> Result<Vec<Statement>, SyntaxError> {
    let tokens = tokenize(source)?;
    let mut parser = Parser::new(tokens);
    parser.parse_program()
}
