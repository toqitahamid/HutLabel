import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Existing labels are never changed or removed by the candidate-review feature.
// That is a promise about code that no unit test can reach — the API functions
// need Clerk and Neon to run — so it is enforced here at the source level
// instead: every SQL statement the feature can execute must target only the two
// tables it owns, and `huts` / `orthos` may never appear as a write target.
//
// Turning confirmed candidates into huts would be a separate, owner-approved
// step. Nothing in this feature does it, and this test is what keeps that true
// the next time someone edits these files.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Every file in the feature that can issue SQL.
const SQL_BEARING_FILES = [
  "api/candidates/index.ts",
  "api/candidates/[id]/review.ts",
  "api/candidates-export.ts",
  "scripts/import-candidates.mjs",
  "scripts/migrations/004-candidates.sql",
];

// The only relations this feature may create or write.
const OWNED = new Set(["candidates", "candidate_reviews", "candidates_ortho_batch_idx"]);
const OFF_LIMITS = ["huts", "orthos"];

// Strip comments without mangling strings: prose about `huts` is everywhere in
// these files, and a naive regex would either miss a real statement or trip
// over a `//` inside a string literal. Walks the text tracking quote state.
function stripComments(source: string, sqlStyle: boolean): string {
  let out = "";
  let quote: string | null = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\" && quote !== "'") {
        out += "  "; // skip the escaped character, keep the offsets sane
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      continue;
    }
    if (!sqlStyle && c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (!sqlStyle && c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    if (sqlStyle && c === "-" && next === "-") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += c;
  }
  return out;
}

// Comment-free, whitespace-collapsed, lowercased source. `do update` (the
// upsert clause) is folded to one token first so it is never read as an UPDATE
// against a table called "set".
function sqlText(relativePath: string): string {
  const raw = readFileSync(path.join(ROOT, relativePath), "utf8");
  return stripComments(raw, relativePath.endsWith(".sql"))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bdo update\b/g, "do_update");
}

const WRITE_STATEMENT =
  /\b(insert\s+into|update|delete\s+from|truncate\s+table|truncate|alter\s+table|drop\s+table|drop\s+index|create\s+table|create\s+index)\s+(?:if\s+(?:not\s+)?exists\s+)?["`]?([a-z_][a-z0-9_]*)/g;

function writeTargets(relativePath: string): { verb: string; table: string }[] {
  const found: { verb: string; table: string }[] = [];
  for (const m of sqlText(relativePath).matchAll(WRITE_STATEMENT)) {
    found.push({ verb: m[1].replace(/\s+/g, " "), table: m[2] });
  }
  return found;
}

describe("the candidate feature never writes to huts or orthos", () => {
  for (const file of SQL_BEARING_FILES) {
    it(`${file} writes only to the tables it owns`, () => {
      const stray = writeTargets(file).filter((t) => !OWNED.has(t.table));
      expect(stray).toEqual([]);
    });

    it(`${file} never names huts or orthos as a write target`, () => {
      const text = sqlText(file);
      for (const table of OFF_LIMITS) {
        for (const verb of [
          "insert into",
          "update",
          "delete from",
          "truncate",
          "alter table",
          "drop table",
        ]) {
          expect(text).not.toContain(`${verb} ${table}`);
        }
      }
    });
  }

  it("reads orthos but never writes it (the validation path needs the sizes)", () => {
    // Positive control: if this select ever disappears the batch validation has
    // stopped checking boxes against their ortho, and the tests above would
    // still pass.
    expect(sqlText("api/candidates/index.ts")).toContain("from orthos");
    expect(sqlText("scripts/import-candidates.mjs")).toContain("from orthos");
  });

  it("migration 004 alters and drops nothing", () => {
    const text = sqlText("scripts/migrations/004-candidates.sql");
    expect(text).not.toContain("alter ");
    expect(text).not.toContain("drop "); // the rollback block is commented out
    // And it creates exactly the two tables it is supposed to.
    expect(writeTargets("scripts/migrations/004-candidates.sql").map((t) => t.table)).toEqual([
      "candidates",
      "candidates_ortho_batch_idx",
      "candidate_reviews",
    ]);
  });

  it("has no accept-candidate-as-hut path anywhere in the feature", () => {
    for (const file of SQL_BEARING_FILES) {
      expect(sqlText(file)).not.toContain("insert into huts");
    }
  });
});

describe("every hut mutation refuses during review at the handler level", () => {
  // The keymap test (src/keymap.test.ts) proves no KEY can reach these while
  // reviewing. This checks the other half: the handlers themselves refuse, so a
  // click, a Leaflet drag or an in-flight async continuation cannot either.
  const HUT_MUTATORS = [
    "handlePlace",
    "handleEditBox",
    "handleToggleConfidence",
    "handleDelete",
    "handleUndo",
    "handleRedo",
  ];

  const app = readFileSync(path.join(ROOT, "src/App.tsx"), "utf8");

  for (const handler of HUT_MUTATORS) {
    it(`${handler} bails out when review mode is on`, () => {
      const at = app.indexOf(`const ${handler} = useCallback(`);
      expect(at, `${handler} not found — was it renamed?`).toBeGreaterThan(-1);
      // The guard is the first thing in the body, so a short window is enough
      // and a guard buried below other work would (rightly) fail this.
      const head = app.slice(at, at + 400);
      expect(head).toContain("reviewModeRef.current");
    });
  }
});
