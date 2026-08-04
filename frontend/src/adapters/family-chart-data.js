import { buildKinshipIndex } from '../kinship-engine.js';
import { normaliseTree } from '../tree-utils.js';

function createsParentCycle(acceptedParents, childId, parentId) {
  const stack = [parentId];
  const visited = new Set();
  while (stack.length) {
    const id = stack.pop();
    if (id === childId) return true;
    if (visited.has(id)) continue;
    visited.add(id);
    stack.push(...(acceptedParents.get(id) || []));
  }
  return false;
}

/**
 * Produces a reciprocal, duplicate-free and cycle-safe clone for Family Chart.
 * This compatibility view is never written back to trees.data; the kinship
 * engine still reports warnings from the unmodified source graph.
 */
export function prepareFamilyChartData(rawData) {
  const data = normaliseTree(rawData);
  const index = buildKinshipIndex(data);
  const ids = [...index.peopleById.keys()].sort();
  const acceptedParents = new Map(ids.map((id) => [id, new Set()]));

  for (const childId of ids) {
    for (const parentId of [...(index.parents.get(childId) || [])].sort()) {
      if (!createsParentCycle(acceptedParents, childId, parentId)) {
        acceptedParents.get(childId).add(parentId);
      }
    }
  }

  const acceptedChildren = new Map(ids.map((id) => [id, new Set()]));
  for (const [childId, parentIds] of acceptedParents) {
    for (const parentId of parentIds) acceptedChildren.get(parentId).add(childId);
  }

  return data.map((person) => ({
    ...person,
    rels: {
      ...person.rels,
      parents: [...acceptedParents.get(person.id)],
      children: [...acceptedChildren.get(person.id)],
      spouses: [...(index.spouses.get(person.id) || [])].sort(),
    },
  }));
}

function positionNode(node, cross, generation, isHorizontal) {
  if (isHorizontal) {
    node.x = generation;
    node.y = cross;
  } else {
    node.x = cross;
    node.y = generation;
  }
}

function updateTreeDimensions(tree, nodeSeparation, levelSeparation) {
  const xValues = tree.data.map((node) => node.x);
  const yValues = tree.data.map((node) => node.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  tree.dim = {
    width: maxX - minX + nodeSeparation,
    height: maxY - minY + levelSeparation,
    x_off: -minX + nodeSeparation / 2,
    y_off: -minY + levelSeparation / 2,
  };
}

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildHouseholds(chartData, peopleById) {
  const ids = [...peopleById.keys()].sort(compareIds);
  const roots = new Map(ids.map((id) => [id, id]));
  const find = (id) => {
    let root = id;
    while (roots.get(root) !== root) root = roots.get(root);
    let current = id;
    while (roots.get(current) !== current) {
      const next = roots.get(current);
      roots.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (left, right) => {
    const a = find(left);
    const b = find(right);
    if (a === b) return;
    const [root, child] = [a, b].sort(compareIds);
    roots.set(child, root);
  };

  for (const person of [...chartData].sort((a, b) => compareIds(a.id, b.id))) {
    for (const spouseId of [...(person.rels.spouses || [])].sort(compareIds)) {
      const id = String(spouseId);
      if (peopleById.has(id)) union(person.id, id);
    }
  }

  const members = new Map();
  for (const id of ids) {
    const root = find(id);
    if (!members.has(root)) members.set(root, []);
    members.get(root).push(id);
  }
  return { find, members };
}

function buildGenerationIndex(chartData, peopleById, households) {
  const groupIds = [...households.members.keys()].sort(compareIds);
  const parents = new Map(groupIds.map((id) => [id, new Set()]));
  const children = new Map(groupIds.map((id) => [id, new Set()]));

  for (const person of chartData) {
    const childGroup = households.find(person.id);
    for (const parentId of person.rels.parents || []) {
      const id = String(parentId);
      if (!peopleById.has(id)) continue;
      const parentGroup = households.find(id);
      if (parentGroup === childGroup) continue;
      parents.get(childGroup).add(parentGroup);
      children.get(parentGroup).add(childGroup);
    }
  }

  const generation = new Map(groupIds.map((id) => [id, 0]));
  const remainingParents = new Map(groupIds.map((id) => [id, parents.get(id).size]));
  const ready = groupIds.filter((id) => remainingParents.get(id) === 0);
  const processed = new Set();
  while (ready.length) {
    ready.sort(compareIds);
    const groupId = ready.shift();
    processed.add(groupId);
    for (const childId of [...children.get(groupId)].sort(compareIds)) {
      generation.set(childId, Math.max(generation.get(childId), generation.get(groupId) + 1));
      remainingParents.set(childId, remainingParents.get(childId) - 1);
      if (remainingParents.get(childId) === 0) ready.push(childId);
    }
  }

  // prepareFamilyChartData removes ordinary parent cycles. A cycle left only
  // after grouping contradictory spouse facts is placed deterministically;
  // valid parent-child generations retain the topological result above.
  for (const groupId of groupIds.filter((id) => !processed.has(id))) {
    const resolvedParents = [...parents.get(groupId)].filter((id) => processed.has(id));
    generation.set(
      groupId,
      resolvedParents.length ? Math.max(...resolvedParents.map((id) => generation.get(id) + 1)) : 0,
    );
    processed.add(groupId);
  }

  return { generation, parents };
}

function memberOrder(left, right, peopleById) {
  const ranks = { M: 0, F: 1 };
  const leftRank = ranks[peopleById.get(left)?.data?.gender] ?? 2;
  const rightRank = ranks[peopleById.get(right)?.data?.gender] ?? 2;
  return leftRank - rightRank || compareIds(left, right);
}

/**
 * Family Chart 0.9 calculates only the main bloodline and attaches spouses
 * afterwards. It has no public full-tree coordinate API. Repack its transient
 * tree into deterministic generation bands while keeping its renderer, zoom,
 * cards and link generation. No coordinates or compatibility facts are saved.
 */
export function layoutFullFamilyTree(
  tree,
  chartData,
  centerId,
  { nodeSeparation = 236, levelSeparation = 224, isHorizontal = false } = {},
) {
  if (!tree?.data?.length || !chartData?.length) return tree;
  const peopleById = new Map(chartData.map((person) => [String(person.id), person]));
  if (!peopleById.has(String(centerId))) return tree;
  const existingById = new Map(tree.data.map((node) => [String(node.data?.id), node]));
  const households = buildHouseholds(chartData, peopleById);
  const generationIndex = buildGenerationIndex(chartData, peopleById, households);
  const centerGeneration = generationIndex.generation.get(households.find(String(centerId))) || 0;
  const groupsByGeneration = new Map();

  for (const groupId of households.members.keys()) {
    const generation = generationIndex.generation.get(groupId);
    if (!groupsByGeneration.has(generation)) groupsByGeneration.set(generation, []);
    groupsByGeneration.get(generation).push(groupId);
  }

  const nodesById = new Map();
  const orderedNodes = [];
  for (const generation of [...groupsByGeneration.keys()].sort((a, b) => a - b)) {
    const groupIds = groupsByGeneration.get(generation).sort((left, right) => {
      const leftParents = [...generationIndex.parents.get(left)].sort(compareIds).join(',');
      const rightParents = [...generationIndex.parents.get(right)].sort(compareIds).join(',');
      return compareIds(leftParents, rightParents) || compareIds(left, right);
    });
    const ids = groupIds.flatMap((groupId) =>
      [...households.members.get(groupId)].sort((a, b) => memberOrder(a, b, peopleById)),
    );
    const firstCross = -((ids.length - 1) * nodeSeparation) / 2;
    ids.forEach((id, index) => {
      const node = existingById.get(id) || {};
      const cross = firstCross + index * nodeSeparation;
      const generationPosition = generation * levelSeparation;
      node.data = peopleById.get(id);
      node.tid = id;
      node.depth = 0;
      node.is_ancestry = generation < centerGeneration;
      node.sibling = generation === centerGeneration && id !== String(centerId);
      delete node.parent;
      delete node.spouse;
      delete node.coparent;
      delete node.added;
      delete node.parents;
      delete node.children;
      delete node.spouses;
      positionNode(node, cross, generationPosition, isHorizontal);
      if (!Number.isFinite(node._x)) node._x = node.x;
      if (!Number.isFinite(node._y)) node._y = node.y;
      nodesById.set(id, node);
      orderedNodes.push(node);
    });
  }

  for (const [id, node] of nodesById) {
    const person = peopleById.get(id);
    node.parents = (person.rels.parents || [])
      .map(String)
      .map((parentId) => nodesById.get(parentId))
      .filter(Boolean);
    node.children = (person.rels.children || [])
      .map(String)
      .map((childId) => nodesById.get(childId))
      .filter(Boolean);
    node.spouses = (person.rels.spouses || [])
      .map(String)
      .map((spouseId) => nodesById.get(spouseId))
      .filter(Boolean);
    const householdNodes = households.members
      .get(households.find(id))
      .map((memberId) => nodesById.get(memberId));
    const crossPositions = householdNodes.map((member) => (isHorizontal ? member.y : member.x));
    const midpoint = crossPositions.reduce((sum, value) => sum + value, 0) / crossPositions.length;
    node.sx = midpoint;
    node.sy = isHorizontal ? node.x : node.y;
    node.psx = midpoint;
    node.psy = node.sy;
  }

  // Family Chart's main_to_middle viewport mode targets tree.data[0], not
  // store.main. Keep coordinates stable and put only the selected card first.
  const centerNode = nodesById.get(String(centerId));
  tree.data = [centerNode, ...orderedNodes.filter((node) => node !== centerNode)];
  tree.is_horizontal = isHorizontal;
  updateTreeDimensions(tree, nodeSeparation, levelSeparation);
  return tree;
}

// Kept as a compatibility export for focused tests and older adapter callers.
export const includeDirectSpouseBranches = layoutFullFamilyTree;
