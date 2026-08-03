import {
  formatAffinalDescription,
  formatKinshipLabel,
  formatKinshipShortLabel,
} from './kinship-formatter-ru.js';

const RELATION_KEYS = ['parents', 'children', 'spouses'];
const DEFAULT_MAX_ALTERNATIVE_PATHS = 3;
const MAX_ROUTES_PER_ANCESTOR = 4;

/**
 * @typedef {'self'|'blood'|'spouse'|'affinal'|'adoptive'|'guardian'|'unrelated'} KinshipKind
 * @typedef {'parent'|'child'|'spouse'} KinshipEdgeType
 * @typedef {{fromId: string, toId: string, type: KinshipEdgeType}} KinshipStep
 * @typedef {{personIds: string[], steps: KinshipStep[], commonAncestorId: string|null}} KinshipPath
 * @typedef {object} KinshipResult
 * @property {string} centerId
 * @property {string} targetId
 * @property {KinshipKind} kind
 * @property {string} label
 * @property {string} shortLabel
 * @property {string} description Plain-language explanation for an affinal term.
 * @property {'M'|'F'|''} gender
 * @property {number|null} degree Cousin degree, or direct generation distance.
 * @property {number|null} generationDelta Positive means the target is in an older generation.
 * @property {number|null} distanceFromCenter Generations from center to the common ancestor.
 * @property {number|null} distanceFromTarget Generations from target to the common ancestor.
 * @property {string[]} commonAncestorIds
 * @property {KinshipPath|null} primaryPath
 * @property {KinshipPath[]} alternativePaths
 * @property {{kind: 'spouse', label: string}[]} additionalRelations
 * @property {string[]} warnings
 */

function normaliseGender(value) {
  const gender = String(value || '').toUpperCase();
  return gender === 'M' || gender === 'F' ? gender : '';
}

function relationIds(person, key) {
  return Array.isArray(person?.rels?.[key]) ? person.rels[key] : [];
}

function add(setMap, fromId, toId) {
  setMap.get(fromId)?.add(toId);
}

function detectParentCycles(parents) {
  const indegree = new Map([...parents.keys()].map((id) => [id, 0]));
  const children = new Map([...parents.keys()].map((id) => [id, []]));
  for (const [childId, parentIds] of parents) {
    for (const parentId of parentIds) {
      indegree.set(childId, (indegree.get(childId) || 0) + 1);
      children.get(parentId)?.push(childId);
    }
  }
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    visited += 1;
    for (const childId of children.get(id) || []) {
      const next = indegree.get(childId) - 1;
      indegree.set(childId, next);
      if (next === 0) queue.push(childId);
    }
  }
  return visited !== parents.size;
}

/**
 * Builds a normalized, immutable-by-convention in-memory graph. Relations are
 * made reciprocal in the index, while the source people array is never changed.
 *
 * @param {Array<object>} people
 * @returns {{peopleById: Map<string, object>, parents: Map<string, Set<string>>, children: Map<string, Set<string>>, spouses: Map<string, Set<string>>, warnings: string[], ancestorCache: Map<string, Map>}}
 */
export function buildKinshipIndex(people) {
  const peopleById = new Map();
  const warnings = new Set();
  for (const person of Array.isArray(people) ? people : []) {
    if (person?.id === null || person?.id === undefined || String(person.id) === '') {
      warnings.add('Пропущена запись человека без ID.');
      continue;
    }
    const id = String(person.id);
    if (peopleById.has(id)) {
      warnings.add(`Повторяющийся ID человека проигнорирован: ${id}.`);
      continue;
    }
    peopleById.set(id, person);
  }

  const parents = new Map([...peopleById.keys()].map((id) => [id, new Set()]));
  const children = new Map([...peopleById.keys()].map((id) => [id, new Set()]));
  const spouses = new Map([...peopleById.keys()].map((id) => [id, new Set()]));

  const link = (fromId, rawToId, kind) => {
    const toId = String(rawToId);
    if (!peopleById.has(toId)) {
      warnings.add(`Связь ${kind} от ${fromId} ведёт к отсутствующему человеку ${toId}.`);
      return;
    }
    if (toId === fromId) {
      warnings.add(`Самоссылка ${kind} у человека ${fromId} проигнорирована.`);
      return;
    }
    if (kind === 'parents') {
      add(parents, fromId, toId);
      add(children, toId, fromId);
    } else if (kind === 'children') {
      add(children, fromId, toId);
      add(parents, toId, fromId);
    } else {
      add(spouses, fromId, toId);
      add(spouses, toId, fromId);
    }
  };

  for (const [id, person] of peopleById) {
    for (const key of RELATION_KEYS) {
      for (const relatedId of relationIds(person, key)) link(id, relatedId, key);
    }
  }
  if (detectParentCycles(parents)) warnings.add('В связях родителей обнаружен цикл.');

  return {
    peopleById,
    parents,
    children,
    spouses,
    warnings: [...warnings],
    ancestorCache: new Map(),
  };
}

function getAncestorRoutes(index, startId) {
  if (index.ancestorCache.has(startId)) return index.ancestorCache.get(startId);
  const routes = new Map();
  const queue = [{ id: startId, path: [startId] }];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { id, path } = queue[cursor];
    for (const parentId of [...(index.parents.get(id) || [])].sort()) {
      if (path.includes(parentId)) continue;
      const nextPath = [...path, parentId];
      const distance = nextPath.length - 1;
      const current = routes.get(parentId);
      if (!current) {
        routes.set(parentId, { distance, paths: [nextPath] });
        queue.push({ id: parentId, path: nextPath });
      } else if (
        current.distance === distance &&
        current.paths.length < MAX_ROUTES_PER_ANCESTOR &&
        !current.paths.some((candidate) => candidate.join('\u0000') === nextPath.join('\u0000'))
      ) {
        current.paths.push(nextPath);
        queue.push({ id: parentId, path: nextPath });
      }
    }
  }
  index.ancestorCache.set(startId, routes);
  return routes;
}

function stepsFor(personIds, upCount) {
  return personIds.slice(1).map((toId, index) => ({
    fromId: personIds[index],
    toId,
    type: index < upCount ? 'parent' : 'child',
  }));
}

function bloodPath(centerRoute, targetRoute, commonAncestorId) {
  const downward = [...targetRoute].reverse();
  const personIds = [...centerRoute, ...downward.slice(1)];
  return {
    personIds,
    steps: stepsFor(personIds, centerRoute.length - 1),
    commonAncestorId,
  };
}

function spousePath(centerId, targetId) {
  return {
    personIds: [centerId, targetId],
    steps: [{ fromId: centerId, toId: targetId, type: 'spouse' }],
    commonAncestorId: null,
  };
}

function resultBase(index, centerId, targetId, kind, warnings = []) {
  const gender = normaliseGender(index.peopleById.get(targetId)?.data?.gender);
  return {
    centerId,
    targetId,
    kind,
    label: '',
    shortLabel: '',
    description: '',
    gender,
    degree: null,
    generationDelta: null,
    distanceFromCenter: null,
    distanceFromTarget: null,
    commonAncestorIds: [],
    primaryPath: null,
    alternativePaths: [],
    additionalRelations: [],
    warnings: [...new Set([...index.warnings, ...warnings])],
  };
}

function applyLabels(result, descriptor) {
  result.label = formatKinshipLabel(descriptor);
  result.shortLabel = formatKinshipShortLabel(descriptor);
  result.description =
    descriptor.kind === 'affinal' ? formatAffinalDescription(descriptor.relationType) : '';
  return result;
}

function sortedIds(values) {
  return [...(values || [])].sort((left, right) => left.localeCompare(right));
}

function uniquePath(personIds, types) {
  if (new Set(personIds).size !== personIds.length) return null;
  return {
    personIds,
    steps: types.map((type, index) => ({
      fromId: personIds[index],
      toId: personIds[index + 1],
      type,
    })),
    commonAncestorId: null,
  };
}

function affinalCandidate(index, centerId, targetId) {
  const centerGender = normaliseGender(index.peopleById.get(centerId)?.data?.gender);
  const targetGender = normaliseGender(index.peopleById.get(targetId)?.data?.gender);

  for (const spouseId of sortedIds(index.spouses.get(centerId))) {
    if (!index.parents.get(spouseId)?.has(targetId)) continue;
    const spouseGender = normaliseGender(index.peopleById.get(spouseId)?.data?.gender);
    let relationType = '';
    if (centerGender === 'F' && spouseGender === 'M') {
      relationType =
        targetGender === 'M'
          ? 'father_of_husband'
          : targetGender === 'F'
            ? 'mother_of_husband'
            : '';
    } else if (centerGender === 'M' && spouseGender === 'F') {
      relationType =
        targetGender === 'M' ? 'father_of_wife' : targetGender === 'F' ? 'mother_of_wife' : '';
    }
    const path = uniquePath([centerId, spouseId, targetId], ['spouse', 'parent']);
    if (relationType && path) return { relationType, path };
  }

  for (const childId of sortedIds(index.children.get(centerId))) {
    if (!index.spouses.get(childId)?.has(targetId)) continue;
    const childGender = normaliseGender(index.peopleById.get(childId)?.data?.gender);
    const relationType =
      targetGender === 'M'
        ? childGender === 'M'
          ? 'husband_of_son'
          : 'husband_of_daughter'
        : targetGender === 'F'
          ? childGender === 'F'
            ? 'wife_of_daughter'
            : 'wife_of_son'
          : '';
    const path = uniquePath([centerId, childId, targetId], ['child', 'spouse']);
    if (relationType && path) return { relationType, path };
  }

  for (const parentId of sortedIds(index.parents.get(centerId))) {
    if (index.parents.get(centerId)?.has(targetId) || !index.spouses.get(parentId)?.has(targetId)) {
      continue;
    }
    const parentGender = normaliseGender(index.peopleById.get(parentId)?.data?.gender);
    const relationType =
      parentGender === 'F' && targetGender === 'M'
        ? 'stepfather'
        : parentGender === 'M' && targetGender === 'F'
          ? 'stepmother'
          : '';
    const path = uniquePath([centerId, parentId, targetId], ['parent', 'spouse']);
    if (relationType && path) return { relationType, path };
  }

  for (const parentId of sortedIds(index.parents.get(centerId))) {
    for (const siblingId of sortedIds(index.children.get(parentId))) {
      if (siblingId === centerId || !index.spouses.get(siblingId)?.has(targetId)) continue;
      const siblingGender = normaliseGender(index.peopleById.get(siblingId)?.data?.gender);
      const relationType =
        siblingGender === 'F' && targetGender === 'M'
          ? 'husband_of_sister'
          : siblingGender === 'M' && targetGender === 'F'
            ? 'wife_of_brother'
            : '';
      const path = uniquePath(
        [centerId, parentId, siblingId, targetId],
        ['parent', 'child', 'spouse'],
      );
      if (relationType && path) return { relationType, path };
    }
  }
  return null;
}

function affinalResult(index, centerId, targetId) {
  const candidate = affinalCandidate(index, centerId, targetId);
  if (!candidate) return null;
  const result = resultBase(index, centerId, targetId, 'affinal');
  result.degree = candidate.path.steps.length;
  result.distanceFromCenter = candidate.path.steps.length;
  result.primaryPath = candidate.path;
  return applyLabels(result, {
    kind: 'affinal',
    relationType: candidate.relationType,
    gender: result.gender,
  });
}

function addSpouseSupplement(index, result) {
  if (!index.spouses.get(result.centerId)?.has(result.targetId)) return result;
  const descriptor = { kind: 'spouse', gender: result.gender };
  result.additionalRelations.push({ kind: 'spouse', label: formatKinshipLabel(descriptor) });
  return result;
}

function directAncestorResult(index, centerId, targetId, info, maxAlternatives) {
  const result = resultBase(index, centerId, targetId, 'blood');
  const paths = info.paths.map((route) => bloodPath(route, [targetId], targetId));
  result.degree = info.distance;
  result.generationDelta = info.distance;
  result.distanceFromCenter = info.distance;
  result.distanceFromTarget = 0;
  result.commonAncestorIds = [targetId];
  result.primaryPath = paths[0];
  result.alternativePaths = paths.slice(1, maxAlternatives + 1);
  applyLabels(result, {
    kind: 'blood',
    relationType: 'ancestor',
    gender: result.gender,
    a: info.distance,
    b: 0,
  });
  return addSpouseSupplement(index, result);
}

function directDescendantResult(index, centerId, targetId, info, maxAlternatives) {
  const result = resultBase(index, centerId, targetId, 'blood');
  const paths = info.paths.map((route) => bloodPath([centerId], route, centerId));
  result.degree = info.distance;
  result.generationDelta = -info.distance;
  result.distanceFromCenter = 0;
  result.distanceFromTarget = info.distance;
  result.commonAncestorIds = [centerId];
  result.primaryPath = paths[0];
  result.alternativePaths = paths.slice(1, maxAlternatives + 1);
  applyLabels(result, {
    kind: 'blood',
    relationType: 'descendant',
    gender: result.gender,
    a: 0,
    b: info.distance,
  });
  return addSpouseSupplement(index, result);
}

function lateralCandidates(centerAncestors, targetAncestors) {
  const candidates = new Map();
  for (const [ancestorId, centerInfo] of centerAncestors) {
    const targetInfo = targetAncestors.get(ancestorId);
    if (!targetInfo) continue;
    for (const centerRoute of centerInfo.paths) {
      for (const targetRoute of targetInfo.paths) {
        const sharedRouteIds = centerRoute.filter((id) => targetRoute.includes(id));
        if (sharedRouteIds.length !== 1 || sharedRouteIds[0] !== ancestorId) continue;
        const a = centerInfo.distance;
        const b = targetInfo.distance;
        const semanticKey = [
          a,
          b,
          centerRoute.slice(0, -1).join('>'),
          targetRoute.slice(0, -1).join('>'),
        ].join('|');
        const current = candidates.get(semanticKey);
        if (current) {
          current.commonAncestorIds.add(ancestorId);
          continue;
        }
        candidates.set(semanticKey, {
          a,
          b,
          ancestorId,
          commonAncestorIds: new Set([ancestorId]),
          path: bloodPath(centerRoute, targetRoute, ancestorId),
        });
      }
    }
  }
  return [...candidates.values()].sort(
    (left, right) =>
      left.a + left.b - (right.a + right.b) ||
      Math.abs(left.a - left.b) - Math.abs(right.a - right.b) ||
      left.ancestorId.localeCompare(right.ancestorId) ||
      left.path.personIds.join('\u0000').localeCompare(right.path.personIds.join('\u0000')),
  );
}

/**
 * Computes the relationship of target to center. Only direct spouse links are
 * interpreted; spouse edges never participate in blood-path traversal.
 *
 * @param {{index: ReturnType<typeof buildKinshipIndex>, centerId: string, targetId: string, maxAlternativePaths?: number}} options
 * @returns {KinshipResult}
 */
export function computeKinship({
  index,
  centerId: rawCenterId,
  targetId: rawTargetId,
  maxAlternativePaths = DEFAULT_MAX_ALTERNATIVE_PATHS,
}) {
  const centerId = String(rawCenterId ?? '');
  const targetId = String(rawTargetId ?? '');
  const maxAlternatives = Math.max(0, Math.min(3, Number(maxAlternativePaths) || 0));
  if (!index?.peopleById?.has(centerId) || !index.peopleById.has(targetId)) {
    const result = resultBase(
      index || { peopleById: new Map(), warnings: [] },
      centerId,
      targetId,
      'unrelated',
      [
        !index?.peopleById?.has(centerId)
          ? `Центральный человек ${centerId || '(пусто)'} не найден.`
          : '',
        !index?.peopleById?.has(targetId)
          ? `Целевой человек ${targetId || '(пусто)'} не найден.`
          : '',
      ].filter(Boolean),
    );
    return applyLabels(result, { kind: 'unrelated', gender: result.gender });
  }
  if (centerId === targetId) {
    const result = resultBase(index, centerId, targetId, 'self');
    result.degree = 0;
    result.generationDelta = 0;
    result.distanceFromCenter = 0;
    result.distanceFromTarget = 0;
    result.primaryPath = { personIds: [centerId], steps: [], commonAncestorId: centerId };
    return applyLabels(result, { kind: 'self', gender: result.gender });
  }

  const centerAncestors = getAncestorRoutes(index, centerId);
  const directAncestor = centerAncestors.get(targetId);
  if (directAncestor) {
    return directAncestorResult(index, centerId, targetId, directAncestor, maxAlternatives);
  }
  const targetAncestors = getAncestorRoutes(index, targetId);
  const directDescendant = targetAncestors.get(centerId);
  if (directDescendant) {
    return directDescendantResult(index, centerId, targetId, directDescendant, maxAlternatives);
  }

  const candidates = lateralCandidates(centerAncestors, targetAncestors);
  if (candidates.length) {
    const primary = candidates[0];
    const result = resultBase(index, centerId, targetId, 'blood');
    result.degree =
      primary.a === primary.b ? primary.a : primary.a - primary.b > 0 ? primary.a - 1 : primary.a;
    result.generationDelta = primary.a - primary.b;
    result.distanceFromCenter = primary.a;
    result.distanceFromTarget = primary.b;
    result.commonAncestorIds = [...primary.commonAncestorIds].sort();
    result.primaryPath = primary.path;
    result.alternativePaths = candidates.slice(1, maxAlternatives + 1).map((item) => item.path);
    applyLabels(result, {
      kind: 'blood',
      relationType: 'lateral',
      gender: result.gender,
      a: primary.a,
      b: primary.b,
    });
    return addSpouseSupplement(index, result);
  }

  if (index.spouses.get(centerId)?.has(targetId)) {
    const result = resultBase(index, centerId, targetId, 'spouse');
    result.degree = 1;
    result.generationDelta = 0;
    result.distanceFromCenter = 1;
    result.distanceFromTarget = 0;
    result.primaryPath = spousePath(centerId, targetId);
    return applyLabels(result, { kind: 'spouse', gender: result.gender });
  }

  const affinal = affinalResult(index, centerId, targetId);
  if (affinal) return affinal;

  const result = resultBase(index, centerId, targetId, 'unrelated');
  return applyLabels(result, { kind: 'unrelated', gender: result.gender });
}

/**
 * Computes all labels using one normalized index and memoized ancestor maps.
 * The returned Map is keyed by string person ID and is safe to keep outside
 * trees.data as derived UI state.
 *
 * @param {{people: Array<object>, centerId: string, maxAlternativePaths?: number}} options
 * @returns {{index: ReturnType<typeof buildKinshipIndex>, kinships: Map<string, KinshipResult>}}
 */
export function computeAllKinships({
  people,
  centerId,
  maxAlternativePaths = DEFAULT_MAX_ALTERNATIVE_PATHS,
}) {
  const index = buildKinshipIndex(people);
  const kinships = new Map();
  for (const id of index.peopleById.keys()) {
    kinships.set(id, computeKinship({ index, centerId, targetId: id, maxAlternativePaths }));
  }
  return { index, kinships };
}
