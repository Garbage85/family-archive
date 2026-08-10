import * as f3 from 'family-chart';
import { prepareFamilyChartData } from '../../src/adapters/family-chart-data.js';
import { layoutFamilyTree, selectVisiblePeople } from '../../src/layout/family-layout.js';
import {
  analyzeParentChildEdges,
  collectTopologyParentChildEdges,
  findCardOverlaps,
  findMissingVisibleParentChildLinks,
  findMissingVisibleSpouseLinks,
  summarizeLayout,
  boundingBox,
} from '../../src/layout/layout-validators.js';

const CARD_WIDTH = 184;
const CARD_HEIGHT = 170;
const NODE_SEPARATION = 236;
const LEVEL_SEPARATION = 224;

function timed(fn) {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

/**
 * Count unique topology parent→child edges among a displayed id set.
 * This is the apples-to-apples metric vs prototype parentChildLinks.
 */
function countUniqueTopologyParentChild(people, displayedIds) {
  const shown = new Set([...displayedIds].map(String));
  return collectTopologyParentChildEdges(people).filter(
    (edge) => shown.has(edge.parent) && shown.has(edge.child),
  ).length;
}

function familyChartVisibleLayout(people, centerId, { isHorizontal = false } = {}) {
  const chartData = prepareFamilyChartData(people);
  const { result: tree, ms } = timed(() =>
    f3.calculateTree(structuredClone(chartData), {
      main_id: centerId,
      node_separation: NODE_SEPARATION,
      level_separation: LEVEL_SEPARATION,
      show_siblings_of_main: true,
      single_parent_empty_card: false,
      is_horizontal: isHorizontal,
      ancestry_depth: 8,
      progeny_depth: 8,
    }),
  );

  const nodes = tree.data.map((node) => ({
    id: String(node.data.id),
    x: node.x,
    y: node.y,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    generation: isHorizontal ? node.x / NODE_SEPARATION : node.y / LEVEL_SEPARATION,
  }));

  const spouseLinks = [];
  const parentChildLinksRaw = [];
  const parentChildFromParents = [];
  const parentChildFromAncestryParent = [];
  const byId = new Map(tree.data.map((node) => [String(node.data.id), node]));

  for (const node of tree.data) {
    for (const spouse of node.spouses || []) {
      const a = String(node.data.id);
      const b = String(spouse.data.id);
      const key = [a, b].sort().join('|');
      if (!spouseLinks.some((link) => link.key === key)) {
        spouseLinks.push({
          key,
          type: 'spouse',
          source: a,
          target: b,
          points: [
            [node.x, node.y],
            [spouse.x, spouse.y],
          ],
        });
      }
    }
    for (const parent of node.parents || []) {
      const edge = {
        type: 'parent-child',
        source: String(parent.data.id),
        target: String(node.data.id),
        via: 'parents[]',
        points: [
          [parent.x, parent.y],
          [node.x, node.y],
        ],
      };
      parentChildLinksRaw.push(edge);
      parentChildFromParents.push(edge);
    }
    // Family Chart ancestry nodes keep a reverse `parent` pointer (child → ancestor
    // in walk order). Counting those as parent-child edges overcounts real topology
    // edges (same geometric relation counted twice, often with reversed endpoints).
    if (node.parent && !node.parents?.length) {
      const edge = {
        type: 'parent-child',
        source: String(node.parent.data.id),
        target: String(node.data.id),
        via: 'ancestry.parent',
        points: [
          [node.parent.x, node.parent.y],
          [node.x, node.y],
        ],
      };
      parentChildLinksRaw.push(edge);
      parentChildFromAncestryParent.push(edge);
    }
  }

  const expectedVisible = selectVisiblePeople(chartData, centerId).map((person) => person.id);
  const shown = new Set(nodes.map((node) => node.id));
  const lostNodes = expectedVisible.filter((id) => !shown.has(id));

  // Sibling spouses expected by household-closed visibility but missing in FC:
  const missingSiblingSpouses = [];
  for (const node of tree.data.filter((item) => item.sibling)) {
    const person = chartData.find((item) => item.id === String(node.data.id));
    for (const spouseId of person?.rels.spouses || []) {
      if (!shown.has(String(spouseId))) missingSiblingSpouses.push([person.id, spouseId]);
    }
  }

  const displayedIds = nodes.map((node) => node.id);
  const parentChildLinksUnique = countUniqueTopologyParentChild(chartData, displayedIds);

  const layout = {
    nodes,
    links: [...spouseLinks, ...parentChildLinksRaw],
  };

  return {
    engine: 'family-chart',
    ms,
    inputCount: people.length,
    displayedCount: nodes.length,
    spouseLinks: spouseLinks.length,
    // Raw engine pointer count (includes reverse ancestry.parent extras).
    parentChildLinks: parentChildLinksRaw.length,
    parentChildLinksRaw: parentChildLinksRaw.length,
    parentChildLinksUnique,
    parentChildFromParents: parentChildFromParents.length,
    parentChildFromAncestryParent: parentChildFromAncestryParent.length,
    overlaps: findCardOverlaps(nodes).length,
    lostNodes: lostNodes.length,
    lostNodeIds: lostNodes,
    missingSiblingSpouses: missingSiblingSpouses.length,
    boundingBox: boundingBox(nodes),
    summary: summarizeLayout(chartData, layout),
    byId,
  };
}

function prototypeLayout(people, centerId, { isHorizontal = false } = {}) {
  const { result, ms } = timed(() =>
    layoutFamilyTree(people, {
      centerId,
      orientation: isHorizontal ? 'horizontal' : 'vertical',
      cardWidth: CARD_WIDTH,
      cardHeight: CARD_HEIGHT,
      nodeSeparation: NODE_SEPARATION,
      levelSeparation: LEVEL_SEPARATION,
    }),
  );
  const expectedVisible = selectVisiblePeople(people, centerId).map((person) => person.id);
  const shown = new Set(result.nodes.map((node) => node.id));
  const lostNodes = expectedVisible.filter((id) => !shown.has(id));
  const summary = summarizeLayout(people, result);
  summary.lostNodes = lostNodes.length;
  const parentChildEdgeReport = analyzeParentChildEdges(people, result);
  return {
    engine: 'family-layout-prototype',
    ms,
    inputCount: people.length,
    displayedCount: result.nodes.length,
    spouseLinks: summary.spouseLinks,
    parentChildLinks: summary.parentChildLinks,
    parentChildLinksUnique: countUniqueTopologyParentChild(
      people,
      result.nodes.map((node) => node.id),
    ),
    overlaps: summary.overlaps,
    lostNodes: lostNodes.length,
    lostNodeIds: lostNodes,
    missingSiblingSpouses: 0,
    missingVisibleParentChildLinks: findMissingVisibleParentChildLinks(people, result).length,
    missingVisibleSpouseLinks: findMissingVisibleSpouseLinks(people, result).length,
    parentChildEdgeReport,
    boundingBox: summary.boundingBox,
    summary,
    layout: result,
  };
}

export function compareLayouts(people, centerId, options = {}) {
  const familyChart = familyChartVisibleLayout(people, centerId, options);
  const prototype = prototypeLayout(people, centerId, options);
  return {
    centerId,
    orientation: options.isHorizontal ? 'horizontal' : 'vertical',
    familyChart: {
      inputCount: familyChart.inputCount,
      displayedCount: familyChart.displayedCount,
      spouseLinks: familyChart.spouseLinks,
      parentChildLinks: familyChart.parentChildLinks,
      parentChildLinksRaw: familyChart.parentChildLinksRaw,
      parentChildLinksUnique: familyChart.parentChildLinksUnique,
      parentChildFromParents: familyChart.parentChildFromParents,
      parentChildFromAncestryParent: familyChart.parentChildFromAncestryParent,
      overlaps: familyChart.overlaps,
      lostNodes: familyChart.lostNodes,
      missingSiblingSpouses: familyChart.missingSiblingSpouses,
      boundingBox: familyChart.boundingBox,
      ms: familyChart.ms,
    },
    prototype: {
      inputCount: prototype.inputCount,
      displayedCount: prototype.displayedCount,
      spouseLinks: prototype.spouseLinks,
      parentChildLinks: prototype.parentChildLinks,
      parentChildLinksUnique: prototype.parentChildLinksUnique,
      overlaps: prototype.overlaps,
      lostNodes: prototype.lostNodes,
      missingSiblingSpouses: prototype.missingSiblingSpouses,
      missingVisibleParentChildLinks: prototype.missingVisibleParentChildLinks,
      missingVisibleSpouseLinks: prototype.missingVisibleSpouseLinks,
      boundingBox: prototype.boundingBox,
      ms: prototype.ms,
      spousePlacementIssues: prototype.summary.spousePlacementIssues,
      generationIssues: prototype.summary.generationIssues,
      linksThroughCards: prototype.summary.linksThroughCards,
    },
  };
}

export function scanPrototypeCenters(people, centerIds) {
  return centerIds.map((centerId) => {
    const report = compareLayouts(people, centerId);
    return {
      centerId,
      displayedCount: report.prototype.displayedCount,
      lostNodes: report.prototype.lostNodes,
      missingSiblingSpouses: report.prototype.missingSiblingSpouses,
      overlaps: report.prototype.overlaps,
      missingVisibleParentChildLinks: report.prototype.missingVisibleParentChildLinks,
      missingVisibleSpouseLinks: report.prototype.missingVisibleSpouseLinks,
      spouseLinks: report.prototype.spouseLinks,
      parentChildLinks: report.prototype.parentChildLinks,
      familyChart: {
        displayedCount: report.familyChart.displayedCount,
        spouseLinks: report.familyChart.spouseLinks,
        parentChildLinksRaw: report.familyChart.parentChildLinksRaw,
        parentChildLinksUnique: report.familyChart.parentChildLinksUnique,
        parentChildFromParents: report.familyChart.parentChildFromParents,
        parentChildFromAncestryParent: report.familyChart.parentChildFromAncestryParent,
      },
    };
  });
}
