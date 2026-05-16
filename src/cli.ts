#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { parse } from "./parser.js";
import { BeliefRuntime } from "./runtime.js";

async function main(argv: string[]): Promise<number> {
  const [, , command, filePath] = argv;

  if (command !== "run" || !filePath) {
    console.error("usage: bel run <file.bel>");
    return 2;
  }

  const source = await readFile(filePath, "utf8");
  const statements = parse(source);
  await new BeliefRuntime().run(statements);

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
