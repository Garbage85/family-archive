/**
 * Parent→children geometric alignment for placement scoring & packing.
 *
 * Soft objective: child household / sibling block should sit under the
 * parent family junction (spouse-link midpoint or single-parent card center).
 * Never overrides family-side / branch hard constraints.
 */

const EPS = 1e-6;

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

function parentIds(person) {
  return unique(person?.rels?.parents);
}

function spouseIds(person) {
  return unique(person?.rels?.spouses);
}

/**
 * Build parent-pair → children map from visible people (topology, not links).
 */
export function buildParentChildFamilies(people, visibleIds = null) {
  const visible = visibleIds ? new Set([...visibleIds].map(String)) : null;
  const byId = new Map((people || []).map((person) => [String(person.id), person]));
  const families = new Map();

  for (const person of people || []) {
    const childId = String(person.id);
    if (visible && !visible.has(childId)) continue;
    const parents = parentIds(person).filter((id) => byId.has(id) && (!visible || visible.has(id)));
    if (!parents.length) continue;
    const key = [...parents].sort().join('+');
    if (!families.has(key)) {
      families.set(key, {
        key,
        familyKey: `fam:${key}`,
        parentIds: [...parents].sort(),
        childIds: [],
      });
    }
    families.get(key).childIds.push(childId);
  }

  return [...families.values()]
    .map((family) => ({
      ...family,
      childIds: unique(family.childIds).sort((a, b) => a.localeCompare(b)),
    }))
    .sort((a, b) => a.familyKey.localeCompare(b.familyKey));
}

/**
 * Family junction cross-axis target from parent node positions.
 * Couple → midpoint of card centers (≈ spouse-link mid when widths equal).
 * Single parent → parent card center.
 */
export function familyTargetCross(parentNodes, isHorizontal = false) {
  const parents = (parentNodes || []).filter(Boolean);
  if (!parents.length) return null;
  const axis = (node) => (isHorizontal ? node.y : node.x);
  if (parents.length === 1) return axis(parents[0]);
  const values = parents.map(axis);
  return (Math.min(...values) + Math.max(...values)) / 2;
}

/**
 * Household center on the cross-axis.
 */
export function householdCenterCross(household, nodePositions, isHorizontal = false) {
  const xs = [];
  for (const id of household.memberIds || []) {
    const pos = nodePositions.get(String(id)) || nodePositions.get(id);
    if (!pos) continue;
    xs.push(isHorizontal ? pos.y : pos.x);
  }
  if (!xs.length) return null;
  return (Math.min(...xs) + Math.max(...xs)) / 2;
}

/**
 * Contiguous sibling block bounds / center for a parent pair's children.
 * Includes spouses of children that share a household (whole household).
 */
export function childBlockGeometry({
  childIds,
  households,
  nodePositions,
  peopleById = null,
  isHorizontal = false,
}) {
  const childSet = new Set((childIds || []).map(String));
  const memberSet = new Set(childSet);
  if (peopleById) {
    for (const childId of childSet) {
      for (const spouseId of spouseIds(peopleById.get(childId))) {
        memberSet.add(String(spouseId));
      }
    }
  }

  const blockHouseholds = [];
  const seen = new Set();
  for (const household of households || []) {
    const hit = (household.memberIds || []).some((id) => childSet.has(String(id)));
    if (!hit || seen.has(household.id)) continue;
    seen.add(household.id);
    blockHouseholds.push(household);
  }

  const crosses = [];
  for (const household of blockHouseholds) {
    for (const id of household.memberIds || []) {
      if (!memberSet.has(String(id))) continue;
      const pos = nodePositions.get(String(id)) || nodePositions.get(id);
      if (!pos) continue;
      crosses.push(isHorizontal ? pos.y : pos.x);
    }
  }
  // Fallback: child cards only.
  if (!crosses.length) {
    for (const childId of childSet) {
      const pos = nodePositions.get(childId);
      if (!pos) continue;
      crosses.push(isHorizontal ? pos.y : pos.x);
    }
  }
  if (!crosses.length) {
    return {
      blockMin: null,
      blockMax: null,
      blockCenter: null,
      householdIds: blockHouseholds.map((h) => h.id),
      childCount: childSet.size,
    };
  }
  const blockMin = Math.min(...crosses);
  const blockMax = Math.max(...crosses);
  return {
    blockMin,
    blockMax,
    blockCenter: (blockMin + blockMax) / 2,
    householdIds: blockHouseholds.map((h) => h.id),
    childCount: childSet.size,
  };
}

/**
 * Structural depth weight: families closer to center generation weigh more.
 */
export function familyAlignmentWeight(family, generationMap, centerGeneration = 0) {
  const parentGens = (family.parentIds || []).map((id) => generationMap.get(String(id)) ?? 0);
  const childGens = (family.childIds || []).map((id) => generationMap.get(String(id)) ?? 0);
  const gens = [...parentGens, ...childGens];
  if (!gens.length) return 1;
  const mid = gens.reduce((sum, g) => sum + g, 0) / gens.length;
  const dist = Math.abs(mid - centerGeneration);
  return 1 / (1 + dist);
}

/**
 * Measure alignment for all parent families against placed positions.
 */
export function measureFamilyAlignment(
  layout,
  { people = null, orientation = 'vertical', centerId = null } = {},
) {
  const isHorizontal = orientation === 'horizontal';
  const nodes = layout.nodes || [];
  const nodePositions = new Map(nodes.map((node) => [String(node.id), node]));
  const generationMap = new Map(nodes.map((node) => [String(node.id), node.generation ?? 0]));
  const visibleIds = nodes.map((node) => String(node.id));
  const peopleList = people || [];
  const peopleById = new Map(peopleList.map((person) => [String(person.id), person]));
  const households = layout.households || [];
  const centerGeneration = centerId != null ? (generationMap.get(String(centerId)) ?? 0) : 0;

  const families = buildParentChildFamilies(peopleList, visibleIds);
  const byFamily = [];
  let familyAlignmentErrorTotal = 0;
  let maxFamilyAlignmentError = 0;
  let singleChildAlignmentError = 0;
  let singleChildHorizontalOffset = 0;
  const familyTargetByFamily = {};
  const childBlockCenterByFamily = {};
  const localBusLengthByFamily = {};
  let familyHorizontalSpread = 0;

  for (const family of families) {
    const parents = family.parentIds.map((id) => nodePositions.get(id)).filter(Boolean);
    const target = familyTargetCross(parents, isHorizontal);
    if (target == null) continue;
    const block = childBlockGeometry({
      childIds: family.childIds,
      households,
      nodePositions,
      peopleById,
      isHorizontal,
    });
    if (block.blockCenter == null) continue;

    const alignmentError = Math.abs(block.blockCenter - target);
    const weight = familyAlignmentWeight(family, generationMap, centerGeneration);
    const weighted = alignmentError * weight;
    familyAlignmentErrorTotal += weighted;
    maxFamilyAlignmentError = Math.max(maxFamilyAlignmentError, alignmentError);

    let horizontalOffset = 0;
    if (family.childIds.length === 1) {
      singleChildAlignmentError += alignmentError * weight;
      const childId = family.childIds[0];
      const childPos = nodePositions.get(childId);
      if (childPos) {
        // Whole household center vs target (not only anchor card).
        horizontalOffset = alignmentError;
        singleChildHorizontalOffset += horizontalOffset * weight;
      }
    } else {
      horizontalOffset = Math.max(
        Math.abs(block.blockMin - target),
        Math.abs(block.blockMax - target),
      );
    }

    const busLength =
      block.blockMin != null && block.blockMax != null
        ? Math.max(block.blockMax, target) - Math.min(block.blockMin, target)
        : 0;
    familyHorizontalSpread += busLength * weight;

    familyTargetByFamily[family.familyKey] = target;
    childBlockCenterByFamily[family.familyKey] = block.blockCenter;
    localBusLengthByFamily[family.familyKey] = busLength;

    byFamily.push({
      familyKey: family.familyKey,
      parentIds: family.parentIds,
      childIds: family.childIds,
      childCount: family.childIds.length,
      familyTargetCross: target,
      childBlockCenter: block.blockCenter,
      blockMin: block.blockMin,
      blockMax: block.blockMax,
      alignmentError,
      weight,
      weightedError: weighted,
      singleChildHorizontalOffset: family.childIds.length === 1 ? horizontalOffset : 0,
      busLength,
      householdIds: block.householdIds,
    });
  }

  byFamily.sort((a, b) => a.familyKey.localeCompare(b.familyKey));

  return {
    familyAlignmentErrorTotal,
    maxFamilyAlignmentError,
    singleChildAlignmentError,
    singleChildHorizontalOffset,
    familyHorizontalSpread,
    familyTargetByFamily,
    childBlockCenterByFamily,
    localBusLengthByFamily,
    families: byFamily,
  };
}

function householdWidth(household, cardCross, gap) {
  const size = household.size || household.memberIds?.length || 1;
  return size * cardCross + Math.max(0, size - 1) * gap;
}

/**
 * Primary parent-family key for a household (deterministic).
 * Dual-parent membership (half-siblings / in-law mixes) returns the
 * lexicographically first key; callers average targets separately.
 */
export function householdParentFamilyKeys(household, peopleById) {
  const keys = new Set();
  for (const id of household.memberIds || []) {
    const parents = parentIds(peopleById?.get(String(id))).sort();
    if (!parents.length) continue;
    keys.add(parents.join('+'));
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * Preferred household centers from already-placed parent positions.
 * Half-siblings / dual membership → mean of relevant family targets.
 * Contiguous households sharing one parent-pair key are treated as a
 * sibling block whose collective center prefers the family junction.
 */
export function computePreferredHouseholdCenters(
  orderedHouseholds,
  {
    parentPositions = new Map(),
    peopleById = new Map(),
    cardCross = 184,
    gap = 52,
    isHorizontal = false,
    childPositions = new Map(),
  } = {},
) {
  const list = orderedHouseholds || [];
  const widths = list.map((household) => householdWidth(household, cardCross, gap));
  const rawTargets = list.map((household) => {
    const targets = [];
    const weights = [];
    for (const id of household.memberIds || []) {
      const parents = parentIds(peopleById.get(String(id))).filter((pid) =>
        parentPositions.has(String(pid)),
      );
      if (!parents.length) continue;
      const parentNodes = parents.map((pid) => {
        const pos = parentPositions.get(String(pid));
        return { id: pid, x: pos.x, y: pos.y };
      });
      const target = familyTargetCross(parentNodes, isHorizontal);
      if (target == null) continue;
      // Single-child families pull harder toward the junction.
      const siblings = parents.length
        ? // count co-children of same parent set among this generation row
          list.filter((other) =>
            (other.memberIds || []).some((mid) => {
              const op = parentIds(peopleById.get(String(mid)))
                .filter((pid) => parentPositions.has(String(pid)))
                .sort()
                .join('+');
              return op === [...parents].sort().join('+');
            }),
          ).length
        : 1;
      const w = siblings <= 1 ? 2.5 : 1;
      targets.push(target);
      weights.push(w);
    }
    // Bottom-up hint: sit above the child household block (whole households).
    if (childPositions.size) {
      const childXs = [];
      for (const id of household.memberIds || []) {
        const person = peopleById.get(String(id));
        for (const childId of unique(person?.rels?.children)) {
          const childPos = childPositions.get(String(childId));
          if (!childPos) continue;
          childXs.push(isHorizontal ? childPos.y : childPos.x);
          // Include visible spouses of the child so the parent targets the
          // full child household, not only the blood-child card.
          for (const spouseId of spouseIds(peopleById.get(String(childId)))) {
            const spousePos = childPositions.get(String(spouseId));
            if (!spousePos) continue;
            childXs.push(isHorizontal ? spousePos.y : spousePos.x);
          }
        }
      }
      if (childXs.length) {
        const childMid = (Math.min(...childXs) + Math.max(...childXs)) / 2;
        targets.push(childMid);
        weights.push(1.35);
      }
    }
    if (!targets.length) return null;
    let wSum = 0;
    let acc = 0;
    for (let i = 0; i < targets.length; i += 1) {
      acc += targets[i] * weights[i];
      wSum += weights[i];
    }
    return acc / wSum;
  });

  // Group contiguous households that share an exclusive parent-family key
  // into sibling blocks and center the whole block on that family's target.
  const preferred = rawTargets.slice();
  let index = 0;
  while (index < list.length) {
    const keys = householdParentFamilyKeys(list[index], peopleById);
    if (keys.length !== 1 || preferred[index] == null) {
      index += 1;
      continue;
    }
    const familyKey = keys[0];
    let end = index + 1;
    while (end < list.length) {
      const otherKeys = householdParentFamilyKeys(list[end], peopleById);
      if (otherKeys.length !== 1 || otherKeys[0] !== familyKey) break;
      if (preferred[end] == null) break;
      end += 1;
    }
    const block = list.slice(index, end);
    if (block.length >= 1) {
      // Family target from first household's raw target (same parents).
      const target = preferred[index];
      const blockWidth =
        widths.slice(index, end).reduce((sum, width) => sum + width, 0) +
        Math.max(0, end - index - 1) * gap;
      let cursor = target - blockWidth / 2;
      for (let i = index; i < end; i += 1) {
        preferred[i] = cursor + widths[i] / 2;
        cursor += widths[i] + gap;
      }
    }
    index = end;
  }

  // Fill unknown preferences by linear interpolation between neighbors.
  const known = preferred.map((value, i) => (value == null ? null : i)).filter((i) => i != null);
  if (!known.length) {
    // No parent geometry — fall back to centered packing later.
    return { preferred: preferred.map(() => null), widths };
  }
  for (let i = 0; i < preferred.length; i += 1) {
    if (preferred[i] != null) continue;
    const left = [...known].reverse().find((k) => k < i);
    const right = known.find((k) => k > i);
    if (left != null && right != null) {
      const t = (i - left) / (right - left);
      preferred[i] = preferred[left] * (1 - t) + preferred[right] * t;
    } else if (left != null) {
      let cursor = preferred[left] + widths[left] / 2 + gap;
      for (let j = left + 1; j <= i; j += 1) {
        preferred[j] = cursor + widths[j] / 2;
        cursor += widths[j] + gap;
      }
    } else if (right != null) {
      let cursor = preferred[right] - widths[right] / 2 - gap;
      for (let j = right - 1; j >= i; j -= 1) {
        preferred[j] = cursor - widths[j] / 2;
        cursor -= widths[j] + gap;
      }
    }
  }

  return { preferred, widths };
}

/**
 * Tight contiguous pack. With pinCenterId + core: centerId card at 0.
 * Otherwise the row is centered on 0.
 */
export function tightPackStarts(
  orderedHouseholds,
  { widths = [], gap = 52, pinCenterId = null, memberOrders = null, cardCross = 184 } = {},
) {
  const n = orderedHouseholds.length;
  if (!n) return [];
  const starts = new Array(n).fill(0);
  const coreIndex = orderedHouseholds.findIndex((household) => household.side === 'core');

  if (coreIndex >= 0 && pinCenterId) {
    const members = memberOrders?.[coreIndex] || orderedHouseholds[coreIndex].memberIds || [];
    const centerIndex = members.findIndex((id) => String(id) === String(pinCenterId));
    const idx = centerIndex >= 0 ? centerIndex : 0;
    starts[coreIndex] = -idx * (cardCross + gap) - cardCross / 2;
    for (let i = coreIndex - 1; i >= 0; i -= 1) {
      starts[i] = starts[i + 1] - gap - widths[i];
    }
    for (let i = coreIndex + 1; i < n; i += 1) {
      starts[i] = starts[i - 1] + widths[i - 1] + gap;
    }
    return starts;
  }

  const total = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, n - 1) * gap;
  let cursor = -total / 2;
  for (let i = 0; i < n; i += 1) {
    starts[i] = cursor;
    cursor += widths[i] + gap;
  }
  return starts;
}

/**
 * Pack household starts.
 *
 * - Pinned couple-core row: always tight against the focus person at 0.
 *   Opening gaps beside the core stretches parent buses across empty space
 *   and creates false junctions / collinear overlaps.
 * - Unpinned rows: place at preferred centers, then resolve overlaps LTR/RTL
 *   (gaps between unrelated branches are allowed so parents can sit above
 *   their own children).
 */
export function packHouseholdStarts(
  orderedHouseholds,
  {
    preferred = [],
    widths = [],
    gap = 52,
    pinCenterId = null,
    memberOrders = null,
    cardCross = 184,
  } = {},
) {
  const n = orderedHouseholds.length;
  if (!n) return [];
  const coreIndex = orderedHouseholds.findIndex((household) => household.side === 'core');

  // Couple-core generation must stay a tight family-side pack.
  if (coreIndex >= 0 && pinCenterId) {
    return tightPackStarts(orderedHouseholds, {
      widths,
      gap,
      pinCenterId,
      memberOrders,
      cardCross,
    });
  }

  const hasPrefs = preferred.some((value) => value != null && Number.isFinite(value));
  const tight = tightPackStarts(orderedHouseholds, {
    widths,
    gap,
    pinCenterId: null,
    memberOrders,
    cardCross,
  });
  if (!hasPrefs) return tight;

  // Interpolate missing prefs from neighbors (in center space).
  const prefCenters = preferred.slice();
  const known = prefCenters
    .map((value, index) => (value == null || !Number.isFinite(value) ? null : index))
    .filter((index) => index != null);
  for (let i = 0; i < n; i += 1) {
    if (prefCenters[i] != null) continue;
    const left = [...known].reverse().find((index) => index < i);
    const right = known.find((index) => index > i);
    if (left != null && right != null) {
      const t = (i - left) / (right - left);
      prefCenters[i] = prefCenters[left] * (1 - t) + prefCenters[right] * t;
    } else if (left != null) {
      prefCenters[i] =
        tight[i] + widths[i] / 2 + (prefCenters[left] - (tight[left] + widths[left] / 2));
    } else if (right != null) {
      prefCenters[i] =
        tight[i] + widths[i] / 2 + (prefCenters[right] - (tight[right] + widths[right] / 2));
    } else {
      prefCenters[i] = tight[i] + widths[i] / 2;
    }
  }

  const ideal = prefCenters.map((center, index) => center - widths[index] / 2);
  let fits = true;
  for (let i = 1; i < n; i += 1) {
    if (ideal[i] + EPS < ideal[i - 1] + widths[i - 1] + gap) {
      fits = false;
      break;
    }
  }
  if (fits) return ideal;

  // Preferences denser than min spacing: keep a tight row, but anchor the
  // endpoints to the (clamped) preferred edge span so single-child families
  // on both sides share the compromise instead of LTR-left dominance.
  const leftPref = prefCenters[0];
  const rightPref = prefCenters[n - 1];
  const tightLeft = tight[0] + widths[0] / 2;
  const tightRight = tight[n - 1] + widths[n - 1] / 2;
  const need = tightRight - tightLeft;
  const want = rightPref - leftPref;
  let targetLeft;
  if (want >= need - EPS) {
    targetLeft = leftPref;
  } else {
    const mid = (leftPref + rightPref) / 2;
    targetLeft = mid - need / 2;
  }
  const shift = targetLeft - tightLeft;
  return tight.map((start) => start + shift);
}

/**
 * Estimate household / member positions for a trial order, optionally
 * aligning to parent positions (same semantics as placeHouseholdRow).
 */
export function estimateHouseholdCenters(
  orderedHouseholds,
  {
    cardCross = 184,
    gap = 52,
    isHorizontal = false,
    parentPositions = null,
    childPositions = null,
    peopleById = null,
    pinCenterId = null,
    memberOrders = null,
  } = {},
) {
  const list = orderedHouseholds || [];
  const { preferred, widths } = computePreferredHouseholdCenters(list, {
    parentPositions: parentPositions || new Map(),
    childPositions: childPositions || new Map(),
    peopleById: peopleById || new Map(),
    cardCross,
    gap,
    isHorizontal,
  });
  const starts = packHouseholdStarts(list, {
    preferred,
    widths,
    gap,
    pinCenterId,
    memberOrders,
    cardCross,
  });

  const centers = new Map();
  const memberPositions = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const household = list[index];
    const start = starts[index];
    const members = memberOrders?.[index] || household.memberIds || [];
    const xs = [];
    members.forEach((memberId, memberIndex) => {
      const cross = start + memberIndex * (cardCross + gap) + cardCross / 2;
      xs.push(cross);
      const pos = isHorizontal ? { x: 0, y: cross } : { x: cross, y: 0 };
      memberPositions.set(String(memberId), pos);
    });
    if (xs.length) {
      centers.set(household.id, (Math.min(...xs) + Math.max(...xs)) / 2);
    }
  }
  return { centers, memberPositions, starts, preferred };
}

/**
 * Geometric alignment cost for a trial child-generation order given parent positions.
 * Used inside barycenter passes — must stay cheap and deterministic.
 */
export function scoreOrderAlignment({
  orderedHouseholds,
  parentPositions,
  families,
  peopleById,
  generationMap,
  childGeneration,
  cardCross,
  gap,
  isHorizontal = false,
  centerGeneration = 0,
  pinCenterId = null,
}) {
  if (!orderedHouseholds?.length || !families?.length) return 0;
  const { memberPositions } = estimateHouseholdCenters(orderedHouseholds, {
    cardCross,
    gap,
    isHorizontal,
    parentPositions,
    peopleById,
    pinCenterId,
  });

  const positions = new Map(memberPositions);
  for (const [id, pos] of parentPositions || []) {
    positions.set(String(id), pos);
  }

  let cost = 0;
  for (const family of families) {
    const childGens = family.childIds.map((id) => generationMap.get(String(id)) ?? 0);
    if (!childGens.length || Math.min(...childGens) !== childGeneration) continue;
    const parentNodes = family.parentIds
      .map((id) => {
        const pos = positions.get(String(id));
        if (!pos) return null;
        return { id, x: pos.x, y: pos.y };
      })
      .filter(Boolean);
    if (parentNodes.length !== family.parentIds.length) continue;

    const target = familyTargetCross(parentNodes, isHorizontal);
    if (target == null) continue;

    const block = childBlockGeometry({
      childIds: family.childIds,
      households: orderedHouseholds,
      nodePositions: positions,
      peopleById,
      isHorizontal,
    });
    if (block.blockCenter == null) continue;

    const weight = familyAlignmentWeight(family, generationMap, centerGeneration);
    const err = Math.abs(block.blockCenter - target);
    const coef = family.childIds.length <= 1 ? 2.5 : 1;
    // Soft route proxy: bus length / single-child horizontal run.
    const bus =
      block.blockMin != null && block.blockMax != null
        ? Math.max(block.blockMax, target) - Math.min(block.blockMin, target)
        : err;
    cost += (err * coef + bus * 0.35) * weight;
  }
  return cost;
}

export { EPS };
