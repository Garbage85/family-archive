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

function personId(node) {
  return String(node?.data?.id || '');
}

/**
 * Family Chart attaches spouses before siblings are added, so displayed
 * sibling cards keep spouse facts in chartData but not in the calculated
 * tree. Append only missing spouse cards; positions are corrected by the
 * main-generation household reflow that follows.
 */
function appendMissingSpousesOfDisplayedSiblings(tree, peopleById, displayedById) {
  const siblingNodes = tree.data.filter((node) => node.sibling);
  for (const siblingNode of siblingNodes) {
    const id = personId(siblingNode);
    const person = peopleById.get(id);
    if (!person) continue;

    const missingSpouseIds = [...(person.rels.spouses || [])]
      .map(String)
      .filter((spouseId) => spouseId && !displayedById.has(spouseId));
    if (!missingSpouseIds.length) continue;

    if (!Array.isArray(siblingNode.spouses)) siblingNode.spouses = [];

    missingSpouseIds.forEach((spouseId, index) => {
      if (displayedById.has(spouseId)) return;
      const spousePerson = peopleById.get(spouseId);
      if (!spousePerson) return;

      const spouseNode = {
        data: spousePerson,
        added: true,
        depth: siblingNode.depth,
        spouse: siblingNode,
        tid: `${id}-spouse-${index}`,
        x: siblingNode.x,
        y: siblingNode.y,
      };

      siblingNode.spouses.push(spouseNode);
      tree.data.push(spouseNode);
      displayedById.set(spouseId, spouseNode);
    });
  }
}

function householdMembers(anchorNode) {
  const members = [];
  const add = (node) => {
    if (node && !members.includes(node)) members.push(node);
  };
  add(anchorNode);
  for (const spouse of anchorNode.spouses || []) add(spouse);
  add(anchorNode.spouse);
  return members;
}

function orderHouseholdMembers(members, anchorNode, isHorizontal) {
  const anchorIndex = members.indexOf(anchorNode);
  const spouses = members.filter((node) => node !== anchorNode);
  spouses.sort((left, right) => {
    const crossDelta =
      nodePosition(left, isHorizontal).cross - nodePosition(right, isHorizontal).cross;
    if (crossDelta !== 0) return crossDelta;
    return personId(left).localeCompare(personId(right));
  });
  // Keep the blood/main person as the household anchor slot; spouses follow in
  // their current visual order (or id order when still stacked on the anchor).
  if (anchorIndex === -1)
    return [...members].sort((left, right) => {
      const crossDelta =
        nodePosition(left, isHorizontal).cross - nodePosition(right, isHorizontal).cross;
      if (crossDelta !== 0) return crossDelta;
      return personId(left).localeCompare(personId(right));
    });
  return [anchorNode, ...spouses];
}

function updateSpouseLinkAnchors(anchorNode, isHorizontal) {
  const generation = nodePosition(anchorNode, isHorizontal).generation;
  const spouses = anchorNode.spouses || [];
  spouses.forEach((spouseNode, index) => {
    const anchorCross = nodePosition(anchorNode, isHorizontal).cross;
    const spouseCross = nodePosition(spouseNode, isHorizontal).cross;
    const linkCross = index === 0 ? (anchorCross + spouseCross) / 2 : spouseCross;
    if (isHorizontal) {
      spouseNode.sx = generation;
      spouseNode.sy = linkCross;
    } else {
      spouseNode.sx = linkCross;
      spouseNode.sy = generation;
    }
  });
}

/**
 * Pack main + sibling households on the main generation so appended sibling
 * spouses do not share coordinates with neighbouring cards.
 *
 * Spacing: each card on the row occupies one slot; consecutive cards (inside
 * a household and between households) are placed nodeSeparation apart on the
 * cross axis. Generation axis is unchanged. Ancestry/progeny nodes outside
 * this generation are not moved; parent/children object refs are not rebuilt.
 */
function reflowMainSiblingGeneration(tree, centerNode, { nodeSeparation, isHorizontal }) {
  const generation = nodePosition(centerNode, isHorizontal).generation;
  const households = [];

  const mainMembers = householdMembers(centerNode).filter(
    (node) => nodePosition(node, isHorizontal).generation === generation || node === centerNode,
  );
  // Newly appended spouses may still share the sibling's provisional x/y.
  const siblingNodes = tree.data.filter((node) => node.sibling);
  households.push({
    anchor: centerNode,
    members: mainMembers,
    orderKey: Math.min(...mainMembers.map((node) => nodePosition(node, isHorizontal).cross)),
  });

  for (const siblingNode of siblingNodes) {
    const members = householdMembers(siblingNode);
    households.push({
      anchor: siblingNode,
      members,
      orderKey: Math.min(...members.map((node) => nodePosition(node, isHorizontal).cross)),
    });
  }

  households.sort((left, right) => {
    if (left.orderKey !== right.orderKey) return left.orderKey - right.orderKey;
    return personId(left.anchor).localeCompare(personId(right.anchor));
  });

  for (const household of households) {
    household.members = orderHouseholdMembers(household.members, household.anchor, isHorizontal);
  }

  const orderedMembers = households.flatMap((household) => household.members);
  if (orderedMembers.length === 0) return;

  const originalCrosses = orderedMembers.map((node) => nodePosition(node, isHorizontal).cross);
  const midpoint = (Math.min(...originalCrosses) + Math.max(...originalCrosses)) / 2;
  const firstCross = midpoint - ((orderedMembers.length - 1) * nodeSeparation) / 2;

  orderedMembers.forEach((node, index) => {
    positionNode(node, firstCross + index * nodeSeparation, generation, isHorizontal);
  });

  for (const household of households) {
    updateSpouseLinkAnchors(household.anchor, isHorizontal);
  }
}

/**
 * Family Chart walks only the main person's ancestry. Its spouse cards are
 * attached after that walk, so their own parents and spouse-only children are
 * absent from the calculated tree. Add those direct branches to the transient
 * layout without changing any relationship facts in the compatibility data.
 *
 * Also append missing spouses of displayed siblings and reflow only the main
 * generation households so those spouses fit without card overlaps (ADR-008).
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

  appendMissingSpousesOfDisplayedSiblings(tree, peopleById, displayedById);
  reflowMainSiblingGeneration(tree, centerNode, { nodeSeparation, isHorizontal });

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
