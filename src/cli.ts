#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parse } from "./parser.js";
import { BeliefRuntime } from "./runtime.js";

async function main(argv: string[]): Promise<number> {
  const [, , command, ...args] = argv;

  if (command !== "run") {
    console.error("usage: bel run <file.bel> [--trace]");
    return 2;
  }

  const unknownFlags = args.filter(
    (arg) => arg.startsWith("--") && arg !== "--trace",
  );

  if (unknownFlags.length > 0) {
    console.error(`unknown flags: ${unknownFlags.join(", ")}`);
    return 2;
  }

  const filePath = args.find((arg) => !arg.startsWith("--"));
  if (!filePath) {
    console.error("usage: bel run <file.bel> [--trace]");
    return 2;
  }

  const trace = args.includes("--trace");

  const source = await readFile(filePath, "utf8");
  const statements = parse(source);
  await new BeliefRuntime({}, { trace }).run(statements);

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
