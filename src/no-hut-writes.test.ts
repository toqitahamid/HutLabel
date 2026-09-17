import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Existing labels are never changed or removed by the candidate-review feature.
// That is a promise about code no unit test can execute — the API functions
// need Clerk and Neon to run — so it is enforced here at the source level
// instead: every SQL statement the app can issue must target only a relation on
// the allowlist, and `huts` / `orthos` may never appear as a write target.
//
// The sweep is a glob, not a hand-kept list, so a new file under api/ or
// scripts/ is covered the day it is written rather than the day someone
// remembers to add it here. The files that legitimately write the label tables
// all predate this feature and are named explicitly below.
//
// Turning confirmed candidates into huts would be a separate, owner-approved
// step. Nothing in this feature does it, and this test is what keeps that true
// the next time someone edits these files.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCAN_DIRS: { dir: string; extensions: string[] }[] = [
  { dir: "api", extensions: [".ts"] },
  { dir: "scripts", extensions: [".mjs", ".sql"] },
  { dir: "src", extensions: [".ts"] },
];

// Pre-existing routes and migrations whose whole job is to write the label
// tables. They are out of scope for this feature and untouched by it.
const PREEXISTING = new Set([
  "api/huts/index.ts",
  "api/huts/[id].ts",
  "api/orthos.ts",
  "scripts/seed-orthos.mjs",
  "scripts/migrations/001-orthos-done-at.sql",
  "scripts/migrations/002-drop-hut-attributes.sql",
  "scripts/migrations/003-huts-confidence.sql",
]);

// The only relations the candidate feature may create or write.
const OWNED = new Set(["candidates", "candidate_reviews", "candidates_ortho_batch_idx"]);
const OFF_LIMITS = ["huts", "orthos"];

function walk(dir: string, extensions: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel, extensions));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(rel);
  }
  return out;
}

// Test files are skipped: they issue no SQL, and they quote statements like
// "insert into huts" on purpose to assert those are absent.
const SCANNED = SCAN_DIRS.flatMap(({ dir, extensions }) => walk(dir, extensions))
  .filter((f) => !PREEXISTING.has(f))
  .filter((f) => !/\.test\.(ts|mjs)$/.test(f))
  .sort();

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

// `do update` (the upsert clause) is folded to one token so it is never read as
// an UPDATE against a table called "set".
function normalize(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bdo update\b/g, "do_update")
    .trim();
}

function sourceOf(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function commentFree(relativePath: string): string {
  return normalize(stripComments(sourceOf(relativePath), relativePath.endsWith(".sql")));
}

// The regions that actually reach a database: a .sql file in full, and for
// TypeScript/JavaScript only the tagged-template literals that look like SQL.
// Scanning whole .ts files would flag ordinary identifiers (a variable called
// `copy`, a `update` in a prop name); scanning only the templates has no false
// positives and still sees everything the Neon driver is handed.
function sqlRegions(relativePath: string): string[] {
  const stripped = stripComments(sourceOf(relativePath), relativePath.endsWith(".sql"));
  if (relativePath.endsWith(".sql")) return [normalize(stripped)];
  const regions: string[] = [];
  for (const match of stripped.matchAll(/`([^`]*)`/g)) {
    const body = normalize(match[1]);
    if (
      /\b(select|insert|update|delete|create|alter|drop|merge|copy|grant|truncate)\b/.test(body)
    ) {
      regions.push(body);
    }
  }
  return regions;
}

const WRITE_VERBS = [
  "insert into",
  "merge into",
  "update",
  "delete from",
  "truncate table",
  "truncate",
  "alter table",
  "drop table",
  "drop index",
  "create table",
  "create index",
  "create or replace function",
  "create function",
  "create or replace rule",
  "create rule",
  "create or replace trigger",
  "create trigger",
  "copy",
  "grant",
];

// The verb, then whatever sits in the table position. Captured as \S+ rather
// than an identifier pattern on purpose: an interpolated table name has to be
// SEEN and rejected, not quietly skipped by a regex that doesn't match it.
const WRITE_STATEMENT = new RegExp(
  `\\b(${WRITE_VERBS.join("|")})\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(\\S+)`,
  "g",
);

const IDENTIFIER = /^["`]?([a-z_][a-z0-9_]*)["`]?$/;

type Target = { verb: string; token: string; identifier: string | null };

function writeTargets(relativePath: string): Target[] {
  const found: Target[] = [];
  for (const region of sqlRegions(relativePath)) {
    for (const m of region.matchAll(WRITE_STATEMENT)) {
      const token = m[2];
      found.push({ verb: m[1], token, identifier: IDENTIFIER.exec(token)?.[1] ?? null });
    }
  }
  return found;
}

describe("the app never writes to huts or orthos outside the pre-existing routes", () => {
  it("scans the files it is supposed to", () => {
    // A broken walker would make every test below pass vacuously.
    for (const file of [
      "api/candidates/index.ts",
      "api/candidates/[id]/review.ts",
      "api/candidates-export.ts",
      "api/export.ts",
      "scripts/import-candidates.mjs",
      "scripts/migrations/004-candidates.sql",
    ]) {
      expect(SCANNED).toContain(file);
    }
    for (const file of PREEXISTING) expect(SCANNED).not.toContain(file);
  });

  for (const file of SCANNED) {
    it(`${file} writes only to the tables the feature owns`, () => {
      const stray = writeTargets(file).filter(
        (t) => t.identifier === null || !OWNED.has(t.identifier),
      );
      expect(stray).toEqual([]);
    });

    it(`${file} never names huts or orthos as a write target`, () => {
      const text = commentFree(file);
      for (const table of OFF_LIMITS) {
        for (const verb of WRITE_VERBS) {
          expect(text).not.toContain(`${verb} ${table}`);
        }
      }
    });

    it(`${file} builds no table name by interpolation`, () => {
      // `insert into ${table}` would slip past a check that only looks for
      // literal table names, so a dynamic table position is itself a failure.
      const dynamic = writeTargets(file).filter((t) => t.identifier === null);
      expect(dynamic).toEqual([]);
    });
  }

  it("reads orthos but never writes it (the validation path needs the sizes)", () => {
    // Positive control: if these selects ever disappear the batch validation
    // has stopped checking boxes against their ortho, and the tests above would
    // still pass.
    expect(commentFree("api/candidates/index.ts")).toContain("from orthos");
    expect(commentFree("scripts/import-candidates.mjs")).toContain("from orthos");
  });

  it("has no accept-candidate-as-hut path anywhere", () => {
    for (const file of SCANNED) {
      expect(commentFree(file)).not.toContain("insert into huts");
    }
  });
});

describe("migration 004", () => {
  const FILE = "scripts/migrations/004-candidates.sql";

  it("alters and drops nothing", () => {
    const text = commentFree(FILE);
    expect(text).not.toContain("alter ");
    expect(text).not.toContain("drop "); // the rollback block is commented out
    expect(writeTargets(FILE).map((t) => t.identifier)).toEqual([
      "candidates",
      "candidates_ortho_batch_idx",
      "candidate_reviews",
    ]);
  });

  it("does not name the label table at all, even in prose", () => {
    // Checked against the RAW file, comments included: the migration has no
    // business referring to the label table, so there is nothing for a later
    // edit to turn into a statement by accident. `orthos` is exempt — the
    // foreign key needs it.
    expect(sourceOf(FILE).toLowerCase()).not.toContain("huts");
  });

  it("runs in one transaction and fails loudly on a re-run", () => {
    const text = commentFree(FILE);
    expect(text).toContain("begin;");
    expect(text).toContain("commit;");
    // Deliberately NOT `if not exists`: a second run should fail rather than
    // silently accept a leftover table of the wrong shape.
    expect(text).not.toContain("if not exists");
    expect(text).toContain("create table candidates");
    expect(text).toContain("create table candidate_reviews");
    expect(text).toContain("create index candidates_ortho_batch_idx");
  });

  it("carries the constraints the live schema uses", () => {
    const text = commentFree(FILE);
    expect(text).toContain("ortho_id text not null references orthos(id) on delete cascade");
    for (const check of [
      "check (rank >= 1)",
      "check (x >= 0)",
      "check (y >= 0)",
      "check (w > 0)",
      "check (h > 0)",
    ]) {
      expect(text).toContain(check);
    }
  });

  it("ships a commented-out rollback", () => {
    const raw = sourceOf(FILE);
    expect(raw).toContain("-- drop table candidate_reviews;");
    expect(raw).toContain("-- drop table candidates;");
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

  const app = sourceOf("src/App.tsx");

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
