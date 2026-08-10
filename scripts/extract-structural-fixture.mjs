#!/usr/bin/env node
/**
 * Read-only extractor: trees.data JSON -> anonymized structural fixture.
 *
 * Usage:
 *   node scripts/extract-structural-fixture.mjs --input /path/to/trees.data.json --output frontend/tests/fixtures/structural-tree.topology.json
 *
 * Input may be:
 *   - a people array
 *   - { data: people[] }
 *   - a PocketBase trees record { data: people[] }
 *
 * Never writes to PocketBase. Strips PII before writing the fixture.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  anonymizeTreeTopology,
  assertNoPiiInFixture,
} from "../frontend/src/layout/structural-fixture.js";

function parseArgs(argv) {
  const args = { input: null, output: null, sourceNote: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--input") args.input = argv[++i];
    else if (token === "--output") args.output = argv[++i];
    else if (token === "--source-note") args.sourceNote = argv[++i];
  }
  return args;
}

function extractPeople(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.record?.data)) return payload.record.data;
  throw new Error(
    "Input JSON must be a people array or an object with data: people[]",
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const envPath = process.env.PRODUCTION_TREES_DATA_PATH;
  const envJson = process.env.PRODUCTION_TREES_DATA_JSON;
  const inputPath = args.input || envPath;
  let payload;
  if (inputPath) {
    payload = JSON.parse(await readFile(inputPath, "utf8"));
  } else if (envJson) {
    payload = JSON.parse(envJson);
  } else {
    throw new Error(
      "Provide --input PATH, PRODUCTION_TREES_DATA_PATH, or PRODUCTION_TREES_DATA_JSON",
    );
  }

  const people = extractPeople(payload);
  const fixture = anonymizeTreeTopology(people);
  fixture.meta.source =
    args.sourceNote || (inputPath ? path.resolve(inputPath) : "env:JSON");
  fixture.meta.extractedAt = new Date().toISOString();
  assertNoPiiInFixture(fixture);

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output =
    args.output ||
    path.join(root, "frontend/tests/fixtures/structural-tree.topology.json");
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output,
        personCount: fixture.personCount,
        spouseEdgeCount: fixture.meta.spouseEdgeCount,
        parentChildEdgeCount: fixture.meta.parentChildEdgeCount,
        defaultCenterId: fixture.meta.defaultCenterId,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
