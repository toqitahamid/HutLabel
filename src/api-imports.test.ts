// Vercel runs api/ as real Node ESM, where a relative import without a file
// extension is ERR_MODULE_NOT_FOUND at runtime. Nothing else catches this:
// `tsc -p api` uses moduleResolution "bundler" and Vite resolves extensions for
// the browser, so an extensionless import typechecks, builds, unit-tests and
// deploys green, then 500s on every request to that route.
//
// That is exactly what shipped on 2026-09-17: src/candidates/model.ts imported
// "../huts/model", so every /api/candidates route threw before it could even
// return 401. api/huts survived only because src/huts/model.ts is a leaf with
// no imports of its own.
//
// So: walk the module graph reachable from api/ and require explicit extensions
// on every relative import. src/ files that only the browser loads keep the
// repo's extensionless house style.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const API = join(ROOT, "api");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith(".ts") && !full.endsWith(".test.ts") ? [full] : [];
  });
}

/** Every relative import in one file, as (specifier, resolved path or null). */
function imports(file: string): { spec: string; target: string | null }[] {
  const src = readFileSync(file, "utf8");
  const out: { spec: string; target: string | null }[] = [];
  for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^"';]*from\s+"(\.[^"]*)"/g)) {
    const spec = m[1];
    // ".js" here means "the .ts next to it", the standard TS-ESM convention.
    const guess = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
    let target: string | null = null;
    for (const c of [guess, guess + ".ts", join(guess, "index.ts")]) {
      try {
        if (statSync(c).isFile()) { target = c; break; }
      } catch { /* not this one */ }
    }
    out.push({ spec, target });
  }
  return out;
}

/** Every module Vercel actually loads: the api/ handlers and their transitive imports. */
function reachableFromApi(): string[] {
  const seen = new Set<string>();
  const queue = walk(API);
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const { target } of imports(file)) if (target && !seen.has(target)) queue.push(target);
  }
  return [...seen];
}

describe("modules the serverless runtime loads", () => {
  const reachable = reachableFromApi();

  it("reaches the api handlers and the src models they pull in", () => {
    const rel = reachable.map((f) => relative(ROOT, f));
    expect(rel).toContain("api/candidates/index.ts");
    expect(rel).toContain("api/huts/index.ts");
    expect(rel).toContain("src/candidates/model.ts");
    expect(rel).toContain("src/huts/model.ts"); // only reached via candidates/model
    expect(reachable.length).toBeGreaterThan(8);
  });

  it("uses an explicit .js extension on every relative import", () => {
    const bad = reachable.flatMap((file) =>
      imports(file)
        .filter(({ spec }) => !/\.(js|json|css)$/.test(spec))
        .map(({ spec }) => `${relative(ROOT, file)} imports "${spec}"`),
    );
    expect(bad).toEqual([]);
  });

  it("resolves every relative import to a file that exists", () => {
    const missing = reachable.flatMap((file) =>
      imports(file)
        .filter(({ target }) => target === null)
        .map(({ spec }) => `${relative(ROOT, file)} imports "${spec}"`),
    );
    expect(missing).toEqual([]);
  });
});
