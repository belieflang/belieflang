#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { CHAT_INSTRUCTIONS, fullHistoryInput, snapshotTurnInput } from "./chat_protocol.js";
import { CHAT_CODE_BASE_INSTRUCTIONS, CHAT_CODE_INSTRUCTIONS, decodeChatCode, encodeChatCode } from "./chat_code.js";
import { createOpenAIInferAdapter, type OpenAIUsage } from "./openai.js";
import { createJevInferAdapter } from "./jev.js";
import { createJevDeltaAdapter } from "./jev_delta.js";
import { BeliefRuntime, type BeliefSnapshot } from "./runtime.js";

async function readSnapshot(path: string): Promise<BeliefSnapshot> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as BeliefSnapshot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, beliefs: {} };
    }
    throw error;
  }
}

async function readHistory(path: string): Promise<string[]> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!Array.isArray(value) || !value.every((message) => typeof message === "string")) {
      throw new Error(`invalid chat history in ${path}`);
    }
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readCode(path: string): Promise<string | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" ||
      (value as Record<string, unknown>).version !== 1 ||
      (value as Record<string, unknown>).variant !== "labeled_10" ||
      typeof (value as Record<string, unknown>).code !== "string") {
      throw new Error(`invalid coded chat state in ${path}`);
    }
    const code = (value as Record<string, unknown>).code as string;
    decodeChatCode(code, "labeled_10");
    return code;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function saveJson(path: string, value: unknown): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temporaryPath, path);
}

async function main(): Promise<void> {
  const engine = process.env.CHAT_ENGINE ?? "chatgpt";
  if (engine !== "chatgpt" && engine !== "jev") {
    throw new Error("CHAT_ENGINE must be chatgpt or jev");
  }
  const mode = process.env.CHAT_MODE ?? "snapshot";
  if (mode !== "snapshot" && mode !== "full-history" && mode !== "coded") {
    throw new Error("CHAT_MODE must be snapshot, coded, or full-history");
  }
  if (engine === "jev" && mode !== "snapshot") {
    throw new Error("coded and full-history modes currently support CHAT_ENGINE=chatgpt only");
  }
  const jevUpdateMode = process.env.JEV_UPDATE_MODE ?? "snapshot";
  if (jevUpdateMode !== "snapshot" && jevUpdateMode !== "delta") {
    throw new Error("JEV_UPDATE_MODE must be snapshot or delta");
  }
  if (jevUpdateMode === "delta" && (engine !== "jev" || mode !== "snapshot")) {
    throw new Error("JEV_UPDATE_MODE=delta requires CHAT_ENGINE=jev and CHAT_MODE=snapshot");
  }
  const seedModel = process.env.CHAT_SEED_MODEL;
  if (seedModel && mode !== "snapshot") {
    throw new Error("CHAT_SEED_MODEL requires CHAT_MODE=snapshot");
  }
  const apiKey = engine === "jev" ? process.env.TYPESAFE_API_KEY : process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error(`${engine === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"} is required for the chatbot demo`);
  if (seedModel && !process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required to create the seed snapshot");
  }
  const updateModel = engine === "jev" ? process.env.JEV_MODEL ?? "jev-latest"
    : process.env.OPENAI_MODEL ?? "gpt-6-luna";
  const updateSuffix = engine === "jev" && jevUpdateMode === "delta" ? "-delta" : "";
  const hybridPath = seedModel
    ? `.belieflang-chat-${seedModel.replace(/[^a-z0-9.-]/gi, "-")}-to-${updateModel.replace(/[^a-z0-9.-]/gi, "-")}${updateSuffix}.json`
    : undefined;
  const statePath = process.argv[2] ?? (mode === "snapshot" ? hybridPath ?? `.belieflang-chat-${engine}${updateSuffix}.json`
    : mode === "coded" ? ".belieflang-chat-chatgpt-coded.json"
    : ".belieflang-chat-chatgpt-full-history.json");
  let snapshot: BeliefSnapshot = { version: 1, beliefs: {} };
  let history: string[] = [];
  let code: string | null = null;
  if (mode === "snapshot") {
    snapshot = await readSnapshot(statePath);
    const check = new BeliefRuntime();
    check.loadBeliefSnapshot(snapshot);
  } else if (mode === "full-history") {
    history = await readHistory(statePath);
  } else {
    code = await readCode(statePath);
  }
  let usage: OpenAIUsage = { input_tokens: 0, output_tokens: 0 };
  const inferBeliefs = engine === "jev"
    ? jevUpdateMode === "delta"
      ? createJevDeltaAdapter({
          apiKey, model: process.env.JEV_MODEL,
          onUsage: (value) => { usage = value; },
        })
      : createJevInferAdapter({
        apiKey, model: process.env.JEV_MODEL, chatSnapshot: true,
        onUsage: (value) => { usage = value; },
      })
    : createOpenAIInferAdapter({
        apiKey, model: process.env.OPENAI_MODEL,
        instructions: mode === "coded"
          ? `${CHAT_CODE_BASE_INSTRUCTIONS} ${CHAT_CODE_INSTRUCTIONS.labeled_10}`
          : CHAT_INSTRUCTIONS,
        onUsage: (value) => { usage = value; },
      });
  const rl = createInterface({ input: stdin, output: stdout, prompt: "you> " });
  console.log(`Travel chat demo (${seedModel ? `${seedModel} seed → ${updateModel}` : engine}, ${mode}${updateSuffix}). Enter a message, or /exit to quit.`);
  if (stdin.isTTY) rl.prompt();
  let pending = Promise.resolve();
  let closed = false;
  rl.on("close", () => { closed = true; });
  rl.on("line", (message) => {
    if (message.trim() === "/exit") { rl.close(); return; }
    pending = pending.then(async () => {
      if (message.trim()) {
        try {
          usage = { input_tokens: 0, output_tokens: 0 };
          const isSeed = Boolean(seedModel) && mode === "snapshot" &&
            Object.keys(snapshot.beliefs).length === 0;
          const turnInferBeliefs = isSeed
            ? createOpenAIInferAdapter({
                apiKey: process.env.OPENAI_API_KEY!, model: seedModel,
                instructions: CHAT_INSTRUCTIONS,
                onUsage: (value) => { usage = value; },
              })
            : inferBeliefs;
          const runtime = new BeliefRuntime({}, { inferBeliefs: turnInferBeliefs });
          if (mode === "snapshot") runtime.loadBeliefSnapshot(snapshot);
          if (mode === "coded" && code) {
            const beliefs = decodeChatCode(code, "labeled_10");
            runtime.loadBeliefSnapshot({ version: 1, beliefs: {
              intent: { cardinality: "exclusive", domain: "closed", values: beliefs.intent },
              user: { cardinality: "multi", domain: "closed", values: beliefs.user },
            } });
          }
          const nextHistory = [...history, message];
          await runtime.assign("turn_input", {
            kind: "string",
            value: mode === "snapshot" ? snapshotTurnInput(snapshot, message)
              : mode === "coded" ? JSON.stringify({ previous_code: code, new_message: message })
              : fullHistoryInput(nextHistory),
          });
          await runtime.infer({ kind: "identifier", name: "turn_input" });
          if (mode === "snapshot") {
            const nextSnapshot = runtime.getBeliefSnapshot();
            await saveJson(statePath, nextSnapshot);
            snapshot = nextSnapshot;
          } else if (mode === "full-history") {
            await saveJson(statePath, nextHistory);
            history = nextHistory;
          } else {
            const nextCode = encodeChatCode(runtime.getState(), "labeled_10");
            await saveJson(statePath, { version: 1, variant: "labeled_10", code: nextCode });
            code = nextCode;
          }
          const beliefs = mode === "coded" ? decodeChatCode(code!, "labeled_10") : runtime.getState();
          const action = beliefs.intent.book_flight > 0.7 ? "search_flights"
            : beliefs.intent.book_hotel > 0.7 ? "search_hotels" : "ask_user";
          console.log(JSON.stringify({ engine, mode, ...(engine === "jev" ? { jev_update_mode: jevUpdateMode } : {}),
            model: isSeed ? seedModel : updateModel,
            ...(seedModel ? { seed: isSeed } : {}),
            ...(mode === "full-history" ? { context_messages: history.length } : {}),
            ...(mode === "coded" ? { code } : {}), beliefs, action, usage }));
        } catch (error) {
          console.error(error instanceof Error ? `error: ${error.message}` : error);
        }
      }
      if (!closed && stdin.isTTY) rl.prompt();
    });
  });
  await new Promise<void>((resolve) => rl.once("close", resolve));
  await pending;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? `error: ${error.message}` : error);
  process.exitCode = 1;
});
