/**
 * Household-based layout prototype for Family Archive.
 * Preview-wired via ?layout=prototype (PrototypeFamilyTreeChart).
 * Does not use Family Chart private APIs. Never writes coords to trees.data.
 */

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function personMap(people) {
  return new Map(people.map((person) => [String(person.id), person]));
}

function spouseIds(person) {
  return unique(person?.rels?.spouses);
}

function parentIds(person) {
  return unique(person?.rels?.parents);
}

function childIds(person) {
  return unique(person?.rels?.children);
}

/**
 * Visible set around center: ancestry + progeny + siblings of center +
 * spouses of every included person (households closed under marriage).
 */
export function selectVisiblePeople(
  people,
  centerId,
  { ancestryDepth = 8, progenyDepth = 8 } = {},
) {
  const byId = personMap(people);
  const center = byId.get(String(centerId));
  if (!center) return [];

  const visible = new Set([String(centerId)]);

  function walkParents(id, depth) {
    if (depth <= 0) return;
    for (const parentId of parentIds(byId.get(id))) {
      if (!byId.has(parentId) || visible.has(parentId)) continue;
      visible.add(parentId);
      walkParents(parentId, depth - 1);
    }
  }

  function walkChildren(id, depth) {
    if (depth <= 0) return;
    for (const childId of childIds(byId.get(id))) {
      if (!byId.has(childId) || visible.has(childId)) continue;
      visible.add(childId);
      walkChildren(childId, depth - 1);
    }
  }

  walkParents(String(centerId), ancestryDepth);
  walkChildren(String(centerId), progenyDepth);

  for (const parentId of parentIds(center)) {
    const parent = byId.get(parentId);
    for (const siblingId of childIds(parent)) {
      if (siblingId !== String(centerId) && byId.has(siblingId)) visible.add(siblingId);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...visible]) {
      for (const spouseId of spouseIds(byId.get(id))) {
        if (byId.has(spouseId) && !visible.has(spouseId)) {
          visible.add(spouseId);
          changed = true;
        }
      }
    }
  }

  return [...visible]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => byId.get(id))
    .filter(Boolean);
}

function assignGenerations(people, centerId) {
  const byId = personMap(people);
  const generation = new Map([[String(centerId), 0]]);
  const queue = [String(centerId)];

  while (queue.length) {
    const id = queue.shift();
    const g = generation.get(id);
    const person = byId.get(id);
    for (const parentId of parentIds(person)) {
      if (!byId.has(parentId) || generation.has(parentId)) continue;
      generation.set(parentId, g - 1);
      queue.push(parentId);
    }
    for (const childId of childIds(person)) {
      if (!byId.has(childId) || generation.has(childId)) continue;
      generation.set(childId, g + 1);
      queue.push(childId);
    }
  }

  for (const person of people) {
    if (!generation.has(person.id)) generation.set(person.id, 0);
  }

  // Spouses share generation with the lower-abs partner already placed.
  let stable = false;
  while (!stable) {
    stable = true;
    for (const person of people) {
      for (const spouseId of spouseIds(person)) {
        if (!byId.has(spouseId)) continue;
        const gPerson = generation.get(person.id);
        const gSpouse = generation.get(spouseId);
        if (gPerson !== gSpouse) {
          // Prefer bloodline generation already reached via parent/child.
          const prefer = Math.abs(gPerson) <= Math.abs(gSpouse) ? gPerson : gSpouse;
          if (generation.get(person.id) !== prefer || generation.get(spouseId) !== prefer) {
            generation.set(person.id, prefer);
            generation.set(spouseId, prefer);
            stable = false;
          }
        }
      }
    }
  }

  return generation;
}

/**
 * Build households: each person appears in exactly one household together with
 * their visible spouses. Household width is known before placement.
 */
export function buildHouseholds(people) {
  const byId = personMap(people);
  const assigned = new Set();
  const households = [];

  const ordered = [...people].sort((left, right) => left.id.localeCompare(right.id));
  for (const person of ordered) {
    if (assigned.has(person.id)) continue;
    const members = [person.id];
    assigned.add(person.id);
    for (const spouseId of spouseIds(person).sort()) {
      if (!byId.has(spouseId) || assigned.has(spouseId)) continue;
      members.push(spouseId);
      assigned.add(spouseId);
    }
    members.sort((left, right) => {
      const gLeft = String(byId.get(left)?.data?.gender || '');
      const gRight = String(byId.get(right)?.data?.gender || '');
      const rank = { M: 0, F: 1, '': 2 };
      return (rank[gLeft] ?? 2) - (rank[gRight] ?? 2) || left.localeCompare(right);
    });
    households.push({
      id: `hh:${members.slice().sort().join('+')}`,
      memberIds: members,
      size: members.length,
    });
  }

  return households.sort((left, right) => left.id.localeCompare(right.id));
}

function placeCross(index, cardSize, gap) {
  return index * (cardSize + gap);
}

/**
 * Household-first layout. Coordinates are final before links are built.
 */
export function layoutFamilyTree(
  people,
  {
    centerId,
    cardWidth = 184,
    cardHeight = 170,
    orientation = 'vertical',
    nodeSeparation = 236,
    levelSeparation = 224,
    ancestryDepth = 8,
    progenyDepth = 8,
  } = {},
) {
  if (!Array.isArray(people) || !people.length) {
    return { nodes: [], links: [], households: [], meta: { centerId, orientation } };
  }

  const visible = selectVisiblePeople(people, centerId, { ancestryDepth, progenyDepth });
  const generation = assignGenerations(visible, centerId);
  const households = buildHouseholds(visible);
  const householdByMember = new Map();
  for (const household of households) {
    for (const memberId of household.memberIds) householdByMember.set(memberId, household);
  }

  const isHorizontal = orientation === 'horizontal';
  const crossStep = isHorizontal ? levelSeparation : nodeSeparation;
  const generationStep = isHorizontal ? nodeSeparation : levelSeparation;
  const cardCross = isHorizontal ? cardHeight : cardWidth;
  const gap = Math.max(0, crossStep - cardCross);

  const householdsByGeneration = new Map();
  for (const household of households) {
    const g = Math.min(...household.memberIds.map((id) => generation.get(id) ?? 0));
    if (!householdsByGeneration.has(g)) householdsByGeneration.set(g, []);
    householdsByGeneration.get(g).push(household);
  }

  const nodePositions = new Map();

  for (const g of [...householdsByGeneration.keys()].sort((left, right) => left - right)) {
    const row = householdsByGeneration.get(g);
    // Stable order: households with a blood child toward center first, then id.
    row.sort((left, right) => left.id.localeCompare(right.id));

    const widths = row.map((household) => household.size * cardCross + (household.size - 1) * gap);
    const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, row.length - 1) * gap;
    let cursor = -total / 2;

    for (let index = 0; index < row.length; index += 1) {
      const household = row[index];
      const width = widths[index];
      const start = cursor;
      household.memberIds.forEach((memberId, memberIndex) => {
        const cross = start + placeCross(memberIndex, cardCross, gap) + cardCross / 2;
        const genAxis = g * generationStep;
        if (isHorizontal) {
          nodePositions.set(memberId, { x: genAxis, y: cross });
        } else {
          nodePositions.set(memberId, { x: cross, y: genAxis });
        }
      });
      household.x0 = start;
      household.x1 = start + width;
      household.generation = g;
      cursor += width + gap;
    }
  }

  const nodes = visible
    .map((person) => {
      const position = nodePositions.get(person.id) || { x: 0, y: 0 };
      const household = householdByMember.get(person.id);
      return {
        id: person.id,
        x: position.x,
        y: position.y,
        generation: generation.get(person.id) ?? 0,
        householdId: household?.id,
        gender: person.data?.gender || '',
        width: cardWidth,
        height: cardHeight,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = [];
  const spouseSeen = new Set();
  const parentSeen = new Set();

  for (const person of visible) {
    for (const spouseId of spouseIds(person)) {
      if (!nodeById.has(spouseId)) continue;
      const key = [person.id, spouseId].sort().join('|');
      if (spouseSeen.has(key)) continue;
      spouseSeen.add(key);
      const left = nodeById.get(person.id);
      const right = nodeById.get(spouseId);
      links.push({
        type: 'spouse',
        source: left.id,
        target: right.id,
        points: [
          [left.x, left.y],
          [right.x, right.y],
        ],
      });
    }
    for (const parentId of parentIds(person)) {
      if (!nodeById.has(parentId)) continue;
      const key = `${parentId}->${person.id}`;
      if (parentSeen.has(key)) continue;
      parentSeen.add(key);
      const parent = nodeById.get(parentId);
      const child = nodeById.get(person.id);
      const midY = (parent.y + child.y) / 2;
      const midX = (parent.x + child.x) / 2;
      links.push({
        type: 'parent-child',
        source: parent.id,
        target: child.id,
        points: isHorizontal
          ? [
              [parent.x, parent.y],
              [midX, parent.y],
              [midX, child.y],
              [child.x, child.y],
            ]
          : [
              [parent.x, parent.y],
              [parent.x, midY],
              [child.x, midY],
              [child.x, child.y],
            ],
      });
    }
  }

  links.sort((left, right) => {
    const leftKey = `${left.type}:${left.source}:${left.target}`;
    const rightKey = `${right.type}:${right.source}:${right.target}`;
    return leftKey.localeCompare(rightKey);
  });

  return {
    nodes,
    links,
    households: households.map((household) => ({
      id: household.id,
      memberIds: household.memberIds,
      size: household.size,
      generation: household.generation,
      x0: household.x0,
      x1: household.x1,
    })),
    meta: {
      centerId: String(centerId),
      orientation,
      cardWidth,
      cardHeight,
      nodeSeparation,
      levelSeparation,
      visibleCount: nodes.length,
      inputCount: people.length,
    },
  };
}
