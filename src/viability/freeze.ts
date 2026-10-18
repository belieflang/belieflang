import { readFile, writeFile } from "node:fs/promises";
import { validateFreeze } from "../v3_cli.js";
import { createHash } from "node:crypto";
export const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const paths = [
  "src/viability/typescript_state.ts",
  "src/viability/workflows.ts",
  "src/viability/travel.ts",
  "src/viability/support.ts",
  "src/viability/operations.ts",
  "src/viability/typescript_host.ts",
  "src/viability/belieflang_host.ts",
  "src/viability/compare.ts",
  "src/viability/audit.ts",
  "src/viability/live_plan.ts",
  "src/viability/review.ts",
  "src/viability/freeze.ts",
  "examples/viability/travel.bel",
  "examples/viability/support.bel",
  "examples/viability/operations.bel",
  "benchmarks/viability/pricing.json",
  "benchmarks/viability/budget-rates.json",
  "benchmarks/viability/live-plan.json",
  "benchmarks/viability/smoke-request.json",
  "benchmarks/v3/freeze.json",
  "src/parser.ts",
  "src/ast.ts",
];
const path = "benchmarks/viability/freeze.json";
async function manifest() {
  return Object.fromEntries(
    await Promise.all(
      paths.map(async (p) => [p, sha256(await readFile(p, "utf8"))]),
    ),
  );
}
export async function freezeReview() {
  await validateFreeze();
  await writeFile(
    path,
    JSON.stringify(
      {
        version: 1,
        description:
          "Separate product-review and proposed live-plan freeze. Original v3 freeze/results are unchanged. No paid calls authorized by this file.",
        sha256: await manifest(),
      },
      null,
      2,
    ) + "\n",
  );
}
export async function verifyReviewFreeze() {
  await validateFreeze();
  const stored = JSON.parse(await readFile(path, "utf8")),
    actual = await manifest();
  if (
    stored.version !== 1 ||
    JSON.stringify(stored.sha256) !== JSON.stringify(actual)
  )
    throw new Error("product-review/live-plan frozen inputs changed");
  return sha256(JSON.stringify(stored));
}
