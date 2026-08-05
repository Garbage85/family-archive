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
 * Family Chart walks only the main person's ancestry. Its spouse cards are
 * attached after that walk, so their own parents and spouse-only children are
 * absent from the calculated tree. Add those direct branches to the transient
 * layout without changing any relationship facts in the compatibility data.
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
