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

function nodePosition(node, isHorizontal) {
  return isHorizontal
    ? { cross: node.y, generation: node.x }
    : { cross: node.x, generation: node.y };
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

/**
 * Family Chart attaches spouses before siblings are added, so displayed
 * sibling cards keep their spouse facts in chartData but not in the
 * calculated tree. Append only the missing spouse cards next to those
 * sibling nodes without replacing existing nodes or grafting spouse
 * parents/children.
 */
function appendMissingSpousesOfDisplayedSiblings(
  tree,
  peopleById,
  displayedById,
  { nodeSeparation, isHorizontal },
) {
  const siblingNodes = tree.data.filter((node) => node.sibling);
  for (const siblingNode of siblingNodes) {
    const personId = String(siblingNode.data?.id || '');
    const person = peopleById.get(personId);
    if (!person) continue;

    const missingSpouseIds = [...(person.rels.spouses || [])]
      .map(String)
      .filter((spouseId) => spouseId && !displayedById.has(spouseId));
    if (!missingSpouseIds.length) continue;

    const gender = String(person.data?.gender || '').toUpperCase();
    const side = gender === 'M' ? -1 : 1;
    if (!Array.isArray(siblingNode.spouses)) siblingNode.spouses = [];

    const siblingPosition = nodePosition(siblingNode, isHorizontal);
    missingSpouseIds.forEach((spouseId, index) => {
      if (displayedById.has(spouseId)) return;
      const spousePerson = peopleById.get(spouseId);
      if (!spousePerson) return;

      const spouseCross = siblingPosition.cross - nodeSeparation * (index + 1) * side;
      const spouseNode = {
        data: spousePerson,
        added: true,
        depth: siblingNode.depth,
        spouse: siblingNode,
        tid: `${personId}-spouse-${index}`,
      };
      positionNode(spouseNode, spouseCross, siblingPosition.generation, isHorizontal);

      const linkCross = index > 0 ? spouseCross : spouseCross + (nodeSeparation / 2) * side;
      if (isHorizontal) {
        spouseNode.sx = siblingPosition.generation;
        spouseNode.sy = linkCross;
      } else {
        spouseNode.sx = linkCross;
        spouseNode.sy = siblingPosition.generation;
      }

      siblingNode.spouses.push(spouseNode);
      tree.data.push(spouseNode);
      displayedById.set(spouseId, spouseNode);
    });
  }
}

/**
 * Family Chart walks only the main person's ancestry. Its spouse cards are
 * attached after that walk, so their own parents and spouse-only children are
 * absent from the calculated tree. Add those direct branches to the transient
 * layout without changing any relationship facts in the compatibility data.
 *
 * Also append missing spouses of already-displayed sibling nodes (ADR-008 A).
 */
export function includeDirectSpouseBranches(
  tree,
  chartData,
  centerId,
  { nodeSeparation = 236, levelSeparation = 224, isHorizontal = false } = {},
) {
  if (!tree?.data?.length) return tree;
  const peopleById = new Map(chartData.map((person) => [String(person.id), person]));
  const displayedById = new Map(tree.data.map((node) => [String(node.data?.id), node]));
  const center = peopleById.get(String(centerId));
  const centerNode = displayedById.get(String(centerId));
  if (!center || !centerNode) return tree;

  appendMissingSpousesOfDisplayedSiblings(tree, peopleById, displayedById, {
    nodeSeparation,
    isHorizontal,
  });

  for (const spouseId of center.rels.spouses || []) {
    const spouse = peopleById.get(String(spouseId));
    const spouseNode = displayedById.get(String(spouseId));
    if (!spouse || !spouseNode) continue;

    const centerPosition = nodePosition(centerNode, isHorizontal);
    const spousePosition = nodePosition(spouseNode, isHorizontal);
    const outward = spousePosition.cross < centerPosition.cross ? -1 : 1;
    const missingParentIds = spouse.rels.parents.filter((id) => !displayedById.has(String(id)));
    const missingChildIds = spouse.rels.children.filter((id) => !displayedById.has(String(id)));

    const parentMidpoint = spousePosition.cross + (outward * nodeSeparation) / 2;
    const parentNodes = missingParentIds
      .map((id) => peopleById.get(String(id)))
      .filter(Boolean)
      .map((person, index, parents) => {
        const cross = parentMidpoint + (index - (parents.length - 1) / 2) * nodeSeparation;
        const node = {
          data: person,
          depth: 1,
          is_ancestry: true,
          parent: spouseNode,
          tid: person.id,
          _x: spouseNode.x,
          _y: spouseNode.y,
        };
        positionNode(node, cross, spousePosition.generation - levelSeparation, isHorizontal);
        tree.data.push(node);
        displayedById.set(String(person.id), node);
        return node;
      });

    if (parentNodes.length) {
      spouseNode.parents = [...(spouseNode.parents || []), ...parentNodes];
      if (parentNodes.length === 2) {
        parentNodes[0].coparent = parentNodes[1];
        parentNodes[1].coparent = parentNodes[0];
      }
    }

    const childMidpoint = spousePosition.cross + (outward * nodeSeparation) / 2;
    const childNodes = missingChildIds
      .map((id) => peopleById.get(String(id)))
      .filter(Boolean)
      .map((person, index, children) => {
        const cross = childMidpoint + (index - (children.length - 1) / 2) * nodeSeparation;
        const node = {
          data: person,
          depth: 1,
          is_ancestry: false,
          parent: spouseNode,
          tid: person.id,
          _x: spouseNode.x,
          _y: spouseNode.y,
        };
        positionNode(node, cross, spousePosition.generation + levelSeparation, isHorizontal);
        tree.data.push(node);
        displayedById.set(String(person.id), node);
        return node;
      });

    if (childNodes.length) spouseNode.children = [...(spouseNode.children || []), ...childNodes];
  }

  updateTreeDimensions(tree, nodeSeparation, levelSeparation);
  return tree;
}
