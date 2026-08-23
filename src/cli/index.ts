#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Command } from "commander";

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { version: string };

const program = new Command()
  .name("casefile")
  .description("An investigating verifier for payment fraud alerts.")
  .version(packageJson.version);

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
