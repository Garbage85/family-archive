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

function compareIds(left, right) {
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneFamilyChartData(data) {
  return data.map((person) => ({
    ...person,
    data: { ...person.data },
    rels: {
      ...person.rels,
      parents: [...(person.rels.parents || [])],
      children: [...(person.rels.children || [])],
      spouses: [...(person.rels.spouses || [])],
    },
  }));
}

function calculateDirectBranch(
  calculateFamilyTree,
  data,
  mainId,
  nodeSeparation,
  levelSeparation,
  isHorizontal,
) {
  return calculateFamilyTree(cloneFamilyChartData(data), {
    main_id: mainId,
    node_separation: nodeSeparation,
    level_separation: levelSeparation,
    single_parent_empty_card: false,
    is_horizontal: isHorizontal,
    ancestry_depth: 1,
    progeny_depth: 1,
    show_siblings_of_main: true,
    sortChildrenFunction: (left, right) => compareIds(left.id, right.id),
    sortSpousesFunction: (person) => person.rels.spouses?.sort(compareIds),
  });
}

const SCALAR_NODE_REFERENCES = ['parent', 'spouse', 'coparent'];
const ARRAY_NODE_REFERENCES = ['parents', 'children', 'spouses'];

function nodeId(node) {
  return String(node?.data?.id ?? '');
}

function referencesResolve(nodes, resolvableById) {
  return nodes.every((node) => {
    const scalarsResolve = SCALAR_NODE_REFERENCES.every(
      (field) => !node[field] || resolvableById.has(nodeId(node[field])),
    );
    const arraysResolve = ARRAY_NODE_REFERENCES.every(
      (field) =>
        !node[field] || node[field].every((relative) => resolvableById.has(nodeId(relative))),
    );
    return scalarsResolve && arraysResolve;
  });
}

function remapNodeReferences(nodes, resolvableById, dataById) {
  for (const node of nodes) {
    node.data = dataById.get(nodeId(node)) || node.data;
    for (const field of SCALAR_NODE_REFERENCES) {
      if (node[field]) node[field] = resolvableById.get(nodeId(node[field]));
    }
    for (const field of ARRAY_NODE_REFERENCES) {
      if (node[field])
        node[field] = node[field].map((relative) => resolvableById.get(nodeId(relative)));
    }
  }
}

function findFreeBranchMidpoint(
  nodes,
  displayedNodes,
  anchorCross,
  targetGeneration,
  outward,
  crossSeparation,
  generationSeparation,
  isHorizontal,
) {
  const offsets = nodes.map((_node, index) => (index - (nodes.length - 1) / 2) * crossSeparation);
  let midpoint = anchorCross + (outward * (nodes.length + 1) * crossSeparation) / 2;
  const conflicts = (candidate) =>
    offsets.some((offset) =>
      displayedNodes.some((displayed) => {
        const position = nodePosition(displayed, isHorizontal);
        return (
          Math.abs(position.generation - targetGeneration) < generationSeparation &&
          Math.abs(position.cross - (candidate + offset)) < crossSeparation
        );
      }),
    );

  while (conflicts(midpoint)) midpoint += outward * crossSeparation;
  return midpoint;
}

function graftDirectRelatives({
  tree,
  branch,
  relativeIds,
  anchorNode,
  relationField,
  displayedById,
  dataById,
  outward,
  generationDirection,
  crossSeparation,
  generationSeparation,
  isHorizontal,
}) {
  const branchById = new Map(branch.data.map((node) => [nodeId(node), node]));
  const nodes = relativeIds
    .map(String)
    .map((id) => branchById.get(id))
    .filter(Boolean)
    .sort((left, right) => {
      const crossDifference =
        nodePosition(left, isHorizontal).cross - nodePosition(right, isHorizontal).cross;
      return crossDifference || compareIds(nodeId(left), nodeId(right));
    });
  if (!nodes.length) return;

  const resolvableById = new Map(displayedById);
  for (const node of nodes) resolvableById.set(nodeId(node), node);
  if (!referencesResolve(nodes, resolvableById)) return;
  remapNodeReferences(nodes, resolvableById, dataById);

  const anchorPosition = nodePosition(anchorNode, isHorizontal);
  const targetGeneration = anchorPosition.generation + generationDirection * generationSeparation;
  const midpoint = findFreeBranchMidpoint(
    nodes,
    tree.data,
    anchorPosition.cross,
    targetGeneration,
    outward,
    crossSeparation,
    generationSeparation,
    isHorizontal,
  );
  nodes.forEach((node, index) => {
    const cross = midpoint + (index - (nodes.length - 1) / 2) * crossSeparation;
    positionNode(node, cross, targetGeneration, isHorizontal);
    displayedById.set(nodeId(node), node);
  });

  if (relationField) {
    anchorNode[relationField] = [...(anchorNode[relationField] || []), ...nodes];
  }
  for (const node of nodes) {
    if (node.coparent) node.coparent.coparent = node;
  }
  tree.data.push(...nodes);
}

function spouseReferences(node) {
  return [node.spouse, node.coparent, ...(node.spouses || [])].filter(Boolean);
}

function ensureSpouseReference(personNode, spouseNode) {
  if (spouseReferences(personNode).includes(spouseNode)) return;
  personNode.spouses = [...new Set([...spouseReferences(personNode), spouseNode])];
}

function memberOrder(left, right, dataById) {
  const genderRank = { M: 0, F: 1 };
  const leftRank = genderRank[dataById.get(nodeId(left))?.data?.gender] ?? 2;
  const rightRank = genderRank[dataById.get(nodeId(right))?.data?.gender] ?? 2;
  return leftRank - rightRank || compareIds(nodeId(left), nodeId(right));
}

function reflowHouseholdsOnGeneration(
  tree,
  generation,
  originalCrossById,
  dataById,
  crossSeparation,
  isHorizontal,
) {
  const row = tree.data.filter(
    (node) => nodePosition(node, isHorizontal).generation === generation,
  );
  if (row.length < 2) return;

  const rowById = new Map(row.map((node) => [nodeId(node), node]));
  const roots = new Map([...rowById.keys()].map((id) => [id, id]));
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
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const [root, child] = [leftRoot, rightRoot].sort(compareIds);
    roots.set(child, root);
  };

  for (const node of row) {
    const person = dataById.get(nodeId(node));
    for (const spouseId of person?.rels.spouses || []) {
      const id = String(spouseId);
      if (rowById.has(id)) union(nodeId(node), id);
    }
  }

  const groups = new Map();
  for (const node of row) {
    const root = find(nodeId(node));
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(node);
  }
  const originalCross = (node) =>
    originalCrossById.get(nodeId(node)) ?? nodePosition(node, isHorizontal).cross;
  const orderedGroups = [...groups.entries()]
    .map(([id, nodes]) => ({
      id,
      nodes: nodes.sort((left, right) => memberOrder(left, right, dataById)),
      cross: Math.min(...nodes.map(originalCross)),
    }))
    .sort((left, right) => left.cross - right.cross || compareIds(left.id, right.id));
  const orderedNodes = orderedGroups.flatMap((group) => group.nodes);
  const originalPositions = row.map(originalCross);
  const midpoint = (Math.min(...originalPositions) + Math.max(...originalPositions)) / 2;
  const firstCross = midpoint - ((orderedNodes.length - 1) * crossSeparation) / 2;

  orderedNodes.forEach((node, index) => {
    positionNode(node, firstCross + index * crossSeparation, generation, isHorizontal);
  });
  for (const node of row) {
    const nodeCross = nodePosition(node, isHorizontal).cross;
    for (const [index, spouse] of (node.spouses || []).entries()) {
      const spouseCross = nodePosition(spouse, isHorizontal).cross;
      spouse.sx = index === 0 ? (nodeCross + spouseCross) / 2 : spouseCross;
    }
    if (node.spouse) {
      node.sx = (nodeCross + nodePosition(node.spouse, isHorizontal).cross) / 2;
    }
  }
}

function includeDirectSpousesOfDisplayedPeople({
  tree,
  currentData,
  displayedById,
  dataById,
  calculateFamilyTree,
  nodeSeparation,
  levelSeparation,
  crossSeparation,
  isHorizontal,
}) {
  if (typeof calculateFamilyTree !== 'function') return;
  const displayedAtStart = [...tree.data].sort((left, right) =>
    compareIds(nodeId(left), nodeId(right)),
  );
  const originalCrossById = new Map(
    displayedAtStart.map((node) => [nodeId(node), nodePosition(node, isHorizontal).cross]),
  );
  const affectedGenerations = new Set();

  for (const personNode of displayedAtStart) {
    const person = dataById.get(nodeId(personNode));
    const missingSpouseIds = [...(person?.rels.spouses || [])]
      .map(String)
      .filter((id) => !displayedById.has(id))
      .sort(compareIds);
    if (!missingSpouseIds.length) continue;

    let branch;
    try {
      branch = calculateDirectBranch(
        calculateFamilyTree,
        currentData,
        person.id,
        nodeSeparation,
        levelSeparation,
        isHorizontal,
      );
    } catch {
      continue;
    }
    const branchById = new Map(branch.data.map((node) => [nodeId(node), node]));

    for (const spouseId of missingSpouseIds) {
      const spouseNode = branchById.get(spouseId);
      if (!spouseNode) continue;
      const resolvableById = new Map(displayedById);
      resolvableById.set(spouseId, spouseNode);
      if (!referencesResolve([spouseNode], resolvableById)) continue;
      remapNodeReferences([spouseNode], resolvableById, dataById);

      const position = nodePosition(personNode, isHorizontal);
      positionNode(spouseNode, position.cross, position.generation, isHorizontal);
      displayedById.set(spouseId, spouseNode);
      ensureSpouseReference(personNode, spouseNode);
      tree.data.push(spouseNode);
      affectedGenerations.add(position.generation);
    }
  }

  for (const generation of [...affectedGenerations].sort((left, right) => left - right)) {
    reflowHouseholdsOnGeneration(
      tree,
      generation,
      originalCrossById,
      dataById,
      crossSeparation,
      isHorizontal,
    );
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

/**
 * Family Chart walks only the main person's ancestry and attaches spouses only
 * to that bloodline. Add direct spouses of the initially displayed people and
 * the already-supported center-spouse branches without changing relationship
 * facts in the compatibility data.
 */
export function includeDirectSpouseBranches(
  tree,
  chartData,
  centerId,
  {
    nodeSeparation = 236,
    levelSeparation = 224,
    isHorizontal = false,
    calculateTree: calculateFamilyTree,
  } = {},
) {
  if (!tree?.data?.length) return tree;
  const currentData = tree.data_stash?.length ? tree.data_stash : chartData;
  const peopleById = new Map(currentData.map((person) => [String(person.id), person]));
  const displayedById = new Map(tree.data.map((node) => [String(node.data?.id), node]));
  const center = peopleById.get(String(centerId));
  const centerNode = displayedById.get(String(centerId));
  if (!center || !centerNode) return tree;

  const crossSeparation = isHorizontal ? levelSeparation : nodeSeparation;
  const generationSeparation = isHorizontal ? nodeSeparation : levelSeparation;

  includeDirectSpousesOfDisplayedPeople({
    tree,
    currentData,
    displayedById,
    dataById: peopleById,
    calculateFamilyTree,
    nodeSeparation,
    levelSeparation,
    crossSeparation,
    isHorizontal,
  });

  for (const spouseId of [...(center.rels.spouses || [])].sort(compareIds)) {
    const spouse = peopleById.get(String(spouseId));
    const spouseNode = displayedById.get(String(spouseId));
    if (!spouse || !spouseNode) continue;

    const centerPosition = nodePosition(centerNode, isHorizontal);
    const spousePosition = nodePosition(spouseNode, isHorizontal);
    const outward =
      spousePosition.cross === centerPosition.cross
        ? compareIds(spouse.id, center.id) < 0
          ? -1
          : 1
        : spousePosition.cross < centerPosition.cross
          ? -1
          : 1;
    const missingParentIds = spouse.rels.parents.filter((id) => !displayedById.has(String(id)));
    const missingChildIds = spouse.rels.children.filter((id) => !displayedById.has(String(id)));
    const spouseParentIds = new Set(spouse.rels.parents.map(String));
    const missingSiblingIds = currentData
      .filter(
        (person) =>
          person.id !== spouse.id &&
          person.rels.parents.some((parentId) => spouseParentIds.has(String(parentId))) &&
          !displayedById.has(String(person.id)),
      )
      .map((person) => person.id);
    if (!missingParentIds.length && !missingChildIds.length && !missingSiblingIds.length) continue;
    if (typeof calculateFamilyTree !== 'function') continue;

    let branch;
    try {
      branch = calculateDirectBranch(
        calculateFamilyTree,
        currentData,
        spouse.id,
        nodeSeparation,
        levelSeparation,
        isHorizontal,
      );
    } catch {
      continue;
    }

    graftDirectRelatives({
      tree,
      branch,
      relativeIds: missingParentIds,
      anchorNode: spouseNode,
      relationField: 'parents',
      displayedById,
      dataById: peopleById,
      outward,
      generationDirection: -1,
      crossSeparation,
      generationSeparation,
      isHorizontal,
    });
    graftDirectRelatives({
      tree,
      branch,
      relativeIds: missingSiblingIds,
      anchorNode: spouseNode,
      relationField: null,
      displayedById,
      dataById: peopleById,
      outward,
      generationDirection: 0,
      crossSeparation,
      generationSeparation,
      isHorizontal,
    });
    graftDirectRelatives({
      tree,
      branch,
      relativeIds: missingChildIds,
      anchorNode: spouseNode,
      relationField: 'children',
      displayedById,
      dataById: peopleById,
      outward,
      generationDirection: 1,
      crossSeparation,
      generationSeparation,
      isHorizontal,
    });
  }

  updateTreeDimensions(tree, nodeSeparation, levelSeparation);
  return tree;
}
