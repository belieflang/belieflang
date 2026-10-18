# Website and browser playground

The static site is `docs/index.html`, `docs/styles.css`, and `docs/playground.js`. It uses the existing paper/teal/amber palette and fonts, without a framework or a website build step. Canonical and social metadata point to `https://belieflang.org/`. No social preview image is declared because there is no dedicated preview asset.

## Playground scope

The playground uses a separate JavaScript parser/runtime with keyword-based inference and simulated tools. It makes no GPT or Jev API calls and needs no API key. The TypeScript runtime is the reference implementation.

Supported examples are the small homepage program, flight intent (`examples/intent.bel`), uncertain/open intent (`examples/intent_no_flight.bel`), and observation/inference/merge (`examples/observe_infer_merge.bel`). They exercise belief modes, normalization, confidence, entropy, variables, property access, compound conditions, tools, observations and belief updates. The examples remain editable.

The hero shows a five-line observation/inference example that asks a question when intent is uncertain, followed by its state and action output. The observe/infer/merge section shows the existing update example and selected, tested state/trace output. Both “Run this example” links load the matching editable program. Colored tokens in these static examples are authored HTML; the editor remains a native textarea without an overlay, editor framework, or dependency. Source and output have separate file labels. Editing marks the output as a previous run; errors identify the attempted file and retain the original parser/runtime message. Belief values are displayed on separate lines, and output wraps within its panels.

`tests/playground.test.ts` loads the actual browser script in a Node VM and compares all four examples with the current TypeScript parser/runtime: ASTs, state, variables, observations (excluding TypeScript timestamps), simulated tool results/actions and execution traces. It also checks selected validation failures, example loading/focus/scroll requests, example selection, custom edits, trace controls, error display, stale-output clearing and recovery.

Both displayed programs must match their executable samples after removing static color markup. Tests generate the hero preview from the intro's executed state and actions, recompute the selected update output from runtime state, entropy, rule traces and actions, and exercise both example links and source/output labels. The interpreter and inference adapter behavior are unchanged.

This is regression coverage for the supported examples, not proof of complete parity for arbitrary programs. Browser observations omit timestamps; the demo does not expose TypeScript snapshot/provenance APIs, v3 factual memory/history, decision guards, live adapters or host tool registration. Use the [TypeScript CLI and runtime](https://github.com/belieflang/belieflang/blob/main/README.md#quick-start) as the reference. The new tool-invocation lines are display records; neither the interpreter's decisions nor the sample tools' return values changed.

“Run this example” loads the displayed code, selects it, updates the fragment, scrolls to the playground, focuses the editor, and runs locally. The link retains a usable fragment target without JavaScript. Invalid programs show a focusable alert, mark the editor invalid, and clear prior output so an old successful run cannot be mistaken for the current result. The editor contents remain available to fix.

Loading and stale-output messages remain visible. Successful runs announce “Run complete.” through a visually hidden live region, without adding a visible status line. Errors use the focused alert rather than a duplicate status message. The live region remains in the accessibility tree.

## Local validation

From the repository root:

```sh
npm ci
npm run build
npm test
node scripts/audit-incremental-pilot.mjs
python3 -m http.server 8765 --bind 127.0.0.1 --directory docs
```

Open `http://127.0.0.1:8765/`. The site only needs the three static source files; the build/tests above validate its examples against the TypeScript reference.

Browser checks use Chromium at 320, 390, 768 and 1440 CSS pixels: syntax visible in the first viewport, keyboard activation of both example links, focus and fragment navigation, all examples, source/output labels, custom invalid code, error recovery, trace output, internal anchors, table scrolling, no page-wide horizontal overflow and reduced-motion styles. Network requests are limited to local assets and the existing Google Fonts resources. Desktop/mobile screenshots below use 1440×1000 and 390×844 viewports, respectively, with reduced motion. Font rendering may vary by machine.

| Viewport | Before | After |
|---|---|---|
| Desktop | [Before](assets/website-developer-review/desktop-before.png) | [After](assets/website-developer-review/desktop-after.png) |
| Mobile | [Before](assets/website-developer-review/mobile-before.png) | [After](assets/website-developer-review/mobile-after.png) |

These screenshots capture PR #11, before the subsequent copy cleanup.

[Playground with the update example](assets/website-developer-review/playground-after.png) · [Update example and selected output](assets/website-developer-review/updates-after.png) · [Benchmark metrics and comparison](assets/website-developer-review/benchmarks-after.png).

The earlier [desktop](assets/website-review/desktop-after.png) and [mobile](assets/website-review/mobile-after.png) screenshots preserve the preceding PR #10 design.

## Deployment verification

After PR #10 merged, fresh HTTP responses from `https://belieflang.org/`, `/styles.css`, and `/playground.js` on 2026-10-18 were byte-identical to `main` at `e2a6485`, including PRs #9 and #10. The domain is serving those merged website sources. The responses reported HTTP 200, Cloudflare, `DYNAMIC`, and `public, max-age=0, must-revalidate`. This is a content check, not proof of a particular Cloudflare deployment commit or account setting. No deployment configuration was changed.

| File | SHA-256 of both public response body and checked main file after PR #10 |
|---|---|
| `/` → `docs/index.html` | `a393a094e1784081801e2b070678805b0c51769ad7d1e1765f7acc50cb38139d` |
| `/styles.css` | `ee2464d90f1668ca857d4bd60f85612a754afbe6bce573d8cba6b72b7919cefa` |
| `/playground.js` | `7404984d1e83e205aa41f258ea735c259dae1c7aafbde55811e102e6300e4ad6` |

### Earlier check before PR #10

Checked on 2026-10-18, before these website edits, against `main` at `937b3bd` (merged README PR #9): the public domain returned HTTP 200, and its HTML, CSS and JavaScript were **byte-identical** to the corresponding tracked files. The public page's older research content was also in the source. This observation does not establish an older deployment or a broken cache. It also cannot identify the deployed commit, since those website files were unchanged across several commits.

| File | SHA-256 of both public response body and checked main file |
|---|---|
| `/` → `docs/index.html` | `2cf7750d71b9898ab6552510c137d41849d4dc7dce6f0cc74fffdd1acde3f08f` |
| `/styles.css` | `81bbab54db24223f9369166dd5130d85dc759cd2131d8e58d2941037f977f46f` |
| `/playground.js` | `e99d52736c0c00a60f6e7fe9ef8eb621ba0acf6751ea05374feb0d111f7e12ba` |

The response reported `server: cloudflare`, `cf-cache-status: DYNAMIC`, and `cache-control: public, max-age=0, must-revalidate`. Cloudflare Pages checks are visible on repository PRs. The repository contains a CI workflow, but no tracked Cloudflare/Pages build configuration, deployment workflow, or `CNAME`. The GitHub Pages API returned 404 and the GitHub deployments endpoint returned an empty list; neither proves that externally managed hosting is absent.

The Cloudflare project's production settings and deployment commit are not available through this checkout. No deployment configuration or account settings were changed. If a mismatch remains after merge, the owner should check:

1. The connected repository and production branch are `belieflang/belieflang` and `main`; the production deployment references the intended merged commit rather than a preview branch.
2. The configured project root/output serves `docs/index.html`, `styles.css`, and `playground.js` together. For a repository-root project, the static output is `docs`; if the project root is already `docs`, its output is relative to that root. Do not assume a TypeScript `dist` build contains the website.
3. `belieflang.org` is attached to that production project/deployment, with the intended DNS and redirects. Verify the custom domain separately from any preview URL.
4. Compare fresh public response bodies with the merged source, then inspect browser/CDN caching or custom cache rules only if their bytes differ. The current observations do not justify a speculative cache purge or new deployment workflow.

A post-merge comparison can use `curl -fsSL https://belieflang.org/ | shasum -a 256` and the same command for the CSS/JS, alongside local `shasum -a 256 docs/index.html docs/styles.css docs/playground.js`. New hashes are expected after this PR; the table above is a dated pre-change observation.
