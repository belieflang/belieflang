(() => {
  const samples = {
    intent: `let threshold = 0.7

belief intent exclusive closed {
  book_flight: 0.82
  book_hotel: 0.12
  unknown: 0.06
}

belief user multi closed {
  budget_sensitive: 0.91
  prefers_direct: 0.84
}

let flights = call search_flights()

when confidence(intent.book_flight) > threshold && user.prefers_direct > 0.5:
  call rank_flights()

when flights.count > 0 || entropy(intent) > 0.6:
  ask_user("I found flight options.")`,
    noFlight: `belief intent exclusive open {
  book_flight: 0.28
  book_hotel: 0.57
}

belief user multi closed {
  budget_sensitive: 0.91
  prefers_direct: 0.84
}

when confidence(intent.book_flight) > 0.7 && user.prefers_direct > 0.6:
  call search_flights()

when entropy(intent) > 0.4 || confidence(intent.other) > 0.1:
  ask_user("What exactly do you want to book?")`,
    dynamic: `let message = "I need a cheap direct flight to Berlin"

observe user_message(message)
infer beliefs from user_message

let extracted = call extract_patch()
merge beliefs from extracted

when confidence(intent.book_flight) > 0.7 && confidence(user.budget_sensitive) > 0.5:
  call rank_flights()

when entropy(intent) > 0.5:
  ask_user("Can you clarify your travel intent?")`,
  };

  const comparisonKinds = new Set([">", ">=", "<", "<=", "==", "!="]);
  const epsilon = 1e-9;

  function isDigit(char) {
    return char >= "0" && char <= "9";
  }

  function isIdentifierStart(char) {
    return (
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      char === "_"
    );
  }

  function isIdentifierPart(char) {
    return isIdentifierStart(char) || isDigit(char);
  }

  function syntaxError(message, line, col) {
    return new SyntaxError(`${message} at ${line}:${col}`);
  }

  function tokenize(source) {
    const tokens = [];
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
        let value = "";
        let closed = false;
        i += 1;
        col += 1;

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

        tokens.push({ kind: "number", value: raw, line: tokenLine, col: tokenCol });
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
      if ([">=", "<=", "==", "!=", "&&", "||"].includes(twoChar)) {
        tokens.push({ kind: twoChar, line, col });
        i += 2;
        col += 2;
        continue;
      }

      if ("{}():.=><!".includes(char)) {
        tokens.push({ kind: char, line, col });
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
    constructor(tokens) {
      this.tokens = tokens;
      this.index = 0;
    }

    parseProgram() {
      const statements = [];
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

    parseStatement() {
      if (this.isKeyword("belief")) return this.parseBelief();
      if (this.isKeyword("let")) return this.parseLet();
      if (this.isKeyword("observe")) return this.parseObserve();
      if (this.isKeyword("infer")) return this.parseInfer();
      if (this.isKeyword("merge")) return this.parseMergeBeliefs();
      if (this.isKeyword("when")) return this.parseRule();
      this.fail(`Unexpected token '${this.current().kind}'`);
    }

    parseBelief() {
      this.expectKeyword("belief");
      const name = this.expectIdentifier();
      let cardinality = "exclusive";
      let domain = "closed";
      let cardinalitySet = false;
      let domainSet = false;

      while (this.current().kind === "identifier") {
        const modifier = this.current().value;

        if (modifier === "exclusive" || modifier === "multi") {
          if (cardinalitySet) this.fail("Belief cardinality already declared");
          cardinality = modifier;
          cardinalitySet = true;
          this.advance();
          continue;
        }

        if (modifier === "open" || modifier === "closed") {
          if (domainSet) this.fail("Belief domain already declared");
          domain = modifier;
          domainSet = true;
          this.advance();
          continue;
        }

        break;
      }

      this.expect("{");
      this.consumeNewlines();

      const values = {};
      while (!this.is("}")) {
        const key = this.expectIdentifier();
        this.expect(":");
        values[key] = this.expectNumber();

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

    parseLet() {
      this.expectKeyword("let");
      const name = this.expectIdentifier();
      this.expect("=");
      return {
        kind: "let",
        name,
        value: this.parseValueExpression({
          allowCallExpression: true,
          allowMetric: true,
        }),
      };
    }

    parseObserve() {
      this.expectKeyword("observe");
      const eventName = this.expectIdentifier();
      this.expect("(");
      const value = this.is(")")
        ? undefined
        : this.parseValueExpression({
            allowCallExpression: true,
            allowMetric: true,
          });
      this.expect(")");
      return { kind: "observe", eventName, value };
    }

    parseInfer() {
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

    parseMergeBeliefs() {
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

    parseRule() {
      this.expectKeyword("when");
      const condition = this.parseConditionExpression();
      this.expect(":");
      this.requireAtLeastOneNewline();
      this.consumeNewlines();
      return {
        kind: "rule",
        condition,
        action: this.parseAction(),
      };
    }

    parseAction() {
      if (this.isKeyword("call")) {
        return { kind: "call", toolName: this.parseToolInvocationFromCallKeyword() };
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
        return {
          kind: "assign_call",
          variableName,
          toolName: this.parseToolInvocationFromCallKeyword(),
        };
      }

      this.fail("Invalid rule action");
    }

    parseToolInvocationFromCallKeyword() {
      this.expectKeyword("call");
      const toolName = this.expectIdentifier();
      this.expect("(");
      this.expect(")");
      return toolName;
    }

    parseConditionExpression() {
      return this.parseOrCondition();
    }

    parseOrCondition() {
      let left = this.parseAndCondition();

      while (this.match("||")) {
        left = { kind: "or", left, right: this.parseAndCondition() };
      }

      return left;
    }

    parseAndCondition() {
      let left = this.parseNotCondition();

      while (this.match("&&")) {
        left = { kind: "and", left, right: this.parseNotCondition() };
      }

      return left;
    }

    parseNotCondition() {
      if (this.match("!")) {
        return { kind: "not", expr: this.parseNotCondition() };
      }

      return this.parseConditionPrimary();
    }

    parseConditionPrimary() {
      if (this.match("(")) {
        const expression = this.parseConditionExpression();
        this.expect(")");
        return expression;
      }

      return this.parseComparisonOrTruthy();
    }

    parseComparisonOrTruthy() {
      const left = this.parseValueExpression({
        allowCallExpression: false,
        allowMetric: true,
      });

      if (comparisonKinds.has(this.current().kind)) {
        const opToken = this.advance();
        return {
          kind: "comparison",
          left,
          op: opToken.kind,
          right: this.parseValueExpression({
            allowCallExpression: false,
            allowMetric: true,
          }),
        };
      }

      return { kind: "truthy", expr: left };
    }

    parseValueExpression(options) {
      const token = this.current();

      if (token.kind === "number") {
        this.advance();
        return { kind: "number", value: Number(token.value) };
      }

      if (token.kind === "string") {
        this.advance();
        return { kind: "string", value: token.value || "" };
      }

      if (token.kind === "identifier") {
        const value = token.value || "";

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
          return { kind: "metric", fn: value, arg };
        }

        if (options.allowCallExpression && value === "call") {
          return {
            kind: "call_expr",
            toolName: this.parseToolInvocationFromCallKeyword(),
          };
        }

        return { kind: "identifier", name: this.parsePath() };
      }

      this.fail("Invalid value expression");
    }

    parsePath() {
      const parts = [this.expectIdentifier()];
      while (this.match(".")) {
        parts.push(this.expectIdentifier());
      }
      return parts.join(".");
    }

    consumeNewlines() {
      while (this.match("newline")) {
        // Skip blank lines.
      }
    }

    requireAtLeastOneNewline() {
      if (!this.match("newline")) {
        this.fail("Expected newline");
      }
    }

    is(kind) {
      return this.current().kind === kind;
    }

    current() {
      return this.tokens[this.index] || this.tokens[this.tokens.length - 1];
    }

    peek(offset = 1) {
      return this.tokens[this.index + offset] || this.tokens[this.tokens.length - 1];
    }

    advance() {
      const token = this.current();
      this.index += 1;
      return token;
    }

    match(kind) {
      if (this.current().kind !== kind) return false;
      this.index += 1;
      return true;
    }

    expect(kind) {
      const token = this.current();
      if (token.kind !== kind) {
        this.fail(`Expected '${kind}', got '${token.kind}'`, token);
      }
      this.index += 1;
      return token;
    }

    isKeyword(keyword) {
      const token = this.current();
      return token.kind === "identifier" && token.value === keyword;
    }

    expectKeyword(keyword) {
      const token = this.current();
      if (token.kind !== "identifier" || token.value !== keyword) {
        this.fail(`Expected keyword '${keyword}'`, token);
      }
      this.index += 1;
    }

    expectIdentifier() {
      const token = this.current();
      if (token.kind !== "identifier") {
        this.fail("Expected identifier", token);
      }
      this.index += 1;
      return token.value || "";
    }

    expectNumber() {
      const token = this.current();
      if (token.kind !== "number") {
        this.fail("Expected number", token);
      }
      this.index += 1;
      return Number(token.value);
    }

    expectString() {
      const token = this.current();
      if (token.kind !== "string") {
        this.fail("Expected string", token);
      }
      this.index += 1;
      return token.value || "";
    }

    fail(message, token = this.current()) {
      throw syntaxError(message, token.line, token.col);
    }
  }

  function parse(source) {
    return new Parser(tokenize(source)).parseProgram();
  }

  class PlaygroundRuntime {
    constructor(options = {}) {
      this.state = {};
      this.vars = {};
      this.beliefMeta = {};
      this.observations = [];
      this.trace = Boolean(options.trace);
      this.traceLines = [];
      this.actions = [];
      this.nextObservationId = 1;
      this.tools = {
        search_flights: () => ({ count: 3, best_price: 214, currency: "EUR" }),
        search_hotels: () => ({ count: 5, best_price: 88, currency: "EUR" }),
        extract_patch: () => ({
          intent: {
            cardinality: "exclusive",
            domain: "closed",
            values: {
              book_flight: 0.92,
              book_hotel: 0.08,
            },
          },
          user: {
            cardinality: "multi",
            domain: "closed",
            values: {
              budget_sensitive: 0.86,
              prefers_direct: 0.88,
            },
          },
        }),
        rank_flights: () => {
          this.actions.push("[tool] rank_flights()");
          return null;
        },
      };
    }

    loadBelief(block) {
      this.setBelief(block.name, block.values, block.cardinality, block.domain, {
        clampMulti: false,
      });
    }

    async assign(name, expression) {
      this.vars[name] = await this.evalValue(expression);
    }

    async evalValue(expression) {
      if (expression.kind === "number" || expression.kind === "string" || expression.kind === "boolean") {
        return expression.value;
      }

      if (expression.kind === "identifier") {
        return this.resolvePath(expression.name);
      }

      if (expression.kind === "metric") {
        return expression.fn === "confidence"
          ? this.confidence(expression.arg)
          : this.entropy(expression.arg);
      }

      if (expression.kind === "call_expr") {
        return await this.callTool(expression.toolName);
      }

      throw new Error(`Unsupported value expression ${expression.kind}`);
    }

    resolvePath(path) {
      const [root, ...parts] = path.split(".");
      let value = this.vars[root];

      if (value === undefined && this.state[root]) {
        value = this.state[root];
      }

      if (value === undefined) {
        throw new Error(`unknown reference ${path}`);
      }

      for (const part of parts) {
        if (value === null || typeof value !== "object" || Array.isArray(value)) {
          throw new Error(`cannot access ${part} on non-object reference ${path}`);
        }

        value = value[part];
        if (value === undefined) {
          throw new Error(`unknown property ${part} in reference ${path}`);
        }
      }

      return value;
    }

    confidence(path) {
      const [beliefName, key, ...rest] = path.split(".");

      if (!beliefName || !key || rest.length > 0) {
        throw new Error(`confidence() expects name.key, got ${path}`);
      }

      const belief = this.state[beliefName];
      if (!belief) return 0;

      if (belief[key] !== undefined) return belief[key];

      const meta = this.beliefMeta[beliefName];
      if (
        meta &&
        meta.cardinality === "exclusive" &&
        meta.domain === "open" &&
        key === "other"
      ) {
        return meta.openMass;
      }

      return 0;
    }

    entropy(beliefName) {
      const belief = this.state[beliefName];
      const meta = this.beliefMeta[beliefName];

      if (!belief || !meta) {
        throw new Error(`unknown belief ${beliefName}`);
      }

      if (meta.cardinality === "exclusive") {
        const probs = Object.values(belief).filter((p) => p > 0);
        if (meta.domain === "open" && meta.openMass > 0) {
          probs.push(meta.openMass);
        }
        if (probs.length <= 1) return 0;
        const raw = -probs.reduce((sum, p) => sum + p * Math.log2(p), 0);
        return raw / Math.log2(probs.length);
      }

      const probs = Object.values(belief);
      if (probs.length === 0) return 0;
      return probs.reduce((sum, p) => sum + this.binaryEntropy(p), 0) / probs.length;
    }

    binaryEntropy(probability) {
      if (probability <= 0 || probability >= 1) return 0;
      return (
        -probability * Math.log2(probability) -
        (1 - probability) * Math.log2(1 - probability)
      );
    }

    setBelief(beliefName, values, cardinality, domain, options) {
      const normalized = this.normalizeBelief(
        beliefName,
        values,
        cardinality,
        domain,
        options,
      );

      this.state[beliefName] = normalized.values;
      this.beliefMeta[beliefName] = {
        cardinality,
        domain,
        openMass: normalized.openMass,
      };
    }

    normalizeBelief(beliefName, values, cardinality, domain, options) {
      const entries = Object.entries(values);
      if (entries.length === 0) {
        throw new Error(`belief ${beliefName} has no values`);
      }

      if (cardinality === "multi") {
        const normalizedEntries = [];

        for (const [label, rawValue] of entries) {
          if (!Number.isFinite(rawValue)) {
            throw new Error(`belief ${beliefName}.${label} must be finite`);
          }

          let value = rawValue;
          if (options.clampMulti) {
            value = Math.max(0, Math.min(1, rawValue));
            if (Math.abs(value - rawValue) > epsilon) {
              this.logTrace(
                `clamped ${beliefName}.${label} from ${rawValue.toFixed(3)} to ${value.toFixed(3)}`,
              );
            }
          } else if (value < 0 || value > 1 + epsilon) {
            throw new Error(`belief ${beliefName}.${label} must be in [0, 1] for multi beliefs`);
          }

          normalizedEntries.push([label, value]);
        }

        return { values: Object.fromEntries(normalizedEntries), openMass: 0 };
      }

      for (const [label, value] of entries) {
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`belief ${beliefName}.${label} must be a non-negative number`);
        }
      }

      const total = entries.reduce((sum, [, value]) => sum + value, 0);
      if (total <= 0) {
        throw new Error(`belief ${beliefName} has non-positive probability mass`);
      }

      if (domain === "closed") {
        return {
          values: Object.fromEntries(entries.map(([label, value]) => [label, value / total])),
          openMass: 0,
        };
      }

      if (total > 1 + epsilon) {
        throw new Error(`belief ${beliefName} is open+exclusive and cannot exceed total mass 1.0`);
      }

      return { values: Object.fromEntries(entries), openMass: Math.max(0, 1 - total) };
    }

    async executeObserve(statement) {
      const observedValue = statement.value ? await this.evalValue(statement.value) : null;
      const observation = {
        id: this.nextObservationId,
        eventName: statement.eventName,
        value: observedValue,
      };

      this.nextObservationId += 1;
      this.observations.push(observation);

      if (statement.value) {
        this.vars[statement.eventName] = observedValue;
      }

      this.logTrace(`observe ${statement.eventName}=${this.formatValue(observedValue)}`);
    }

    async executeInfer(statement) {
      const sourceValue = await this.evalValue(statement.source);
      const patch = this.defaultInferBeliefs(sourceValue);
      this.logTrace(`infer beliefs from ${this.describeValueExpression(statement.source)}`);
      this.mergeBeliefPatch(this.asBeliefPatch(patch));
    }

    async executeMergeBeliefs(statement) {
      const sourceValue = await this.evalValue(statement.source);
      this.logTrace(`merge beliefs from ${this.describeValueExpression(statement.source)}`);
      this.mergeBeliefPatch(this.asBeliefPatch(sourceValue));
    }

    defaultInferBeliefs(source) {
      if (typeof source !== "string") return {};

      const text = source.toLowerCase();
      const intentValues = {};

      if (text.includes("flight")) intentValues.book_flight = 0.85;
      if (text.includes("hotel")) intentValues.book_hotel = 0.85;
      if (Object.keys(intentValues).length === 0) intentValues.unknown = 1;

      const patch = {
        intent: {
          cardinality: "exclusive",
          domain: "closed",
          values: intentValues,
        },
      };

      const userValues = {};
      if (text.includes("cheap")) userValues.budget_sensitive = 0.9;
      if (text.includes("direct")) userValues.prefers_direct = 0.85;

      if (Object.keys(userValues).length > 0) {
        patch.user = {
          cardinality: "multi",
          domain: "closed",
          values: userValues,
        };
      }

      return patch;
    }

    coercePatchEntry(beliefName, entry) {
      if (
        Object.prototype.hasOwnProperty.call(entry, "values") &&
        entry.values &&
        typeof entry.values === "object" &&
        !Array.isArray(entry.values)
      ) {
        const cardinality = entry.cardinality;
        const domain = entry.domain;

        if (cardinality !== undefined && cardinality !== "exclusive" && cardinality !== "multi") {
          throw new Error(`invalid cardinality '${String(cardinality)}' for belief ${beliefName}`);
        }

        if (domain !== undefined && domain !== "open" && domain !== "closed") {
          throw new Error(`invalid domain '${String(domain)}' for belief ${beliefName}`);
        }

        return {
          values: this.asBeliefDistribution(entry.values, beliefName),
          cardinality,
          domain,
        };
      }

      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`belief patch for ${beliefName} must be an object`);
      }

      return { values: this.asBeliefDistribution(entry, beliefName) };
    }

    asBeliefDistribution(source, beliefName) {
      const entries = Object.entries(source);
      if (entries.length === 0) {
        throw new Error(`belief patch for ${beliefName} has no values`);
      }

      const values = {};
      for (const [label, rawValue] of entries) {
        if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
          throw new Error(`belief patch ${beliefName}.${label} must be a finite number`);
        }
        values[label] = rawValue;
      }
      return values;
    }

    asBeliefPatch(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("merge/infer source must evaluate to an object");
      }

      const patch = {};
      for (const [beliefName, rawEntry] of Object.entries(value)) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
          throw new Error(`belief patch entry '${beliefName}' must be an object`);
        }
        patch[beliefName] = this.coercePatchEntry(beliefName, rawEntry);
      }
      return patch;
    }

    mergeBeliefPatch(patch) {
      for (const [beliefName, patchEntry] of Object.entries(patch)) {
        const entry = this.coercePatchEntry(beliefName, patchEntry);
        const currentMeta = this.beliefMeta[beliefName] || {
          cardinality: "exclusive",
          domain: "closed",
          openMass: 0,
        };
        const cardinality = entry.cardinality || currentMeta.cardinality;
        const domain = entry.domain || currentMeta.domain;
        const mergedValues = {
          ...(this.state[beliefName] || {}),
          ...entry.values,
        };

        this.setBelief(beliefName, mergedValues, cardinality, domain, {
          clampMulti: true,
        });
      }
    }

    async evalCondition(rule, index) {
      const lines = [];
      const result = await this.evalConditionExpression(rule.condition, lines);
      this.logTrace(`rule ${index + 1} when ${this.describeCondition(rule.condition)} => ${result}`);
      for (const line of lines) {
        this.logTrace(`  ${line}`);
      }
      return result;
    }

    async evalConditionExpression(expression, traceLines) {
      if (expression.kind === "comparison") {
        const left = await this.evalValue(expression.left);
        const right = await this.evalValue(expression.right);
        const result = this.compareValues(left, expression.op, right);
        traceLines.push(
          `${this.describeValueExpression(expression.left)}=${this.formatValue(left)} ${expression.op} ${this.describeValueExpression(expression.right)}=${this.formatValue(right)} -> ${result}`,
        );
        return result;
      }

      if (expression.kind === "truthy") {
        const value = await this.evalValue(expression.expr);
        const result = this.toBoolean(value);
        traceLines.push(`${this.describeValueExpression(expression.expr)}=${this.formatValue(value)} -> ${result}`);
        return result;
      }

      if (expression.kind === "not") {
        const result = !(await this.evalConditionExpression(expression.expr, traceLines));
        traceLines.push(`not -> ${result}`);
        return result;
      }

      if (expression.kind === "and") {
        const left = await this.evalConditionExpression(expression.left, traceLines);
        if (!left) {
          traceLines.push("and short-circuit -> false");
          return false;
        }
        const right = await this.evalConditionExpression(expression.right, traceLines);
        const result = left && right;
        traceLines.push(`and -> ${result}`);
        return result;
      }

      if (expression.kind === "or") {
        const left = await this.evalConditionExpression(expression.left, traceLines);
        if (left) {
          traceLines.push("or short-circuit -> true");
          return true;
        }
        const right = await this.evalConditionExpression(expression.right, traceLines);
        const result = left || right;
        traceLines.push(`or -> ${result}`);
        return result;
      }

      throw new Error(`Unsupported condition ${expression.kind}`);
    }

    compareValues(left, op, right) {
      if (op === "==") return left === right;
      if (op === "!=") return left !== right;

      const leftNumber = Number(left);
      const rightNumber = Number(right);

      if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
        throw new Error(`Operator ${op} requires numeric operands`);
      }

      if (op === ">") return leftNumber > rightNumber;
      if (op === ">=") return leftNumber >= rightNumber;
      if (op === "<") return leftNumber < rightNumber;
      if (op === "<=") return leftNumber <= rightNumber;
      throw new Error(`Unsupported operator ${op}`);
    }

    toBoolean(value) {
      if (value === null) return false;
      if (typeof value === "boolean") return value;
      if (typeof value === "number") return value !== 0;
      if (typeof value === "string") return value.length > 0;
      if (Array.isArray(value)) return value.length > 0;
      return Object.keys(value).length > 0;
    }

    async callTool(toolName) {
      this.logTrace(`call ${toolName}()`);
      const tool = this.tools[toolName];

      if (!tool) {
        this.actions.push(`[call] ${toolName}()`);
        return null;
      }

      return await tool();
    }

    async executeAction(action) {
      this.logTrace(`action ${this.describeAction(action)}`);

      if (action.kind === "ask_user") {
        this.actions.push(`[ask_user] ${action.message}`);
        return;
      }

      if (action.kind === "assign_call") {
        this.vars[action.variableName] = await this.callTool(action.toolName);
        this.logTrace(`assigned ${action.variableName}=${this.formatValue(this.vars[action.variableName])}`);
        return;
      }

      await this.callTool(action.toolName);
    }

    async run(statements) {
      const rules = [];

      for (const statement of statements) {
        if (statement.kind === "belief") {
          this.loadBelief(statement);
        } else if (statement.kind === "let") {
          await this.assign(statement.name, statement.value);
        } else if (statement.kind === "observe") {
          await this.executeObserve(statement);
        } else if (statement.kind === "infer") {
          await this.executeInfer(statement);
        } else if (statement.kind === "merge_beliefs") {
          await this.executeMergeBeliefs(statement);
        } else {
          rules.push(statement);
        }
      }

      for (let i = 0; i < rules.length; i += 1) {
        if (await this.evalCondition(rules[i], i)) {
          await this.executeAction(rules[i].action);
        }
      }
    }

    describeValueExpression(expression) {
      if (expression.kind === "number") return String(expression.value);
      if (expression.kind === "string") return JSON.stringify(expression.value);
      if (expression.kind === "boolean") return String(expression.value);
      if (expression.kind === "identifier") return expression.name;
      if (expression.kind === "metric") return `${expression.fn}(${expression.arg})`;
      if (expression.kind === "call_expr") return `call ${expression.toolName}()`;
      return expression.kind;
    }

    describeCondition(expression) {
      if (expression.kind === "comparison") {
        return `${this.describeValueExpression(expression.left)} ${expression.op} ${this.describeValueExpression(expression.right)}`;
      }
      if (expression.kind === "truthy") return this.describeValueExpression(expression.expr);
      if (expression.kind === "not") return `!(${this.describeCondition(expression.expr)})`;
      if (expression.kind === "and") {
        return `(${this.describeCondition(expression.left)} && ${this.describeCondition(expression.right)})`;
      }
      if (expression.kind === "or") {
        return `(${this.describeCondition(expression.left)} || ${this.describeCondition(expression.right)})`;
      }
      return expression.kind;
    }

    describeAction(action) {
      if (action.kind === "call") return `call ${action.toolName}()`;
      if (action.kind === "ask_user") return `ask_user(${JSON.stringify(action.message)})`;
      return `let ${action.variableName} = call ${action.toolName}()`;
    }

    formatValue(value) {
      if (typeof value === "number") {
        return Number.isInteger(value) ? String(value) : value.toFixed(3);
      }
      if (typeof value === "string") return JSON.stringify(value);
      if (typeof value === "boolean" || value === null) return String(value);
      return JSON.stringify(value);
    }

    logTrace(message) {
      if (this.trace) {
        this.traceLines.push(`[trace] ${message}`);
      }
    }
  }

  function formatState(runtime) {
    const lines = [];
    for (const [name, dist] of Object.entries(runtime.state)) {
      const meta = runtime.beliefMeta[name];
      const values = Object.entries(dist)
        .map(([key, value]) => `${key}=${value.toFixed(3)}`)
        .join(", ");
      const openOther =
        meta && meta.cardinality === "exclusive" && meta.domain === "open" && meta.openMass > 0
          ? `, other=${meta.openMass.toFixed(3)}`
          : "";
      const label = meta ? `${name} [${meta.cardinality}/${meta.domain}]` : name;
      lines.push(`${label}: ${values}${openOther}`);
    }
    return lines.join("\n") || "No beliefs loaded.";
  }

  function formatObject(value, emptyText) {
    if (!value || Object.keys(value).length === 0) return emptyText;
    return JSON.stringify(value, null, 2);
  }

  function formatObservations(observations) {
    if (observations.length === 0) return "No observations yet.";
    return observations
      .map((observation) => `${observation.id} ${observation.eventName}: ${JSON.stringify(observation.value)}`)
      .join("\n");
  }

  async function runProgram(source, options = {}) {
    const statements = parse(source);
    const runtime = new PlaygroundRuntime(options);
    await runtime.run(statements);
    return runtime;
  }

  function initPlayground() {
    const source = document.querySelector("#playground-source");
    const sample = document.querySelector("#playground-sample");
    const runButton = document.querySelector("#playground-run");
    const traceToggle = document.querySelector("#playground-trace");
    const errorBox = document.querySelector("#playground-error");
    const stateOutput = document.querySelector("#playground-state-output");
    const varsOutput = document.querySelector("#playground-vars-output");
    const observationsOutput = document.querySelector("#playground-observations-output");
    const actionsOutput = document.querySelector("#playground-actions-output");
    const traceOutput = document.querySelector("#playground-trace-output");

    if (!source || !sample || !runButton) return;

    let programmaticChange = false;

    function setSource(value) {
      programmaticChange = true;
      source.value = value;
      programmaticChange = false;
    }

    function setError(message) {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || "";
    }

    function renderRuntime(runtime) {
      stateOutput.textContent = formatState(runtime);
      varsOutput.textContent = formatObject(runtime.vars, "No variables assigned.");
      observationsOutput.textContent = formatObservations(runtime.observations);
      actionsOutput.textContent = runtime.actions.join("\n") || "No actions fired.";
      traceOutput.textContent = runtime.traceLines.join("\n") || "Trace is off or no trace lines were emitted.";
    }

    async function execute() {
      setError("");
      runButton.disabled = true;
      runButton.textContent = "Running";

      try {
        const runtime = await runProgram(source.value, {
          trace: traceToggle ? traceToggle.checked : false,
        });
        renderRuntime(runtime);
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      } finally {
        runButton.disabled = false;
        runButton.textContent = "Run";
      }
    }

    sample.addEventListener("change", () => {
      const selected = sample.value;
      if (samples[selected]) {
        setSource(samples[selected]);
        execute();
      }
    });

    source.addEventListener("input", () => {
      if (!programmaticChange) {
        sample.value = "custom";
      }
    });

    runButton.addEventListener("click", execute);
    if (traceToggle) {
      traceToggle.addEventListener("change", execute);
    }

    setSource(samples.intent);
    execute();
  }

  const api = { parse, PlaygroundRuntime, runProgram, samples };

  if (typeof window !== "undefined") {
    window.BeliefPlayground = api;
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", initPlayground);
    } else {
      initPlayground();
    }
  }
})();
