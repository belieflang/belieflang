#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parse } from "./parser.js";
import { BeliefRuntime } from "./runtime.js";
import { createJevInferAdapter, type JevUsage } from "./jev.js";
import { createOpenAIInferAdapter } from "./openai.js";

const usageText = "usage: bel run <file.bel> [--trace] [--engine heuristic|jev|chatgpt] [--usage]";

async function main(argv: string[]): Promise<number> {
  const [, , command, ...args] = argv;

  if (command !== "run") {
    console.error(usageText);
    return 2;
  }

  const engineIndex = args.indexOf("--engine");
  const engine = engineIndex >= 0 ? args[engineIndex + 1] : "heuristic";
  const positional = args.filter((_arg, index) =>
    engineIndex < 0 || (index !== engineIndex && index !== engineIndex + 1)
  );
  const unknownFlags = positional.filter(
    (arg) => arg.startsWith("--") && arg !== "--trace" && arg !== "--usage",
  );

  if (unknownFlags.length > 0 || !["heuristic", "jev", "chatgpt"].includes(engine) ||
      positional.filter((arg) => !arg.startsWith("--")).length !== 1) {
    console.error(usageText);
    return 2;
  }

  const filePath = positional.find((arg) => !arg.startsWith("--"));
  if (!filePath) {
    console.error(usageText);
    return 2;
  }

  const trace = positional.includes("--trace");
  const showUsage = positional.includes("--usage");
  const usage: JevUsage = { input_tokens: 0, output_tokens: 0 };
  const onUsage = (call: JevUsage) => {
    usage.input_tokens += call.input_tokens;
    usage.output_tokens += call.output_tokens;
  };
  const inferBeliefs = engine === "jev"
    ? createJevInferAdapter({
        apiKey: process.env.TYPESAFE_API_KEY ?? "",
        model: process.env.JEV_MODEL,
        onUsage,
      })
    : engine === "chatgpt"
      ? createOpenAIInferAdapter({
          apiKey: process.env.OPENAI_API_KEY ?? "",
          model: process.env.OPENAI_MODEL,
          onUsage,
        })
      : undefined;

  const source = await readFile(filePath, "utf8");
  const statements = parse(source);
  await new BeliefRuntime({}, { trace, inferBeliefs }).run(statements);
  if (showUsage) console.log(`[usage] ${JSON.stringify(usage)}`);

  return 0;
}

main(process.argv)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(`error: ${error.message}`);
    } else {
      console.error("error:", error);
    }

    process.exitCode = 1;
  });
