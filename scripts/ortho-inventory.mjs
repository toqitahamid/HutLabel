#!/usr/bin/env node
// Canonical mapping from the 41 raw ortho .tif filenames in data/Orthomosaics/
// to {id, site, visit, path}. Filenames are inconsistent (mixed separators,
// "-ortho"/"ortho"/"orthocopy"/"orthoreal" junk, underscore vs CamelCase site
// names), so this is the single place that resolves them — anything that reads
// or seeds the orthos table should import from here rather than re-parsing
// filenames itself.
//
// Run directly to print the 41-row table plus an A/B site-pairing audit:
//   node scripts/ortho-inventory.mjs

import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
export const ORTHOS_DIR = join(ROOT, "data", "Orthomosaics");

// Visit letter comes from the parent dir (Orthos_A / Orthos_B), not the
// filename — the filename's embedded letter is only used to locate where the
// site name ends and the "ortho" junk begins.
const VISIT_DIRS = { Orthos_A: "A", Orthos_B: "B" };

const SUFFIX_RE = /_transparent_mosaic_group\d+\.tif$/i;
// Greedy .+ so it anchors to the rightmost (only) "<A|B>[-]ortho<junk>" marker,
// covering "-ortho", "ortho", "orthocopy", "orthoreal", etc.
const SITE_VISIT_RE = /^(.+)([AB])-?ortho\w*$/;

// "Eldon_Hazlet" / "EldonHazlet" -> ["Eldon", "Hazlet"]; underscores and
// CamelCase boundaries both count as word separators so visits that spell the
// same site differently (e.g. "Double_T" vs "DoubleT") still resolve to one key.
function splitWords(raw) {
  const spaced = raw
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced.split(/\s+/).filter(Boolean);
}

function slugify(words) {
  return words.join("-").toLowerCase();
}

// Parses one filename into {site, siteKey, id, warning}. Throws if the
// filename doesn't contain a recognizable "<site><A|B>[-]ortho..." marker —
// a parse failure here means a new/renamed file needs a rule, not a silent
// mis-tile.
function parseFile(filename, dirVisit) {
  const stem = filename.replace(SUFFIX_RE, "");
  const m = stem.match(SITE_VISIT_RE);
  if (!m) {
    throw new Error(`Cannot parse site/visit marker out of filename: ${filename}`);
  }
  const [, rawSite, letter] = m;
  let warning = null;
  if (letter !== dirVisit) {
    warning = `filename visit letter '${letter}' disagrees with directory visit '${dirVisit}'`;
  }
  const words = splitWords(rawSite);
  const site = words.join(" ");
  const siteKey = slugify(words);
  return { site, siteKey, id: `${siteKey}-${dirVisit.toLowerCase()}`, warning };
}

export function buildInventory() {
  const rows = [];
  for (const [dirName, visit] of Object.entries(VISIT_DIRS)) {
    const dirPath = join(ORTHOS_DIR, dirName);
    for (const filename of readdirSync(dirPath).sort()) {
      if (!filename.toLowerCase().endsWith(".tif")) continue;
      const { site, siteKey, id, warning } = parseFile(filename, visit);
      rows.push({ id, site, siteKey, visit, path: join(dirPath, filename), warning });
    }
  }
  rows.sort((a, b) => a.site.localeCompare(b.site) || a.visit.localeCompare(b.visit));
  return rows;
}

function isMain() {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const rows = buildInventory();

  const idCounts = new Map();
  for (const r of rows) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1);
  const collisions = [...idCounts.entries()].filter(([, n]) => n > 1);

  console.log(`${rows.length} orthos found\n`);
  console.log(
    ["id", "site", "visit", "path"].join("\t"),
  );
  for (const r of rows) {
    console.log([r.id, r.site, r.visit, r.path].join("\t"));
  }

  const warned = rows.filter((r) => r.warning);
  if (warned.length) {
    console.log("\nWarnings:");
    for (const r of warned) console.log(`  ${r.path}: ${r.warning}`);
  }

  const bySiteKey = new Map();
  for (const r of rows) {
    if (!bySiteKey.has(r.siteKey)) bySiteKey.set(r.siteKey, { site: r.site, visits: new Set() });
    bySiteKey.get(r.siteKey).visits.add(r.visit);
  }
  const onlyA = [...bySiteKey.values()].filter((s) => s.visits.has("A") && !s.visits.has("B"));
  const onlyB = [...bySiteKey.values()].filter((s) => s.visits.has("B") && !s.visits.has("A"));

  console.log(`\nSites in A only (${onlyA.length}):`);
  for (const s of onlyA) console.log(`  ${s.site}`);
  console.log(`\nSites in B only (${onlyB.length}):`);
  for (const s of onlyB) console.log(`  ${s.site}`);

  if (collisions.length) {
    console.error(`\nID collisions: ${collisions.map(([id]) => id).join(", ")}`);
    process.exitCode = 1;
  }
}
