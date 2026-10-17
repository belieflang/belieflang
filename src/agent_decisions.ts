import type {
  FactSource,
  FactValue,
  FactView,
  SourceRef,
} from "./fact_memory.js";
export type Approval = {
  action: string;
  allowed: boolean;
  source: SourceRef;
  expiresAfterTurn?: number;
  scope: Record<string, { revision: number; value?: FactValue }>;
};
export type Decision = {
  allowed: boolean;
  reason: string;
  sources: SourceRef[];
};
/** This host-controlled guard is intentionally reusable by an ordinary JSON object baseline. */
export class AgentDecisionGuard {
  private approvals: Approval[] = [];
  record(
    view: FactView,
    action: string,
    allowed: boolean,
    fields: string[],
    source: FactSource,
    expiresAfterTurn?: number,
  ): void {
    if (
      typeof action !== "string" ||
      !action.trim() ||
      typeof allowed !== "boolean" ||
      !Number.isSafeInteger(source.turn) ||
      source.turn < 1 ||
      typeof source.id !== "string" ||
      !/^[a-zA-Z0-9:_-]{1,128}$/.test(source.id) ||
      !fields.length ||
      fields.some((f) => typeof f !== "string" || !f) ||
      new Set(fields).size !== fields.length ||
      (expiresAfterTurn !== undefined &&
        (!Number.isSafeInteger(expiresAfterTurn) ||
          expiresAfterTurn < source.turn))
    )
      throw new Error("invalid host approval");
    const previous = this.approvals.filter((a) => a.action === action).at(-1);
    if (previous && source.turn <= previous.source.turn)
      throw new Error("approval events must increase");
    const current = view.current;
    this.approvals.push({
      action,
      allowed,
      source: { id: source.id, turn: source.turn },
      expiresAfterTurn,
      scope: Object.fromEntries(
        fields.map((field) => [
          field,
          {
            revision: Object.hasOwn(current, field)
              ? current[field].revision
              : -1,
            value: Object.hasOwn(current, field)
              ? current[field].value
              : undefined,
          },
        ]),
      ),
    });
  }
  explain(
    view: FactView,
    action: string,
    parameters: Record<string, FactValue>,
    turn: number,
  ): Decision {
    if (!Number.isSafeInteger(turn) || turn < 1)
      throw new Error("invalid decision turn");
    const approval = this.approvals.filter((a) => a.action === action).at(-1);
    if (!approval)
      return { allowed: false, reason: "approval_missing", sources: [] };
    const sources = [{ ...approval.source }];
    const denied = (reason: string) => ({ allowed: false, reason, sources });
    if (!approval.allowed) return denied("approval_revoked");
    if (
      turn < approval.source.turn ||
      (approval.expiresAfterTurn !== undefined &&
        turn > approval.expiresAfterTurn)
    )
      return denied("approval_expired_or_future");
    if (
      !parameters ||
      typeof parameters !== "object" ||
      Array.isArray(parameters)
    )
      return denied("invalid_parameters");
    if (Object.keys(parameters).length !== Object.keys(approval.scope).length)
      return denied("scope_mismatch");
    const current = view.current;
    for (const [field, scope] of Object.entries(approval.scope)) {
      const cell = Object.hasOwn(current, field) ? current[field] : undefined;
      if (cell?.source) sources.push({ ...cell.source });
      if (!cell || cell.status !== "confirmed")
        return denied(`fact_not_confirmed:${field}`);
      if (
        !["string", "number", "boolean"].includes(typeof cell.value) ||
        (typeof cell.value === "number" && !Number.isFinite(cell.value)) ||
        !Number.isSafeInteger(cell.revision) ||
        cell.revision < 1 ||
        !cell.source ||
        !Number.isSafeInteger(cell.source.turn) ||
        cell.source.turn < 1 ||
        cell.source.turn > turn ||
        typeof cell.source.id !== "string" ||
        !cell.source.id
      )
        return denied(`invalid_or_future_fact:${field}`);
      if (cell.revision !== scope.revision || cell.value !== scope.value)
        return denied(`stale_approval:${field}`);
      if (!Object.hasOwn(parameters, field) || parameters[field] !== cell.value)
        return denied(`stale_parameters:${field}`);
    }
    return {
      allowed: true,
      reason: "verified_approval_and_current_constraints",
      sources,
    };
  }
  history(): Approval[] {
    return structuredClone(this.approvals);
  }
  async execute<T>(
    view: FactView,
    action: string,
    parameters: Record<string, FactValue>,
    turn: number,
    tool: () => T | Promise<T>,
  ) {
    const decision = this.explain(view, action, parameters, turn);
    return decision.allowed ? { decision, result: await tool() } : { decision };
  }
}
