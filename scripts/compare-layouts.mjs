#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadStructuralPeople } from "../frontend/src/layout/structural-fixture.js";
import { compareLayouts } from "../frontend/tests/helpers/compare-layouts.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturePath =
  process.argv[2] ||
  path.join(root, "frontend/tests/fixtures/structural-tree.topology.json");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
const people = loadStructuralPeople(fixture);
const centerId = process.argv[3] || fixture.meta.defaultCenterId;

const vertical = compareLayouts(people, centerId, { isHorizontal: false });
const horizontal = compareLayouts(people, centerId, { isHorizontal: true });

console.log(
  JSON.stringify(
    {
      fixture: fixturePath,
      source: fixture.meta.source,
      personCount: fixture.personCount,
      centerId,
      vertical,
      horizontal,
    },
    null,
    2,
  ),
);
