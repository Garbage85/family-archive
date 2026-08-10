#!/usr/bin/env node
/**
 * Builds the committed structural fixture used when a live production dump
 * is not available in the agent environment.
 *
 * Topology intentionally exercises ADR-008 failure modes:
 * multiple generations, siblings with spouses, multiple spouses,
 * center spouse parents/children, spouse-only child.
 *
 * When production trees.data becomes available, prefer:
 *   node scripts/extract-structural-fixture.mjs --input <dump> --output ...
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  anonymizeTreeTopology,
  assertNoPiiInFixture,
} from "../frontend/src/layout/structural-fixture.js";

function person(id, gender, rels = {}) {
  return {
    id,
    data: { gender },
    rels: { parents: [], children: [], spouses: [], ...rels },
  };
}

function topology() {
  // Generations (blood):
  // g0: gf1,gm1  gf2,gm2
  // g1: father,mother  wife-father,wife-mother  uncle,aunt
  // g2: center + siblings  (+ center-wife)
  // g3: children
  return [
    person("gf1", "M", { spouses: ["gm1"], children: ["father", "uncle"] }),
    person("gm1", "F", { spouses: ["gf1"], children: ["father", "uncle"] }),
    person("gf2", "M", { spouses: ["gm2"], children: ["mother"] }),
    person("gm2", "F", { spouses: ["gf2"], children: ["mother"] }),
    person("father", "M", {
      parents: ["gf1", "gm1"],
      spouses: ["mother"],
      children: ["center", "brother-a", "brother-b", "sister"],
    }),
    person("mother", "F", {
      parents: ["gf2", "gm2"],
      spouses: ["father"],
      children: ["center", "brother-a", "brother-b", "sister"],
    }),
    person("uncle", "M", {
      parents: ["gf1", "gm1"],
      spouses: ["aunt"],
      children: ["cousin"],
    }),
    person("aunt", "F", { spouses: ["uncle"], children: ["cousin"] }),
    person("cousin", "F", { parents: ["uncle", "aunt"] }),
    person("wife-father", "M", {
      spouses: ["wife-mother"],
      children: ["center-wife"],
    }),
    person("wife-mother", "F", {
      spouses: ["wife-father"],
      children: ["center-wife"],
    }),
    person("center", "M", {
      parents: ["father", "mother"],
      spouses: ["center-wife"],
      children: ["shared-child", "center-son"],
    }),
    person("center-wife", "F", {
      parents: ["wife-father", "wife-mother"],
      spouses: ["center"],
      children: ["shared-child", "wife-only-child"],
    }),
    person("brother-a", "M", {
      parents: ["father", "mother"],
      spouses: ["brother-a-wife"],
      children: ["nephew-a"],
    }),
    person("brother-a-wife", "F", {
      spouses: ["brother-a"],
      children: ["nephew-a"],
    }),
    person("brother-b", "M", {
      parents: ["father", "mother"],
      spouses: ["brother-b-wife-1", "brother-b-wife-2"],
    }),
    person("brother-b-wife-1", "F", { spouses: ["brother-b"] }),
    person("brother-b-wife-2", "F", { spouses: ["brother-b"] }),
    person("sister", "F", {
      parents: ["father", "mother"],
      spouses: ["sister-husband"],
      children: ["niece"],
    }),
    person("sister-husband", "M", { spouses: ["sister"], children: ["niece"] }),
    person("shared-child", "F", { parents: ["center", "center-wife"] }),
    person("center-son", "M", { parents: ["center", "center-wife"] }),
    person("wife-only-child", "M", { parents: ["center-wife"] }),
    person("nephew-a", "M", { parents: ["brother-a", "brother-a-wife"] }),
    person("niece", "F", { parents: ["sister", "sister-husband"] }),
  ];
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = path.join(
    root,
    "frontend/tests/fixtures/structural-tree.topology.json",
  );
  const fixture = anonymizeTreeTopology(topology());
  fixture.meta.source =
    "synthetic-structural-topology: production trees.data was not available in the agent VM; topology encodes multi-generation sibling-spouse ADR-008 structure for layout prototyping. Replace via extract-structural-fixture.mjs when a read-only dump is provided.";
  fixture.meta.extractedAt = new Date().toISOString();
  fixture.meta.productionDumpAvailable = false;
  assertNoPiiInFixture(fixture);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`, "utf8");
  console.log(
    JSON.stringify(
      {
        output,
        personCount: fixture.personCount,
        defaultCenterId: fixture.meta.defaultCenterId,
        spouseEdgeCount: fixture.meta.spouseEdgeCount,
        parentChildEdgeCount: fixture.meta.parentChildEdgeCount,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
