# Audited incremental-memory pilot artifacts

See the [final research report](../../../docs/incremental-memory-pilot-results.md) for findings, error examples, cost crossovers and the one proposed next experiment. This directory is a historical result archive, not an executable benchmark configuration.

- `journal.json.gz`: all 298 completed records (one smoke, 297 pilot), provider usage, parsed outputs, prompts/schemas, latency, metadata and request-body hashes.
- `report.json.gz`: complete live report, all runs/checkpoints, semantic-validation failures, summaries and accounting. Transport-success records and post-response semantic failures are distinct; all 14 semantic errors are preserved in run calls.
- `smoke.json`: successful smoke report and its pre-pilot accounting snapshot.
- `manifest.json`: original local file hashes, sanitized content hashes, stored archive hashes, original source commit and freeze fingerprint. Only account-specific response IDs were replaced with stable aliases. Original local JSON files were not edited, deleted, staged or replaced.
- `audit.json`: independently derived scores/accounting, failures, false denials, per-case/turn curves, exact structured-request equivalence and offline-plan differences.
- `cost-curves.csv`, `.svg`, `.png`: cumulative measured costs, including maintenance and routing; figures sum three cases per schedule, CSV retains each case.

All inference content is from synthetic public fixtures and model responses to those fixtures. The public artifacts exclude credentials, HTTP authorization headers, account-specific response IDs and local user paths. The frozen transport did not save complete HTTP response envelopes or request timestamps; these cannot be recovered. A stored fingerprint attests to the recorded files, not to provider execution independently of those files.

From a checkout with Node.js 22 or later:

```sh
npm ci
npm run build
node scripts/audit-incremental-pilot.mjs
node --test scripts/pilot-results-audit.test.mjs
node dist/src/incremental/cli.js --validate
```

These commands are offline. They do not read API keys, load `.env`, construct an inference transport, or reset a journal. The auditor checks archived hashes and frozen source/fixture hashes, then recomputes metrics independently. A separate saved-output replay confirms the original execution trace. Replaying the existing deterministic offline parser only reconstructs the frozen 284-call projection; it does not create new live evidence.

Derived audit/CSV regeneration (same archived inputs):

```sh
node scripts/audit-incremental-pilot.mjs --write
```

Optional figure regeneration requires matplotlib (used here: 3.11.2); use an isolated environment. It does not affect metrics or request inference:

```sh
python scripts/plot-incremental-pilot.py
```

The person holding the original local records can reproduce the response-ID redaction and compressed copies without altering the originals:

```sh
node scripts/audit-incremental-pilot.mjs --archive-from benchmarks/results/incremental-pilot --write
```

Original-record SHA-256 values:

| Original local record | SHA-256 |
|---|---|
| journal.json | `dca7fdaffcff85fbf122d0c2abd91bd6a8eadc204a268c349d98914af52d7307` |
| report.json | `a727e095baa40d96609671566fd6f9b21d0a51b36b3b08b379ffff650e111065` |
| smoke.json | `44cd419f4cae10b5c08a12e5390c587608047eef53bb77dde3c0d6181a6c6b9a` |

Frozen protocol fingerprint: `cf52578951cddd0fd8084e0012d94e54bdb15d582d3fb9fc808a1b06642f53f9`. The protocol, source, fixtures, prompts, gold labels, scoring and historical results are unchanged. The final research report is retrospective analysis, not a new freeze or authorization for another experiment.
