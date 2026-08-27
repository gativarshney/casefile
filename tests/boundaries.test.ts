/**
 * The investigation path must not be able to see the answers.
 *
 * Casefile's evaluation only means something if the code that produces a verdict has no
 * access to ground truth or to the generator that created it. That is a claim about the
 * import graph, so it is checked as one — statically, over the real source tree.
 *
 * The checker is exercised against a deliberate violation as well as the real package,
 * so it cannot quietly become a no-op if a module is renamed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = resolve(fileURLToPath(new URL("../src", import.meta.url)));

/** Directories whose code runs while producing a verdict. */
const INVESTIGATION_PACKAGES = ["evidence", "probes", "verify", "case", "replay", "llm"];

/** Modules that reveal ground truth, the generative process, or the scoring harness. */
const FORBIDDEN = ["world/generate", "world/labels", "eval"];

function importSpecifiers(source: string): string[] {
  const file = ts.createSourceFile("probe.ts", source, ts.ScriptTarget.ES2023, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteral(first)) found.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  return found;
}

/** Segment-wise so `world/generated-helpers` is not mistaken for `world/generate`. */
function reaches(specifier: string, banned: string): boolean {
  const segments = specifier
    .replace(/\.js$/, "")
    .split("/")
    .filter((segment) => segment !== "." && segment !== "..");
  const target = banned.split("/");
  return segments.some((_, start) =>
    target.every((segment, offset) => segments[start + offset] === segment),
  );
}

function violations(source: string): string[] {
  const specifiers = importSpecifiers(source);
  return FORBIDDEN.filter((banned) => specifiers.some((specifier) => reaches(specifier, banned)));
}

function typescriptFilesIn(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return typescriptFilesIn(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the checker discriminates", () => {
  it("catches a direct import of the generator", () => {
    expect(violations('import { generateWorld } from "../world/generate.js";')).toEqual([
      "world/generate",
    ]);
  });

  it("catches a type-only import, which is still a dependency on the shape", () => {
    expect(violations('import type { Labels } from "../world/labels.js";')).toEqual([
      "world/labels",
    ]);
  });

  it("catches a re-export", () => {
    expect(violations('export { x } from "../world/generate.js";')).toEqual(["world/generate"]);
  });

  it("catches a dynamic import", () => {
    expect(violations('const m = await import("../world/generate.js");')).toEqual([
      "world/generate",
    ]);
  });

  it("catches reaching into the evaluation harness", () => {
    expect(violations('import { score } from "../eval/metrics.js";')).toEqual(["eval"]);
  });

  it("does not fire on a similarly named module", () => {
    expect(violations('import { x } from "../world/generated-helpers.js";')).toEqual([]);
  });

  it("leaves permitted imports alone", () => {
    const source = [
      'import { WorldReader } from "../world/store.js";',
      'import { digest } from "../canon/hash.js";',
    ].join("\n");
    expect(violations(source)).toEqual([]);
  });
});

describe("the real source tree", () => {
  it("guards packages that actually exist", () => {
    const present = INVESTIGATION_PACKAGES.filter(
      (pkg) => typescriptFilesIn(join(SOURCE_ROOT, pkg)).length > 0,
    );
    expect(present.length).toBeGreaterThan(0);
  });

  it("no module on the investigation path reaches ground truth", () => {
    const offenders: Record<string, string[]> = {};
    for (const pkg of INVESTIGATION_PACKAGES) {
      for (const file of typescriptFilesIn(join(SOURCE_ROOT, pkg))) {
        const found = violations(readFileSync(file, "utf8"));
        if (found.length > 0) offenders[file.replace(SOURCE_ROOT, "src")] = found;
      }
    }
    expect(offenders).toEqual({});
  });

  it("the world store carries no dependency on the generator", () => {
    // Keeps the boundary transitive: the investigation path imports the store, so the
    // store must not be a route to anything the path is not allowed to see.
    const source = readFileSync(join(SOURCE_ROOT, "world", "store.ts"), "utf8");
    expect(violations(source)).toEqual([]);
  });

  it("the generator is allowed to import the store, but not the reverse", () => {
    const generator = readFileSync(join(SOURCE_ROOT, "world", "generate", "index.ts"), "utf8");
    expect(importSpecifiers(generator).some((s) => s.includes("store"))).toBe(true);
  });

  it("the world store carries no dependency on the answer key", () => {
    const source = readFileSync(join(SOURCE_ROOT, "world", "store.ts"), "utf8");
    expect(importSpecifiers(source).some((s) => s.includes("labels"))).toBe(false);
  });

  it("labels and the generator are reachable only from generation and evaluation", () => {
    const allowed = ["world/generate", "eval", "cli"];
    const offenders: string[] = [];
    for (const pkg of ["canon", "reference", "alerting", ...INVESTIGATION_PACKAGES]) {
      for (const file of typescriptFilesIn(join(SOURCE_ROOT, pkg))) {
        const relative = file.replace(SOURCE_ROOT, "").split(sep).join("/");
        if (allowed.some((prefix) => relative.includes(prefix))) continue;
        if (violations(readFileSync(file, "utf8")).length > 0) offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});
