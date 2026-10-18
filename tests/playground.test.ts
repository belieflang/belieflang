import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { parse } from "../src/parser.js";
import { BeliefRuntime } from "../src/runtime.js";

type BrowserRuntime = {
  state: Record<string, Record<string, number>>;
  vars: object;
  observations: object[];
  actions: string[];
  traceLines: string[];
  entropy(name: string): number;
};
type BrowserAPI = {
  samples: Record<string, string>;
  parse(source: string): unknown;
  runProgram(
    source: string,
    options?: { trace: boolean },
  ): Promise<BrowserRuntime>;
};
const script = readFileSync("docs/playground.js", "utf8");
const html = readFileSync("docs/index.html", "utf8");
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function displayedCode(id: string) {
  return html
    .match(new RegExp(`<code id="${id}"[^>]*>([\\s\\S]*?)<\\/code>`))![1]
    .replace(/<[^>]*>/g, "")
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
function browser(document?: object): BrowserAPI {
  const window: {
    BeliefPlayground?: BrowserAPI;
    location: { hash: string };
    history: {
      pushState: (_data: unknown, _unused: string, url: string) => void;
    };
  } = {
    location: { hash: "" },
    history: {
      pushState: (_data, _unused, url) => {
        window.location.hash = url;
      },
    },
  };
  vm.runInNewContext(script, { window, ...(document ? { document } : {}) });
  return window.BeliefPlayground!;
}

const api = browser();
const sourceFiles = {
  intent: "examples/intent.bel",
  noFlight: "examples/intent_no_flight.bel",
  dynamic: "examples/observe_infer_merge.bel",
};
for (const [name, file] of Object.entries(sourceFiles)) {
  test(`browser ${name} example matches the checked-in .bel program`, () => {
    assert.deepEqual(
      plain(api.parse(api.samples[name])),
      parse(readFileSync(file, "utf8")),
    );
  });
}

for (const [name, source] of Object.entries(api.samples)) {
  test(`browser ${name} parser and runtime match TypeScript on supported behavior`, async () => {
    assert.deepEqual(plain(api.parse(source)), parse(source));
    const lines: string[] = [];
    const log = console.log;
    const core = new BeliefRuntime({}, { trace: true, now: () => 123 });
    try {
      console.log = (...args: unknown[]) => {
        lines.push(args.join(" "));
      };
      await core.run(parse(source));
    } finally {
      console.log = log;
    }
    const local = await api.runProgram(source, { trace: true });
    assert.deepEqual(plain(local.state), core.getState());
    assert.deepEqual(plain(local.vars), core.getVars());
    assert.deepEqual(
      plain(local.observations),
      core.getObservations().map(({ timestamp: _, ...o }) => o),
    );
    assert.deepEqual(
      plain(local.traceLines),
      lines.filter((l) => l.startsWith("[trace]")),
    );
    assert.deepEqual(
      plain(local.actions.filter((l) => l.startsWith("[call]"))),
      lines
        .filter((l) => l.startsWith("[trace] call "))
        .map((l) => l.replace("[trace] call ", "[call] ")),
    );
    assert.deepEqual(
      plain(local.actions.filter((l) => !l.startsWith("[call]"))),
      lines.filter((l) => l.startsWith("[tool]") || l.startsWith("[ask_user]")),
    );
  });
}

for (const [id, name] of [["syntax-example", "intro"], ["update-example", "dynamic"]]) {
  test(`displayed ${name} syntax is the actual runnable playground sample`, () => {
    const source = displayedCode(id);
    assert.equal(source, api.samples[name]);
    assert.match(html, new RegExp(`href="#playground"\\s+data-playground-example="${name}"`));
    assert.deepEqual(plain(api.parse(source)), parse(source));
  });
}

test("displayed update result matches actual state, uncertainty, rules and actions", async () => {
  const runtime = await api.runProgram(displayedCode("update-example"), { trace: true });
  const ruleResult = (index: number) => runtime.traceLines
    .find((line) => line.startsWith(`[trace] rule ${index} `))!.split(" => ").at(-1);
  const result = [
    `intent.book_flight = ${runtime.state.intent.book_flight.toFixed(3)}`,
    `user.budget_sensitive = ${runtime.state.user.budget_sensitive.toFixed(3)}`,
    `entropy(intent) = ${runtime.entropy("intent").toFixed(3)}`,
    `rule 1 => ${ruleResult(1)}`,
    `rule 2 => ${ruleResult(2)}`,
    runtime.actions.find((line) => line === "[call] rank_flights()"),
  ].join("\n");
  assert.equal(displayedCode("update-result"), result);
});

test("intro asks about ambiguous intent and skips clarification for a clear request", async () => {
  const ambiguous = await api.runProgram(api.samples.intro);
  assert.deepEqual(plain(ambiguous.state.intent), { book_flight: 0.5, book_hotel: 0.5 });
  assert.equal(ambiguous.entropy("intent"), 1);
  assert.deepEqual(plain(ambiguous.actions), ["[ask_user] Which would you like to book?"]);

  const clear = await api.runProgram(api.samples.intro.replace("A flight or a hotel", "A flight"));
  assert.deepEqual(plain(clear.state.intent), { book_flight: 1 });
  assert.equal(clear.entropy("intent"), 0);
  assert.deepEqual(plain(clear.actions), []);
});

test("hero output preview matches the executed intro state and actions", async () => {
  const runtime = await api.runProgram(displayedCode("syntax-example"));
  const entries = Object.entries(runtime.state.intent);
  const width = Math.max(...entries.map(([name]) => name.length));
  const output = [
    "intent:",
    ...entries.map(([name, value]) => `  ${name.padEnd(width)} = ${value.toFixed(2)}`),
    "",
    ...runtime.actions,
  ].join("\n");
  assert.equal(displayedCode("intro-result"), output);
});

// Minimal DOM fixture exercises the real page bindings without adding a browser
// dependency to CI. Actual scrolling and keyboard focus are also checked in Chromium.
class Element {
  value = "";
  textContent = "";
  checked = false;
  hidden = false;
  disabled = false;
  focused = false;
  scrolled = false;
  prevented = false;
  dataset: Record<string, string> = {};
  attributes: Record<string, string> = {};
  listeners = new Map<
    string,
    ((event: { preventDefault: () => void }) => unknown)[]
  >();
  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }
  focus() {
    this.focused = true;
  }
  scrollIntoView() {
    this.scrolled = true;
  }
  addEventListener(
    name: string,
    fn: (event: { preventDefault: () => void }) => unknown,
  ) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), fn]);
  }
  async emit(name: string) {
    for (const fn of this.listeners.get(name) ?? [])
      await fn({
        preventDefault: () => {
          this.prevented = true;
        },
      });
    await new Promise((resolve) => setImmediate(resolve));
  }
}
function page() {
  const ids = [
    "source",
    "sample",
    "run",
    "trace",
    "error",
    "state-output",
    "vars-output",
    "observations-output",
    "actions-output",
    "trace-output",
    "status",
    "filename",
    "output-label",
  ];
  const elements = new Map(
    ids.map((id) => [`#playground-${id}`, new Element()]),
  );
  elements.set(".playground-results", new Element());
  elements.set("#playground", new Element());
  const link = new Element();
  link.dataset.playgroundExample = "intro";
  const updateLink = new Element();
  updateLink.dataset.playgroundExample = "dynamic";
  const document = {
    readyState: "complete",
    querySelector: (s: string) => elements.get(s) ?? null,
    querySelectorAll: () => [link, updateLink],
  };
  browser(document);
  const get = (id: string) => elements.get(`#playground-${id}`)!;
  return { get, link, updateLink, target: elements.get("#playground")! };
}

test("Run this example loads, focuses, and executes the intro after custom edits", async () => {
  const { get, link, target } = page();
  await new Promise((resolve) => setImmediate(resolve));
  get("source").value = "not a valid program";
  await get("source").emit("input");
  assert.equal(get("sample").value, "custom");
  assert.equal(get("filename").textContent, "custom.bel");
  assert.match(get("output-label").textContent, /Previous run/);
  assert.equal(get("status").textContent, "Source changed. Run to update output.");
  assert.equal(get("status").attributes.class, "small-note");
  await link.emit("click");
  assert.equal(get("source").value, api.samples.intro);
  assert.equal(get("sample").value, "intro");
  assert.equal(get("filename").textContent, "intro.bel");
  assert.equal(get("output-label").textContent, "intro.bel");
  assert.equal(get("source").focused, true);
  assert.equal(target.scrolled, true);
  assert.equal(link.prevented, true);
  assert.match(get("actions-output").textContent, /Which would you like to book/);
  assert.match(get("observations-output").textContent, /A flight or a hotel/);
  assert.equal(get("status").textContent, "Run complete.");
  assert.match(get("status").attributes.class, /visually-hidden/);
  assert.equal(get("error").hidden, true);
  assert.equal(get("run").disabled, false);
});

test("advanced example link loads and renders observations, merged state and trace", async () => {
  const { get, updateLink, target } = page();
  await new Promise((resolve) => setImmediate(resolve));
  get("trace").checked = true;
  await updateLink.emit("click");
  assert.equal(get("source").value, api.samples.dynamic);
  assert.equal(get("sample").value, "dynamic");
  assert.equal(get("output-label").textContent, "observe_infer_merge.bel");
  assert.equal(get("status").textContent, "Run complete.");
  assert.match(get("status").attributes.class, /visually-hidden/);
  assert.match(get("state-output").textContent, /book_flight=0.920/);
  assert.match(get("observations-output").textContent, /user_message/);
  assert.match(get("vars-output").textContent, /extracted/);
  assert.match(get("actions-output").textContent, /rank_flights/);
  assert.match(get("trace-output").textContent, /merge beliefs/);
  assert.equal(get("source").focused, true);
  assert.equal(target.scrolled, true);
});

test("errors clear stale output, identify invalid input, and recover on a valid example", async () => {
  const { get, link } = page();
  await new Promise((resolve) => setImmediate(resolve));
  get("source").value = "belief broken { @ }";
  const running = get("run").emit("click");
  assert.equal(get("status").textContent, "Running intro.bel…");
  assert.equal(get("status").attributes.class, "small-note");
  assert.equal(get("run").disabled, true);
  await running;
  assert.equal(get("error").hidden, false);
  assert.match(get("error").textContent, /Unexpected character/);
  assert.match(get("error").textContent, /Error in intro.bel:/);
  assert.equal(get("output-label").textContent, "intro.bel · failed");
  assert.equal(get("error").focused, true);
  assert.equal(get("status").textContent, "");
  assert.equal(get("source").attributes["aria-invalid"], "true");
  for (const id of [
    "state-output",
    "vars-output",
    "observations-output",
    "actions-output",
    "trace-output",
  ])
    assert.match(get(id).textContent, /program did not run/);
  await link.emit("click");
  assert.equal(get("error").hidden, true);
  assert.equal(get("source").attributes["aria-invalid"], "false");
  assert.match(get("state-output").textContent, /book_flight=0.500/);
});

test("existing example selection, observations, variables and trace remain functional", async () => {
  const { get } = page();
  await new Promise((resolve) => setImmediate(resolve));
  get("sample").value = "dynamic";
  await get("sample").emit("change");
  assert.match(get("observations-output").textContent, /user_message/);
  assert.match(get("vars-output").textContent, /message/);
  get("trace").checked = true;
  await get("trace").emit("change");
  assert.match(get("trace-output").textContent, /infer beliefs/);
  assert.match(get("trace-output").textContent, /merge beliefs/);
  get("sample").value = "noFlight";
  await get("sample").emit("change");
  assert.match(get("state-output").textContent, /other=0.150/);
});

test("supported validation failures are rejected by both runtimes", async () => {
  for (const source of [
    "belief b exclusive open { x: 2 }",
    "when entropy(missing) > 0:\n  call search_flights()",
  ]) {
    await assert.rejects(api.runProgram(source));
    const core = new BeliefRuntime();
    const log = console.log;
    try {
      console.log = () => {};
      await assert.rejects(core.run(parse(source)));
    } finally {
      console.log = log;
    }
  }
});
