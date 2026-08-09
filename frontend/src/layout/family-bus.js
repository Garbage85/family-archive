/**
 * Local family-bus geometry: each parent pair owns a short child bus that
 * covers only its children (+ stem), never a generation-wide magistral.
 */

export const ROUTING_BUS_PADDING = 0;

const EPS = 1e-6;

function almostEq(a, b, eps = EPS) {
  return Math.abs(a - b) <= eps;
}

function unique(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))];
}

/**
 * Local bus interval for a parent pair.
 * bus = [min(children, stem), max(children, stem)] ± ROUTING_BUS_PADDING
 * Stem is the only allowed extension beyond the child span.
 */
export function computeLocalBusInterval({
  childCross,
  stemCross,
  padding = ROUTING_BUS_PADDING,
} = {}) {
  const xs = (childCross || []).filter((value) => Number.isFinite(value));
  if (!xs.length && !Number.isFinite(stemCross)) {
    return { busStart: 0, busEnd: 0, naturalSpan: 0, stemOverhang: 0, excess: 0 };
  }
  const childMin = xs.length ? Math.min(...xs) : stemCross;
  const childMax = xs.length ? Math.max(...xs) : stemCross;
  const naturalSpan = Math.max(0, childMax - childMin);
  const stem = Number.isFinite(stemCross) ? stemCross : (childMin + childMax) / 2;
  const stemOverhang =
    stem < childMin - EPS ? childMin - stem : stem > childMax + EPS ? stem - childMax : 0;
  const busStart = Math.min(childMin, stem) - padding;
  const busEnd = Math.max(childMax, stem) + padding;
  return {
    busStart,
    busEnd,
    naturalSpan,
    stemCross: stem,
    stemOverhang,
    // Local interval itself has zero excess; callers compare actual routed span.
    excess: 0,
  };
}

function collectBusSegments(link, isHorizontal) {
  const segs = [];
  const points = link.points || [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (isHorizontal) {
      if (almostEq(a[0], b[0]) && Math.abs(a[1] - b[1]) > 1) {
        segs.push({
          axis: a[0],
          span0: Math.min(a[1], b[1]),
          span1: Math.max(a[1], b[1]),
          familyKey: link.familyKey,
        });
      }
    } else if (almostEq(a[1], b[1]) && Math.abs(a[0] - b[0]) > 1) {
      segs.push({
        axis: a[1],
        span0: Math.min(a[0], b[0]),
        span1: Math.max(a[0], b[0]),
        familyKey: link.familyKey,
      });
    }
  }
  return segs;
}

/**
 * Per-family bus report from routed links + nodes.
 */
export function measureFamilyBuses(layout, { orientation = 'vertical', people = null } = {}) {
  const isHorizontal = orientation === 'horizontal';
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const peopleById = new Map((people || []).map((person) => [String(person.id), person]));
  const byFamily = new Map();

  for (const link of layout.links || []) {
    if (link.type !== 'parent-child' || !link.familyKey) continue;
    if (!byFamily.has(link.familyKey)) {
      byFamily.set(link.familyKey, {
        familyKey: link.familyKey,
        parentIds: [],
        childIds: new Set(),
        links: [],
        junction: link.junction || null,
        laneIndex: link.laneIndex ?? null,
        busAxis: null,
        actualStart: Infinity,
        actualEnd: -Infinity,
      });
    }
    const entry = byFamily.get(link.familyKey);
    entry.links.push(link);
    entry.childIds.add(String(link.target));
    if (link.junction) entry.junction = link.junction;
    if (link.laneIndex != null) entry.laneIndex = link.laneIndex;
    for (const seg of collectBusSegments(link, isHorizontal)) {
      entry.busAxis = seg.axis;
      entry.actualStart = Math.min(entry.actualStart, seg.span0);
      entry.actualEnd = Math.max(entry.actualEnd, seg.span1);
    }
  }

  // Recover parent ids from familyKey fam:a+b or fam:a
  for (const entry of byFamily.values()) {
    const raw = String(entry.familyKey).replace(/^fam:/, '');
    entry.parentIds = raw.includes('->') ? [] : raw.split('+').filter(Boolean);
  }

  const rows = [];
  for (const entry of byFamily.values()) {
    const children = [...entry.childIds]
      .map((id) => byId.get(id))
      .filter(Boolean)
      .sort((a, b) => (isHorizontal ? a.y - b.y : a.x - b.x) || a.id.localeCompare(b.id));
    const childCross = children.map((node) => (isHorizontal ? node.y : node.x));
    const stemCross = entry.junction ? (isHorizontal ? entry.junction.y : entry.junction.x) : null;
    const local = computeLocalBusInterval({ childCross, stemCross });
    const hasBus = Number.isFinite(entry.actualStart) && entry.actualStart <= entry.actualEnd;
    const actualStart = hasBus ? entry.actualStart : local.busStart;
    const actualEnd = hasBus ? entry.actualEnd : local.busEnd;
    const actualSpan = Math.max(0, actualEnd - actualStart);
    const allowedStart = local.busStart;
    const allowedEnd = local.busEnd;
    const localityExcess =
      Math.max(0, allowedStart - actualStart) + Math.max(0, actualEnd - allowedEnd);

    const parentSet = new Set(entry.parentIds);
    const childSet = new Set(entry.childIds);
    const memberSet = new Set([...parentSet, ...childSet]);
    // Spouses of children count as family-block members for foreign checks.
    for (const childId of childSet) {
      const person = peopleById.get(childId);
      for (const spouseId of person?.rels?.spouses || []) memberSet.add(String(spouseId));
    }

    const parentGens = entry.parentIds
      .map((id) => byId.get(id)?.generation)
      .filter((g) => g != null);
    const childGens = children.map((node) => node.generation).filter((g) => g != null);
    const corridorGens = new Set([...parentGens, ...childGens]);

    let foreignHouseholdsUnderBus = 0;
    const foreignIds = [];
    for (const node of layout.nodes || []) {
      const id = String(node.id);
      if (memberSet.has(id)) continue;
      if (!corridorGens.has(node.generation)) continue;
      const cross = isHorizontal ? node.y : node.x;
      if (cross + EPS < actualStart || cross - EPS > actualEnd) continue;
      foreignHouseholdsUnderBus += 1;
      foreignIds.push(id);
    }

    const parentCross = entry.parentIds
      .map((id) => byId.get(id))
      .filter(Boolean)
      .map((node) => (isHorizontal ? node.y : node.x));
    const groupCross = [...parentCross, ...childCross];
    const familyHorizontalSpread = groupCross.length
      ? Math.max(...groupCross) - Math.min(...groupCross)
      : 0;

    rows.push({
      familyKey: entry.familyKey,
      parentIds: entry.parentIds,
      childIds: children.map((node) => node.id),
      laneIndex: entry.laneIndex,
      busAxis: entry.busAxis,
      busStart: actualStart,
      busEnd: actualEnd,
      busLength: actualSpan,
      naturalChildSpan: local.naturalSpan,
      allowedStart,
      allowedEnd,
      excess: localityExcess,
      stemOverhang: local.stemOverhang,
      foreignHouseholdsUnderBus,
      foreignIds,
      familyHorizontalSpread,
      singleChild: children.length === 1,
    });
  }

  return rows.sort((a, b) => a.familyKey.localeCompare(b.familyKey));
}

export function findFamilyBusLocalityViolations(layout, options = {}) {
  return measureFamilyBuses(layout, options).filter((row) => row.excess > EPS);
}

/**
 * Unrelated families must not share an overlapping collinear bus segment
 * (same axis + overlapping span). Non-overlapping local segments may share a lane.
 */
export function findUnrelatedFamiliesSharingBusSegment(layout, { orientation = 'vertical' } = {}) {
  const isHorizontal = orientation === 'horizontal';
  const segs = [];
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child' || !link.familyKey) continue;
    for (const seg of collectBusSegments(link, isHorizontal)) segs.push(seg);
  }
  const issues = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const a = segs[i];
      const b = segs[j];
      if (!a.familyKey || a.familyKey === b.familyKey) continue;
      if (!almostEq(a.axis, b.axis)) continue;
      if (Math.min(a.span1, b.span1) - Math.max(a.span0, b.span0) <= EPS) continue;
      issues.push({
        familyA: a.familyKey,
        familyB: b.familyKey,
        axis: a.axis,
        reason: 'unrelatedFamiliesSharingBusSegment',
      });
    }
  }
  return issues;
}

/**
 * Children of the same parent pair (plus their spouses) must form a contiguous
 * block on the child generation cross-axis.
 */
export function findChildrenBlockInterleavingViolations(
  layout,
  { orientation = 'vertical', people = null } = {},
) {
  const isHorizontal = orientation === 'horizontal';
  const byId = new Map((layout.nodes || []).map((node) => [String(node.id), node]));
  const peopleById = new Map((people || []).map((person) => [String(person.id), person]));
  const childToParents = new Map();

  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    const childId = String(link.target);
    const parentId = String(link.source);
    if (!byId.has(childId) || !byId.has(parentId)) continue;
    if (!childToParents.has(childId)) childToParents.set(childId, new Set());
    childToParents.get(childId).add(parentId);
  }

  const families = new Map();
  for (const [childId, parents] of childToParents) {
    const key = [...parents].sort().join('+');
    if (!families.has(key)) families.set(key, new Set());
    families.get(key).add(childId);
  }

  const issues = [];
  for (const [key, childIds] of families) {
    if (childIds.size < 2) continue;
    const children = [...childIds].map((id) => byId.get(id)).filter(Boolean);
    if (children.length < 2) continue;
    const childGen = children[0].generation;
    const genNodes = (layout.nodes || [])
      .filter((node) => node.generation === childGen)
      .sort(
        (a, b) =>
          (isHorizontal ? a.y - b.y || a.x - b.x : a.x - b.x || a.y - b.y) ||
          a.id.localeCompare(b.id),
      );

    const memberSet = new Set(childIds);
    for (const childId of childIds) {
      const person = peopleById.get(childId);
      for (const spouseId of person?.rels?.spouses || []) {
        if (byId.has(String(spouseId)) && byId.get(String(spouseId)).generation === childGen) {
          memberSet.add(String(spouseId));
        }
      }
    }

    const indices = [];
    for (let i = 0; i < genNodes.length; i += 1) {
      if (memberSet.has(String(genNodes[i].id))) indices.push(i);
    }
    if (indices.length < 2) continue;
    const lo = indices[0];
    const hi = indices[indices.length - 1];
    const intruders = [];
    for (let i = lo; i <= hi; i += 1) {
      const id = String(genNodes[i].id);
      if (!memberSet.has(id)) intruders.push(id);
    }
    if (intruders.length) {
      issues.push({
        familyKey: `fam:${key}`,
        childIds: [...childIds].sort(),
        intruders,
        reason: 'childrenBlockInterleavingViolations',
      });
    }
  }
  return issues;
}

export function summarizeBusMetrics(rows) {
  let busExcessLength = 0;
  let maxBusExcessLength = 0;
  let foreignHouseholdsUnderBus = 0;
  let familyHorizontalSpread = 0;
  let maxBusLength = 0;
  for (const row of rows || []) {
    busExcessLength += row.excess || 0;
    maxBusExcessLength = Math.max(maxBusExcessLength, row.excess || 0);
    foreignHouseholdsUnderBus += row.foreignHouseholdsUnderBus || 0;
    familyHorizontalSpread += row.familyHorizontalSpread || 0;
    maxBusLength = Math.max(maxBusLength, row.busLength || 0);
  }
  return {
    busExcessLength,
    maxBusExcessLength,
    foreignHouseholdsUnderBus,
    familyHorizontalSpread,
    maxBusLength,
    familyCount: (rows || []).length,
  };
}

export { unique };
