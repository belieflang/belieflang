import { readFile, readdir, writeFile } from "node:fs/promises";
import { hash } from "../v3_live.js";
import { validateFreeze } from "../v3_cli.js";
import { verifyReviewFreeze } from "../viability/freeze.js";
const path = "benchmarks/incremental/freeze.json";
export async function assertNoLiveEvidence() {
  try {
    const journal = JSON.parse(
      await readFile(
        "benchmarks/results/incremental-pilot/journal.json",
        "utf8",
      ),
    );
    if (journal.entries?.length)
      throw new Error(
        "paid attempts exist: preserve this protocol and prepare a separately named future experiment",
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}
async function hashes() {
  const files = [
    ...(await readdir("src/incremental"))
      .filter((p) => p.endsWith(".ts"))
      .map((p) => `src/incremental/${p}`),
    ...(await readdir("tests"))
      .filter((p) => p.startsWith("incremental") && p.endsWith(".ts"))
      .map((p) => `tests/${p}`),
    "benchmarks/incremental/cases.json",
    "benchmarks/incremental/private-gold.json",
    "benchmarks/incremental/config.json",
    "benchmarks/incremental/plan.json",
    "benchmarks/incremental/offline.json",
    "docs/incremental-memory-pilot.md",
    "benchmarks/viability/freeze.json",
  ].sort();
  return Object.fromEntries(
    await Promise.all(
      files.map(async (p) => [p, hash(await readFile(p, "utf8"))]),
    ),
  );
}
export async function freeze() {
  await assertNoLiveEvidence();
  await validateFreeze();
  await verifyReviewFreeze();
  await writeFile(
    path,
    JSON.stringify(
      {
        version: 1,
        description:
          "New pilot protocol frozen before paid responses. Private gold is scorer-only, never an inference argument. Preserve original experiments and this protocol after inspection of live outcomes.",
        sha256: await hashes(),
      },
      null,
      2,
    ) + "\n",
  );
}
export async function verifyFreeze() {
  await validateFreeze();
  await verifyReviewFreeze();
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (
    manifest.version !== 1 ||
    JSON.stringify(manifest.sha256) !== JSON.stringify(await hashes())
  )
    throw new Error(
      "incremental protocol source/config/fixture/scoring freeze mismatch",
    );
  return hash(JSON.stringify(manifest));
}
