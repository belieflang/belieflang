import type { FactSchema } from "../runtime.js";
import type { FactDelta, FactValue, FactStatus } from "../fact_memory.js";
export type Cell<T> = { value: T | null; status: FactStatus | "missing" };
export type TravelFacts = {
  destination: string;
  budget: number;
  departure_date: string;
  direct: boolean;
};
export type SupportFacts = {
  account_id: string;
  resolution: string;
  refund: number;
};
export type OperationsFacts = {
  environment: "staging" | "production";
  service: string;
  release: string;
};
export type Context<T extends object> = {
  facts: { [K in keyof T]: Cell<T[K]> };
  intentConfidence: number;
};
export type TravelContext = Context<TravelFacts>;
export type SupportContext = Context<SupportFacts>;
export type OperationsContext = Context<OperationsFacts>;
export type Step = {
  text: string;
  patch: FactDelta[];
  verified?: Record<string, FactValue>;
  approval?: { allowed: boolean; expiresAfterTurn?: number };
  task?: { intentConfidence: number; expectedExecution: boolean };
  question?: {
    field: string;
    mode: "original" | "previous";
    expected: FactValue;
  };
};
export type Workflow = {
  id: "travel" | "support" | "operations";
  schema: FactSchema;
  action: string;
  fields: string[];
  steps: Step[];
};
const set = (
  field: string,
  value: FactValue,
  confidence = 0.95,
): FactDelta => ({ field, op: "set", value, confidence, basis: "explicit" });
const conflict = (field: string, value: FactValue): FactDelta => ({
  field,
  op: "conflict",
  value,
  confidence: 0.99,
  basis: "inferred",
});
const clear = (field: string): FactDelta => ({
  field,
  op: "clear",
  confidence: 1,
  basis: "explicit",
});
export const workflows: Workflow[] = [
  {
    id: "travel",
    schema: {
      destination: "string",
      budget: "number",
      departure_date: "string",
      direct: "boolean",
    },
    action: "book_trip",
    fields: ["destination", "budget", "departure_date", "direct"],
    steps: [
      {
        text: "Destination Rome, budget 1800, departure 2033-03-17, direct flight required; independently verified.",
        patch: [
          set("destination", "Rome"),
          set("budget", 1800),
          set("departure_date", "2033-03-17"),
          set("direct", true),
        ],
        verified: {
          destination: "Rome",
          budget: 1800,
          departure_date: "2033-03-17",
          direct: true,
        },
        task: { intentConfidence: 0.98, expectedExecution: false },
      },
      {
        text: "Authorized operator approves this trip.",
        patch: [],
        approval: { allowed: true },
        task: { intentConfidence: 0.98, expectedExecution: true },
      },
      {
        text: "No action requested; the traveler is checking vacation dates.",
        patch: [],
      },
      {
        text: "Change budget to 2100; verified, but earlier approval applies to old constraints.",
        patch: [set("budget", 2100)],
        verified: { budget: 2100 },
        task: { intentConfidence: 0.98, expectedExecution: false },
      },
      {
        text: "Reapprove the revised trip.",
        patch: [],
        approval: { allowed: true },
        task: { intentConfidence: 0.6, expectedExecution: false },
      },
      {
        text: "Intent to book is now explicit and unambiguous.",
        patch: [],
        task: { intentConfidence: 0.98, expectedExecution: true },
      },
      {
        text: "An unverified itinerary instead names Milan; unresolved conflict.",
        patch: [conflict("destination", "Milan")],
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "Actually use Rome; independently verified; operator reapproves.",
        patch: [set("destination", "Rome")],
        verified: { destination: "Rome" },
        approval: { allowed: true },
        task: { intentConfidence: 0.99, expectedExecution: true },
      },
      {
        text: "Revoke trip approval.",
        patch: [],
        approval: { allowed: false },
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "What was my original budget?",
        patch: [],
        question: { field: "budget", mode: "original", expected: 1800 },
      },
      {
        text: "No longer require direct flights; direct is false.",
        patch: [set("direct", false)],
        verified: { direct: false },
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "Cancel the date, retaining destination and budget.",
        patch: [clear("departure_date")],
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
    ],
  },
  {
    id: "support",
    schema: { account_id: "string", resolution: "string", refund: "number" },
    action: "issue_refund",
    fields: ["account_id", "resolution", "refund"],
    steps: [
      {
        text: "Account C-812, proposed resolution repair, refund 60; verified.",
        patch: [
          set("account_id", "C-812"),
          set("resolution", "repair"),
          set("refund", 60),
        ],
        verified: { account_id: "C-812", resolution: "repair", refund: 60 },
      },
      {
        text: "Agent is permitted to refund this case.",
        patch: [],
        approval: { allowed: true },
        task: { intentConfidence: 0.96, expectedExecution: true },
      },
      {
        text: "The customer is waiting for an update; no action is requested.",
        patch: [],
      },
      {
        text: "Another report says resolution replace instead; unresolved.",
        patch: [conflict("resolution", "replace")],
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "Customer explicitly chooses replace; low model confidence is not verification.",
        patch: [set("resolution", "replace", 0.1)],
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "Operator verifies replacement and approves refund.",
        patch: [set("resolution", "replace")],
        verified: { resolution: "replace" },
        approval: { allowed: true },
        task: { intentConfidence: 0.96, expectedExecution: true },
      },
      {
        text: "What resolution was originally chosen?",
        patch: [],
        question: { field: "resolution", mode: "original", expected: "repair" },
      },
      {
        text: "What resolution preceded replacement?",
        patch: [],
        question: { field: "resolution", mode: "previous", expected: "repair" },
      },
      {
        text: "Increase refund to 140; verified and approved by account owner, but above application policy cap.",
        patch: [set("refund", 140)],
        verified: { refund: 140 },
        approval: { allowed: true },
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
      {
        text: "Set refund back to 60, verify, and reapprove.",
        patch: [set("refund", 60)],
        verified: { refund: 60 },
        approval: { allowed: true },
        task: { intentConfidence: 0.96, expectedExecution: true },
      },
      {
        text: "Refund permission revoked.",
        patch: [],
        approval: { allowed: false },
        task: { intentConfidence: 0.99, expectedExecution: false },
      },
    ],
  },
  {
    id: "operations",
    schema: {
      environment: { type: "string", enum: ["staging", "production"] },
      service: "string",
      release: "string",
    },
    action: "restart_production",
    fields: ["environment", "service", "release"],
    steps: [
      {
        text: "Production ledger service release r41, independently verified; no authorization yet.",
        patch: [
          set("environment", "production"),
          set("service", "ledger"),
          set("release", "r41"),
        ],
        verified: {
          environment: "production",
          service: "ledger",
          release: "r41",
        },
        task: { intentConfidence: 0.999, expectedExecution: false },
      },
      {
        text: "Operator authorizes restart through turn 3.",
        patch: [],
        approval: { allowed: true, expiresAfterTurn: 3 },
        task: { intentConfidence: 0.999, expectedExecution: true },
      },
      {
        text: "Intent to restart is ambiguous; authorization alone is insufficient application intent.",
        patch: [],
        task: { intentConfidence: 0.7, expectedExecution: false },
      },
      {
        text: "Authorization expired; try again.",
        patch: [],
        task: { intentConfidence: 0.999, expectedExecution: false },
      },
      {
        text: "Operator renews authorization.",
        patch: [],
        approval: { allowed: true },
        task: { intentConfidence: 0.999, expectedExecution: true },
      },
      { text: "Monitoring is steady; no restart is requested.", patch: [] },
      {
        text: "Deploy release r42, verified; old approval is stale.",
        patch: [set("release", "r42")],
        verified: { release: "r42" },
        task: { intentConfidence: 0.999, expectedExecution: false },
      },
      {
        text: "Operator reapproves r42 restart.",
        patch: [],
        approval: { allowed: true },
        task: { intentConfidence: 0.999, expectedExecution: true },
      },
      {
        text: "Monitoring reports r43 as a conflicting unverified release.",
        patch: [conflict("release", "r43")],
        task: { intentConfidence: 1, expectedExecution: false },
      },
      {
        text: "Operator revokes restart permissions.",
        patch: [],
        approval: { allowed: false },
        task: { intentConfidence: 1, expectedExecution: false },
      },
      {
        text: "Which release was initially deployed?",
        patch: [],
        question: { field: "release", mode: "original", expected: "r41" },
      },
    ],
  },
];
