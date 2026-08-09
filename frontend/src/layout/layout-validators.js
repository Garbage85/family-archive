/**
 * Geometric / topological validators for layout prototypes.
 */

function nodeMap(nodes) {
  return new Map((nodes || []).map((node) => [String(node.id), node]));
}

function cardRect(node) {
  const width = node.width ?? 184;
  const height = node.height ?? 170;
  return {
    id: node.id,
    left: node.x - width / 2,
    right: node.x + width / 2,
    top: node.y - height / 2,
    bottom: node.y + height / 2,
    width,
    height,
  };
}

function rectsOverlap(a, b, epsilon = 1e-6) {
  return !(
    a.right <= b.left + epsilon ||
    b.right <= a.left + epsilon ||
    a.bottom <= b.top + epsilon ||
    b.bottom <= a.top + epsilon
  );
}

function pointInRect(x, y, rect, epsilon = 1e-6) {
  return (
    x > rect.left + epsilon &&
    x < rect.right - epsilon &&
    y > rect.top + epsilon &&
    y < rect.bottom - epsilon
  );
}

function segmentsIntersect(p1, p2, p3, p4, epsilon = 1e-9) {
  const d = (p2[0] - p1[0]) * (p4[1] - p3[1]) - (p2[1] - p1[1]) * (p4[0] - p3[0]);
  if (Math.abs(d) < epsilon) return false;
  const t = ((p3[0] - p1[0]) * (p4[1] - p3[1]) - (p3[1] - p1[1]) * (p4[0] - p3[0])) / d;
  const u = ((p3[0] - p1[0]) * (p2[1] - p1[1]) - (p3[1] - p1[1]) * (p2[0] - p1[0])) / d;
  return t > epsilon && t < 1 - epsilon && u > epsilon && u < 1 - epsilon;
}

function segmentHitsRect(p1, p2, rect) {
  if (pointInRect(p1[0], p1[1], rect) || pointInRect(p2[0], p2[1], rect)) return true;
  const corners = [
    [rect.left, rect.top],
    [rect.right, rect.top],
    [rect.right, rect.bottom],
    [rect.left, rect.bottom],
  ];
  const edges = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  return edges.some(([a, b]) => segmentsIntersect(p1, p2, a, b));
}

export function findCardOverlaps(nodes) {
  const rects = (nodes || []).map(cardRect);
  const overlaps = [];
  for (let i = 0; i < rects.length; i += 1) {
    for (let j = i + 1; j < rects.length; j += 1) {
      if (rectsOverlap(rects[i], rects[j])) {
        overlaps.push([rects[i].id, rects[j].id]);
      }
    }
  }
  return overlaps;
}

export function assertSpousesNearby(layout, { maxDistanceFactor = 1.75 } = {}) {
  const byId = nodeMap(layout.nodes);
  const householdSizes = new Map();
  for (const node of layout.nodes || []) {
    if (!node.householdId) continue;
    householdSizes.set(node.householdId, (householdSizes.get(node.householdId) || 0) + 1);
  }
  const issues = [];
  for (const link of layout.links || []) {
    if (link.type !== 'spouse') continue;
    const left = byId.get(link.source);
    const right = byId.get(link.target);
    if (!left || !right) {
      issues.push(`missing spouse endpoint ${link.source}/${link.target}`);
      continue;
    }
    if (left.householdId && right.householdId && left.householdId !== right.householdId) {
      issues.push(`spouses ${left.id}/${right.id} not in the same household`);
    }
    const dx = left.x - right.x;
    const dy = left.y - right.y;
    const distance = Math.hypot(dx, dy);
    const householdSize = householdSizes.get(left.householdId) || 2;
    // Multiple spouses share one household row; allow span across the household.
    const card = Math.max(left.width ?? 184, right.width ?? 184, left.height ?? 170);
    const limit = maxDistanceFactor * card * Math.max(1, householdSize - 1);
    if (distance > limit) {
      issues.push(`spouses ${left.id}/${right.id} too far: ${distance.toFixed(1)}`);
    }
    if (left.generation !== right.generation) {
      issues.push(`spouses ${left.id}/${right.id} on different generations`);
    }
  }
  return issues;
}

export function assertParentChildGenerationOrder(layout) {
  const byId = nodeMap(layout.nodes);
  const issues = [];
  for (const link of layout.links || []) {
    if (link.type !== 'parent-child') continue;
    const parent = byId.get(link.source);
    const child = byId.get(link.target);
    if (!parent || !child) {
      issues.push(`missing parent/child endpoint ${link.source}/${link.target}`);
      continue;
    }
    if (!(parent.generation < child.generation)) {
      issues.push(
        `parent ${parent.id} generation ${parent.generation} not above child ${child.id} (${child.generation})`,
      );
    }
  }
  return issues;
}

export function findMissingRelationEndpoints(people, layout) {
  const visible = new Set((layout.nodes || []).map((node) => String(node.id)));
  const byId = new Map((people || []).map((person) => [String(person.id), person]));
  const missing = [];
  for (const id of visible) {
    const person = byId.get(id);
    if (!person) {
      missing.push(`layout node ${id} not in people`);
      continue;
    }
    for (const spouseId of person.rels?.spouses || []) {
      if (visible.has(String(spouseId))) continue;
      // Spouse exists in data but was not displayed — report only if both should be visible
      // (same generation household rule: spouses of visible people must be visible).
      missing.push(`visible ${id} missing spouse ${spouseId} in layout`);
    }
    for (const parentId of person.rels?.parents || []) {
      if (!byId.has(String(parentId))) missing.push(`${id} parent ${parentId} absent from people`);
    }
    for (const childId of person.rels?.children || []) {
      if (!byId.has(String(childId))) missing.push(`${id} child ${childId} absent from people`);
    }
  }
  return missing;
}

export function findLostVisiblePeople(expectedIds, layout) {
  const shown = new Set((layout.nodes || []).map((node) => String(node.id)));
  return [...expectedIds].filter((id) => !shown.has(String(id))).sort();
}

/**
 * Unique directed parent→child edges from topology (children[] + parents[]).
 */
export function collectTopologyParentChildEdges(people) {
  const edges = [];
  const seen = new Set();
  for (const person of people || []) {
    const parentId = String(person.id);
    for (const childId of person.rels?.children || []) {
      const key = `${parentId}->${childId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ parent: parentId, child: String(childId) });
    }
  }
  for (const person of people || []) {
    const childId = String(person.id);
    for (const parentId of person.rels?.parents || []) {
      const key = `${parentId}->${childId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ parent: String(parentId), child: childId });
    }
  }
  return edges.sort((left, right) =>
    `${left.parent}->${left.child}`.localeCompare(`${right.parent}->${right.child}`),
  );
}

/**
 * Per topology parent-child edge: visibility, should-show, drawn, reason if not drawn.
 * Rule: an edge must be drawn iff both endpoints are in the layout visible set.
 */
export function analyzeParentChildEdges(people, layout) {
  const visible = new Set((layout.nodes || []).map((node) => String(node.id)));
  const drawn = new Set(
    (layout.links || [])
      .filter((link) => link.type === 'parent-child')
      .map((link) => `${link.source}->${link.target}`),
  );
  return collectTopologyParentChildEdges(people).map((edge) => {
    const parentVisible = visible.has(edge.parent);
    const childVisible = visible.has(edge.child);
    const bothVisible = parentVisible && childVisible;
    const shouldShow = bothVisible;
    const shown = drawn.has(`${edge.parent}->${edge.child}`);
    let whyNot = null;
    if (shouldShow && !shown) {
      whyNot = 'MISSING_IN_LAYOUT';
    } else if (!bothVisible) {
      const parts = [];
      if (!parentVisible) parts.push(`parent ${edge.parent} not in visible set`);
      if (!childVisible) parts.push(`child ${edge.child} not in visible set`);
      whyNot = parts.join('; ');
    } else if (!shouldShow && shown) {
      whyNot = 'DRAWN_BUT_NOT_BOTH_VISIBLE';
    }
    return {
      parent: edge.parent,
      child: edge.child,
      parentVisible,
      childVisible,
      bothVisible,
      shouldShow,
      shown,
      whyNot,
    };
  });
}

export function findMissingVisibleParentChildLinks(people, layout) {
  return analyzeParentChildEdges(people, layout).filter((edge) => edge.shouldShow && !edge.shown);
}

export function findMissingVisibleSpouseLinks(people, layout) {
  const visible = new Set((layout.nodes || []).map((node) => String(node.id)));
  const drawn = new Set(
    (layout.links || [])
      .filter((link) => link.type === 'spouse')
      .map((link) => [link.source, link.target].map(String).sort().join('|')),
  );
  const missing = [];
  const seen = new Set();
  for (const person of people || []) {
    for (const spouseId of person.rels?.spouses || []) {
      const a = String(person.id);
      const b = String(spouseId);
      const key = [a, b].sort().join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      if (visible.has(a) && visible.has(b) && !drawn.has(key)) {
        missing.push({ a, b, key });
      }
    }
  }
  return missing;
}

export function findLinksThroughForeignCards(layout) {
  const rects = (layout.nodes || []).map(cardRect);
  const hits = [];
  for (const link of layout.links || []) {
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const p1 = points[i];
      const p2 = points[i + 1];
      for (const rect of rects) {
        if (rect.id === link.source || rect.id === link.target) continue;
        if (segmentHitsRect(p1, p2, rect)) {
          hits.push({
            link: `${link.type}:${link.source}->${link.target}`,
            through: rect.id,
          });
        }
      }
    }
  }
  return hits;
}

function linkFamilyKey(link) {
  if (link.familyKey) return String(link.familyKey);
  if (link.type === 'spouse') {
    return `spouse:${[link.source, link.target].map(String).sort().join('+')}`;
  }
  return `pc:${link.source}->${link.target}`;
}

function linkSegments(link) {
  const points = link.points || [];
  const segments = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (a[0] === b[0] && a[1] === b[1]) continue;
    segments.push({
      link,
      familyKey: linkFamilyKey(link),
      a,
      b,
      index: i,
    });
  }
  return segments;
}

function orientSegment(segment) {
  const horizontal = Math.abs(segment.a[1] - segment.b[1]) < 1e-6;
  const vertical = Math.abs(segment.a[0] - segment.b[0]) < 1e-6;
  if (horizontal) {
    return {
      kind: 'h',
      y: segment.a[1],
      min: Math.min(segment.a[0], segment.b[0]),
      max: Math.max(segment.a[0], segment.b[0]),
    };
  }
  if (vertical) {
    return {
      kind: 'v',
      x: segment.a[0],
      min: Math.min(segment.a[1], segment.b[1]),
      max: Math.max(segment.a[1], segment.b[1]),
    };
  }
  return { kind: 'diag' };
}

function rangesOverlap(aMin, aMax, bMin, bMax, epsilon = 1e-6) {
  return aMin <= bMax - epsilon && bMin <= aMax - epsilon;
}

function sameFamily(a, b) {
  return a.familyKey && b.familyKey && a.familyKey === b.familyKey;
}

/** Collinear overlapping segments from unrelated family links (ambiguous shared trunk). */
export function findOverlappingCollinearUnrelatedSegments(layout) {
  const segments = (layout.links || []).flatMap(linkSegments);
  const hits = [];
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const left = segments[i];
      const right = segments[j];
      if (sameFamily(left, right)) continue;
      const a = orientSegment(left);
      const b = orientSegment(right);
      if (a.kind === 'h' && b.kind === 'h' && Math.abs(a.y - b.y) < 1e-6) {
        if (rangesOverlap(a.min, a.max, b.min, b.max)) {
          hits.push({
            kind: 'horizontal',
            y: a.y,
            a: `${left.link.type}:${left.link.source}->${left.link.target}`,
            b: `${right.link.type}:${right.link.source}->${right.link.target}`,
          });
        }
      }
      if (a.kind === 'v' && b.kind === 'v' && Math.abs(a.x - b.x) < 1e-6) {
        if (rangesOverlap(a.min, a.max, b.min, b.max)) {
          hits.push({
            kind: 'vertical',
            x: a.x,
            a: `${left.link.type}:${left.link.source}->${left.link.target}`,
            b: `${right.link.type}:${right.link.source}->${right.link.target}`,
          });
        }
      }
    }
  }
  return hits;
}

/** Ambiguous shared lanes = overlapping collinear unrelated parent-child segments. */
export function findAmbiguousSharedLanes(layout) {
  return findOverlappingCollinearUnrelatedSegments(layout).filter((hit) => {
    const leftType = String(hit.a).split(':')[0];
    const rightType = String(hit.b).split(':')[0];
    return leftType === 'parent-child' && rightType === 'parent-child';
  });
}

/** Proper crossings between unrelated link polylines (not endpoint-touching). */
export function findUnrelatedLinkIntersections(layout) {
  const segments = (layout.links || []).flatMap(linkSegments);
  const hits = [];
  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const left = segments[i];
      const right = segments[j];
      if (sameFamily(left, right)) continue;
      if (!segmentsIntersect(left.a, left.b, right.a, right.b)) continue;
      hits.push({
        a: `${left.link.type}:${left.link.source}->${left.link.target}`,
        b: `${right.link.type}:${right.link.source}->${right.link.target}`,
        familyA: left.familyKey,
        familyB: right.familyKey,
      });
    }
  }
  return hits;
}

function pointXY(point) {
  if (Array.isArray(point)) return { x: point[0], y: point[1] };
  return { x: point.x, y: point.y };
}

export function findZeroLengthSegments(layout) {
  const hits = [];
  for (const link of layout.links || []) {
    const points = link.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = pointXY(points[i]);
      const b = pointXY(points[i + 1]);
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
        hits.push(`${link.type}:${link.source}->${link.target}#${i}`);
      }
    }
  }
  return hits;
}

function orientRaw(ax, ay, bx, by, cx, cy) {
  const value = (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
  if (Math.abs(value) < 1e-9) return 0;
  return value > 0 ? 1 : 2;
}

function segmentsCrossProperXY(a1, a2, b1, b2) {
  const o1 = orientRaw(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y);
  const o2 = orientRaw(a1.x, a1.y, a2.x, a2.y, b2.x, b2.y);
  const o3 = orientRaw(b1.x, b1.y, b2.x, b2.y, a1.x, a1.y);
  const o4 = orientRaw(b1.x, b1.y, b2.x, b2.y, a2.x, a2.y);
  return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0;
}

export function findSelfIntersectingPolylines(layout) {
  const hits = [];
  for (const link of layout.links || []) {
    const points = (link.points || []).map(pointXY);
    const segs = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) continue;
      segs.push({ a, b, index: i });
    }
    let selfHit = false;
    for (let i = 0; i < segs.length && !selfHit; i += 1) {
      for (let j = i + 1; j < segs.length; j += 1) {
        if (j === i + 1) continue;
        if (i === 0 && j === segs.length - 1) continue;
        if (segmentsCrossProperXY(segs[i].a, segs[i].b, segs[j].a, segs[j].b)) {
          selfHit = true;
          break;
        }
      }
    }
    if (selfHit) hits.push(`${link.type}:${link.source}->${link.target}`);
  }
  return hits;
}

/** Stable signature of all link polylines for deterministic routing checks. */
export function layoutRouteSignature(layout) {
  return (layout.links || [])
    .map((link) => {
      const pts = (link.points || [])
        .map((point) => {
          const { x, y } = pointXY(point);
          return `${Math.round(x * 1000) / 1000},${Math.round(y * 1000) / 1000}`;
        })
        .join(';');
      return `${link.type}|${link.source}->${link.target}|${link.familyKey || ''}|${pts}`;
    })
    .sort()
    .join('\n');
}

export function boundingBox(nodes) {
  if (!nodes?.length) return { width: 0, height: 0, minX: 0, maxX: 0, minY: 0, maxY: 0 };
  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}

export function summarizeLayout(people, layout) {
  const overlaps = findCardOverlaps(layout.nodes);
  const spouseIssues = assertSpousesNearby(layout);
  const generationIssues = assertParentChildGenerationOrder(layout);
  const missingEndpoints = findMissingRelationEndpoints(people, layout);
  const missingVisibleParentChild = findMissingVisibleParentChildLinks(people, layout);
  const missingVisibleSpouse = findMissingVisibleSpouseLinks(people, layout);
  const lineHits = findLinksThroughForeignCards(layout);
  const collinearUnrelated = findOverlappingCollinearUnrelatedSegments(layout);
  const ambiguousLanes = findAmbiguousSharedLanes(layout);
  const unrelatedCrossings = findUnrelatedLinkIntersections(layout);
  const zeroLength = findZeroLengthSegments(layout);
  const selfIntersections = findSelfIntersectingPolylines(layout);
  const spouseLinks = (layout.links || []).filter((link) => link.type === 'spouse').length;
  const parentLinks = (layout.links || []).filter((link) => link.type === 'parent-child').length;
  return {
    inputCount: people.length,
    displayedCount: layout.nodes?.length || 0,
    spouseLinks,
    parentChildLinks: parentLinks,
    overlaps: overlaps.length,
    overlapPairs: overlaps,
    lostNodes: 0,
    missingVisibleParentChildLinks: missingVisibleParentChild.length,
    missingVisibleParentChildDetails: missingVisibleParentChild,
    missingVisibleSpouseLinks: missingVisibleSpouse.length,
    missingVisibleSpouseDetails: missingVisibleSpouse,
    missingEndpoints: missingEndpoints.length,
    missingEndpointDetails: missingEndpoints,
    spousePlacementIssues: spouseIssues.length,
    generationIssues: generationIssues.length,
    linksThroughCards: lineHits.length,
    overlappingCollinearUnrelated: collinearUnrelated.length,
    ambiguousSharedLanes: ambiguousLanes.length,
    unrelatedLinkIntersections: unrelatedCrossings.length,
    zeroLengthSegments: zeroLength.length,
    selfIntersectingPolylines: selfIntersections.length,
    routeSignature: layoutRouteSignature(layout),
    boundingBox: boundingBox(layout.nodes),
  };
}
