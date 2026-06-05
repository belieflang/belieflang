import type {
  Action,
  BeliefBlock,
  BeliefCardinality,
  BeliefDistribution,
  BeliefDomain,
  ConditionExpression,
  InferStatement,
  LetStatement,
  MergeBeliefsStatement,
  ObserveStatement,
  Operator,
  Rule,
  Statement,
  ValueExpression,
} from "./ast.js";

type TokenKind =
  | "identifier"
  | "number"
  | "string"
  | "{"
  | "}"
  | "("
  | ")"
  | ":"
  | "."
  | "="
  | ">"
  | ">="
  | "<"
  | "<="
  | "=="
  | "!="
  | "&&"
  | "||"
  | "!"
  | "newline"
  | "eof";

type Token = {
  kind: TokenKind;
  value?: string;
  line: number;
  col: number;
};

const COMPARISON_KINDS: readonly TokenKind[] = [
  ">",
  ">=",
  "<",
  "<=",
  "==",
  "!=",
];

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIdentifierStart(char: string): boolean {
  return (
    (char >= "A" && char <= "Z") ||
    (char >= "a" && char <= "z") ||
    char === "_"
  );
}

function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || isDigit(char);
}

function syntaxError(message: string, line: number, col: number): SyntaxError {
  return new SyntaxError(`${message} at ${line}:${col}`);
}

export function stripComments(source: string): string {
  return source
    .split("\n")
    .map((line) => line.split("#", 1)[0])
    .join("\n");
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;

  while (i < source.length) {
    const char = source[i];

    if (char === " " || char === "\t" || char === "\r") {
      i += 1;
      col += 1;
      continue;
    }

    if (char === "\n") {
      tokens.push({ kind: "newline", line, col });
      i += 1;
      line += 1;
      col = 1;
      continue;
    }

    if (char === "#") {
      while (i < source.length && source[i] !== "\n") {
        i += 1;
        col += 1;
      }
      continue;
    }

    if (char === '"') {
      const tokenLine = line;
      const tokenCol = col;
      i += 1;
      col += 1;

      let value = "";
      let closed = false;

      while (i < source.length) {
        const nextChar = source[i];

        if (nextChar === '"') {
          i += 1;
          col += 1;
          closed = true;
          break;
        }

        if (nextChar === "\\") {
          const escaped = source[i + 1];

          if (escaped === undefined) {
            throw syntaxError("Unterminated string literal", tokenLine, tokenCol);
          }

          if (escaped === "n") value += "\n";
          else if (escaped === "t") value += "\t";
          else if (escaped === '"') value += '"';
          else if (escaped === "\\") value += "\\";
          else value += escaped;

          i += 2;
          col += 2;
          continue;
        }

        if (nextChar === "\n") {
          throw syntaxError("Unterminated string literal", tokenLine, tokenCol);
        }

        value += nextChar;
        i += 1;
        col += 1;
      }

      if (!closed) {
        throw syntaxError("Unterminated string literal", tokenLine, tokenCol);
      }

      tokens.push({ kind: "string", value, line: tokenLine, col: tokenCol });
      continue;
    }

    if (isDigit(char)) {
      const tokenLine = line;
      const tokenCol = col;
      const start = i;

      while (i < source.length && isDigit(source[i])) {
        i += 1;
        col += 1;
      }

      if (source[i] === ".") {
        i += 1;
        col += 1;

        while (i < source.length && isDigit(source[i])) {
          i += 1;
          col += 1;
        }
      }

      const raw = source.slice(start, i);
      if (raw.endsWith(".")) {
        throw syntaxError(`Invalid number '${raw}'`, tokenLine, tokenCol);
      }

      tokens.push({
        kind: "number",
        value: raw,
        line: tokenLine,
        col: tokenCol,
      });
      continue;
    }

    if (isIdentifierStart(char)) {
      const tokenLine = line;
      const tokenCol = col;
      const start = i;

      i += 1;
      col += 1;

      while (i < source.length && isIdentifierPart(source[i])) {
        i += 1;
        col += 1;
      }

      tokens.push({
        kind: "identifier",
        value: source.slice(start, i),
        line: tokenLine,
        col: tokenCol,
      });
      continue;
    }

    const twoChar = source.slice(i, i + 2);
    if (
      twoChar === ">=" ||
      twoChar === "<=" ||
      twoChar === "==" ||
      twoChar === "!=" ||
      twoChar === "&&" ||
      twoChar === "||"
    ) {
      tokens.push({ kind: twoChar as TokenKind, line, col });
      i += 2;
      col += 2;
      continue;
    }

    if (
      char === "{" ||
      char === "}" ||
      char === "(" ||
      char === ")" ||
      char === ":" ||
      char === "." ||
      char === "=" ||
      char === ">" ||
      char === "<" ||
      char === "!"
    ) {
      tokens.push({ kind: char as TokenKind, line, col });
      i += 1;
      col += 1;
      continue;
    }

    throw syntaxError(`Unexpected character '${char}'`, line, col);
  }

  tokens.push({ kind: "eof", line, col });
  return tokens;
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parseProgram(): Statement[] {
    const statements: Statement[] = [];
    this.consumeNewlines();

    while (!this.is("eof")) {
      statements.push(this.parseStatement());
      this.consumeNewlines();
    }

    if (statements.length === 0) {
      this.fail("No BeliefLang statements found");
    }

    return statements;
  }

  private parseStatement(): Statement {
    if (this.isKeyword("belief")) return this.parseBelief();
    if (this.isKeyword("let")) return this.parseLet();
    if (this.isKeyword("observe")) return this.parseObserve();
    if (this.isKeyword("infer")) return this.parseInfer();
    if (this.isKeyword("merge")) return this.parseMergeBeliefs();
    if (this.isKeyword("when")) return this.parseRule();

    this.fail(`Unexpected token '${this.current().kind}'`);
  }

  private parseBelief(): BeliefBlock {
    this.expectKeyword("belief");

    const name = this.expectIdentifier();

    let cardinality: BeliefCardinality = "exclusive";
    let domain: BeliefDomain = "closed";
    let cardinalitySet = false;
    let domainSet = false;

    while (this.current().kind === "identifier") {
      const modifier = this.current().value;

      if (modifier === "exclusive" || modifier === "multi") {
        if (cardinalitySet) {
          this.fail("Belief cardinality already declared");
        }

        cardinality = modifier;
        cardinalitySet = true;
        this.advance();
        continue;
      }

      if (modifier === "open" || modifier === "closed") {
        if (domainSet) {
          this.fail("Belief domain already declared");
        }

        domain = modifier;
        domainSet = true;
        this.advance();
        continue;
      }

      break;
    }

    this.expect("{");
    this.consumeNewlines();

    const values: BeliefDistribution = {};

    while (!this.is("}")) {
      const key = this.expectIdentifier();
      this.expect(":");
      const value = this.expectNumber();
      values[key] = value;

      if (this.is("}")) break;
      this.requireAtLeastOneNewline();
      this.consumeNewlines();
    }

    this.expect("}");

    if (Object.keys(values).length === 0) {
      this.fail(`belief ${name} has no values`);
    }

    return { kind: "belief", name, cardinality, domain, values };
  }

  private parseLet(): LetStatement {
    this.expectKeyword("let");
    const name = this.expectIdentifier();
    this.expect("=");
    const value = this.parseValueExpression({
      allowCallExpression: true,
      allowMetric: true,
    });

    return { kind: "let", name, value };
  }

  private parseObserve(): ObserveStatement {
    this.expectKeyword("observe");
    const eventName = this.expectIdentifier();
    this.expect("(");

    let value: ValueExpression | undefined;
    if (!this.is(")")) {
      value = this.parseValueExpression({
        allowCallExpression: true,
        allowMetric: true,
      });
    }

    this.expect(")");

    return {
      kind: "observe",
      eventName,
      value,
    };
  }

  private parseInfer(): InferStatement {
    this.expectKeyword("infer");
    this.expectKeyword("beliefs");
    this.expectKeyword("from");

    return {
      kind: "infer",
      source: this.parseValueExpression({
        allowCallExpression: true,
        allowMetric: true,
      }),
    };
  }

  private parseMergeBeliefs(): MergeBeliefsStatement {
    this.expectKeyword("merge");
    this.expectKeyword("beliefs");
    this.expectKeyword("from");

    return {
      kind: "merge_beliefs",
      source: this.parseValueExpression({
        allowCallExpression: true,
        allowMetric: true,
      }),
    };
  }

  private parseRule(): Rule {
    this.expectKeyword("when");
    const condition = this.parseConditionExpression();
    this.expect(":");
    this.requireAtLeastOneNewline();
    this.consumeNewlines();
    const action = this.parseAction();

    return { kind: "rule", condition, action };
  }

  private parseAction(): Action {
    if (this.isKeyword("call")) {
      const toolName = this.parseToolInvocationFromCallKeyword();
      return { kind: "call", toolName };
    }

    if (this.isKeyword("ask_user")) {
      this.expectKeyword("ask_user");
      this.expect("(");
      const message = this.expectString();
      this.expect(")");
      return { kind: "ask_user", message };
    }

    if (this.isKeyword("let")) {
      this.expectKeyword("let");
      const variableName = this.expectIdentifier();
      this.expect("=");
      const toolName = this.parseToolInvocationFromCallKeyword();

      return {
        kind: "assign_call",
        variableName,
        toolName,
      };
    }

    this.fail("Invalid rule action");
  }

  private parseToolInvocationFromCallKeyword(): string {
    this.expectKeyword("call");
    const toolName = this.expectIdentifier();
    this.expect("(");
    this.expect(")");
    return toolName;
  }

  private parseConditionExpression(): ConditionExpression {
    return this.parseOrCondition();
  }

  private parseOrCondition(): ConditionExpression {
    let left = this.parseAndCondition();

    while (this.match("||")) {
      const right = this.parseAndCondition();
      left = { kind: "or", left, right };
    }

    return left;
  }

  private parseAndCondition(): ConditionExpression {
    let left = this.parseNotCondition();

    while (this.match("&&")) {
      const right = this.parseNotCondition();
      left = { kind: "and", left, right };
    }

    return left;
  }

  private parseNotCondition(): ConditionExpression {
    if (this.match("!")) {
      return {
        kind: "not",
        expr: this.parseNotCondition(),
      };
    }

    return this.parseConditionPrimary();
  }

  private parseConditionPrimary(): ConditionExpression {
    if (this.match("(")) {
      const expression = this.parseConditionExpression();
      this.expect(")");
      return expression;
    }

    return this.parseComparisonOrTruthy();
  }

  private parseComparisonOrTruthy(): ConditionExpression {
    const left = this.parseValueExpression({
      allowCallExpression: false,
      allowMetric: true,
    });

    if (COMPARISON_KINDS.includes(this.current().kind)) {
      const opToken = this.advance();
      const right = this.parseValueExpression({
        allowCallExpression: false,
        allowMetric: true,
      });

      return {
        kind: "comparison",
        left,
        op: opToken.kind as Operator,
        right,
      };
    }

    return { kind: "truthy", expr: left };
  }

  private parseValueExpression(options: {
    allowCallExpression: boolean;
    allowMetric: boolean;
  }): ValueExpression {
    const token = this.current();

    if (token.kind === "number") {
      this.advance();
      return { kind: "number", value: Number(token.value) };
    }

    if (token.kind === "string") {
      this.advance();
      return { kind: "string", value: token.value ?? "" };
    }

    if (token.kind === "identifier") {
      const value = token.value ?? "";

      if (value === "true" || value === "false") {
        this.advance();
        return { kind: "boolean", value: value === "true" };
      }

      if (
        options.allowMetric &&
        (value === "confidence" || value === "entropy") &&
        this.peek().kind === "("
      ) {
        this.advance();
        this.expect("(");
        const arg = this.parsePath();
        this.expect(")");

        return {
          kind: "metric",
          fn: value,
          arg,
        };
      }

      if (options.allowCallExpression && value === "call") {
        const toolName = this.parseToolInvocationFromCallKeyword();
        return { kind: "call_expr", toolName };
      }

      return { kind: "identifier", name: this.parsePath() };
    }

    this.fail("Invalid value expression");
  }

  private parsePath(): string {
    const parts = [this.expectIdentifier()];

    while (this.match(".")) {
      parts.push(this.expectIdentifier());
    }

    return parts.join(".");
  }

  private consumeNewlines(): void {
    while (this.match("newline")) {
      // Skip blank lines.
    }
  }

  private requireAtLeastOneNewline(): void {
    if (!this.match("newline")) {
      this.fail("Expected newline");
    }
  }

  private is(kind: TokenKind): boolean {
    return this.current().kind === kind;
  }

  private current(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1];
  }

  private peek(offset = 1): Token {
    return this.tokens[this.index + offset] ?? this.tokens[this.tokens.length - 1];
  }

  private advance(): Token {
    const token = this.current();
    this.index += 1;
    return token;
  }

  private match(kind: TokenKind): boolean {
    if (this.current().kind !== kind) return false;
    this.index += 1;
    return true;
  }

  private expect(kind: TokenKind): Token {
    const token = this.current();

    if (token.kind !== kind) {
      this.fail(`Expected '${kind}', got '${token.kind}'`, token);
    }

    this.index += 1;
    return token;
  }

  private isKeyword(keyword: string): boolean {
    const token = this.current();
    return token.kind === "identifier" && token.value === keyword;
  }

  private expectKeyword(keyword: string): void {
    const token = this.current();

    if (token.kind !== "identifier" || token.value !== keyword) {
      this.fail(`Expected keyword '${keyword}'`, token);
    }

    this.index += 1;
  }

  private expectIdentifier(): string {
    const token = this.current();

    if (token.kind !== "identifier") {
      this.fail("Expected identifier", token);
    }

    this.index += 1;
    return token.value ?? "";
  }

  private expectNumber(): number {
    const token = this.current();

    if (token.kind !== "number") {
      this.fail("Expected number", token);
    }

    this.index += 1;
    return Number(token.value);
  }

  private expectString(): string {
    const token = this.current();

    if (token.kind !== "string") {
      this.fail("Expected string", token);
    }

    this.index += 1;
    return token.value ?? "";
  }

  private fail(message: string, token = this.current()): never {
    throw syntaxError(message, token.line, token.col);
  }
}

export function parse(source: string): Statement[] {
  const tokens = tokenize(source);
  return new Parser(tokens).parseProgram();
}
