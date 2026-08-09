/**
 * Read-only helpers for anonymized structural tree fixtures.
 * Never writes trees.data / PocketBase. Strips all PII fields.
 */

const PII_DATA_KEYS = [
  'first_name',
  'last_name',
  'middle_name',
  'maiden_name',
  'birth_date',
  'death_date',
  'birth_place',
  'occupation',
  'notes',
  'avatar',
];

function uniqueSorted(ids) {
  return [...new Set((ids || []).map(String).filter(Boolean))].sort();
}

/**
 * Convert a trees.data people array into a structural fixture with synthetic ids.
 * Topology (parents/children/spouses) is preserved exactly; PII is dropped.
 */
export function anonymizeTreeTopology(people, { idPrefix = 'p' } = {}) {
  const list = Array.isArray(people) ? people : [];
  const originalIds = list.map((person, index) => String(person?.id || `missing-${index}`));
  const sortedOriginal = [...originalIds].sort((left, right) => left.localeCompare(right));
  const idMap = new Map();
  sortedOriginal.forEach((id, index) => {
    idMap.set(id, `${idPrefix}${String(index + 1).padStart(3, '0')}`);
  });

  const byOriginal = new Map(list.map((person, index) => [originalIds[index], person]));
  const peopleOut = sortedOriginal.map((originalId) => {
    const person = byOriginal.get(originalId) || {};
    const gender = String(person?.data?.gender || '').toUpperCase();
    const rels = person?.rels || {};
    return {
      id: idMap.get(originalId),
      data: {
        gender: gender === 'M' || gender === 'F' ? gender : '',
      },
      rels: {
        parents: uniqueSorted(
          (rels.parents || []).map((id) => idMap.get(String(id))).filter(Boolean),
        ),
        spouses: uniqueSorted(
          (rels.spouses || []).map((id) => idMap.get(String(id))).filter(Boolean),
        ),
        children: uniqueSorted(
          (rels.children || []).map((id) => idMap.get(String(id))).filter(Boolean),
        ),
      },
    };
  });

  const generationHints = estimateGenerations(peopleOut);
  return {
    version: 1,
    kind: 'structural-topology',
    personCount: peopleOut.length,
    idPrefix,
    people: peopleOut,
    meta: {
      strippedFields: PII_DATA_KEYS,
      spouseEdgeCount: countUndirectedEdges(peopleOut, 'spouses'),
      parentChildEdgeCount: countDirectedEdges(peopleOut, 'parents'),
      generationHints,
      defaultCenterId: pickDefaultCenter(peopleOut, generationHints),
    },
  };
}

function countUndirectedEdges(people, field) {
  const seen = new Set();
  for (const person of people) {
    for (const other of person.rels[field] || []) {
      const key = [person.id, other].sort().join('|');
      seen.add(key);
    }
  }
  return seen.size;
}

function countDirectedEdges(people, field) {
  let count = 0;
  for (const person of people) count += (person.rels[field] || []).length;
  return count;
}

function estimateGenerations(people) {
  const byId = new Map(people.map((person) => [person.id, person]));
  const gen = new Map();
  const roots = people.filter((person) => !(person.rels.parents || []).length);
  const queue = roots.map((person) => person.id);
  for (const id of queue) gen.set(id, 0);
  while (queue.length) {
    const id = queue.shift();
    const person = byId.get(id);
    const g = gen.get(id) ?? 0;
    for (const childId of person?.rels.children || []) {
      if (!gen.has(childId)) {
        gen.set(childId, g + 1);
        queue.push(childId);
      }
    }
  }
  for (const person of people) {
    if (!gen.has(person.id)) gen.set(person.id, 0);
    for (const spouseId of person.rels.spouses || []) {
      if (!gen.has(spouseId)) gen.set(spouseId, gen.get(person.id));
    }
  }
  return Object.fromEntries(
    [...gen.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
}

function pickDefaultCenter(people, generationHints) {
  if (!people.length) return null;
  const values = Object.values(generationHints);
  const mid = values.length ? Math.round((Math.min(...values) + Math.max(...values)) / 2) : 0;
  const candidates = people.filter((person) => generationHints[person.id] === mid);
  const pool = candidates.length ? candidates : people;
  return [...pool].sort((left, right) => left.id.localeCompare(right.id))[0].id;
}

export function assertNoPiiInFixture(fixture) {
  for (const person of fixture.people || []) {
    const dataKeys = Object.keys(person.data || {});
    for (const key of PII_DATA_KEYS) {
      if (dataKeys.includes(key)) {
        throw new Error(`PII field "${key}" must not appear on person ${person.id}`);
      }
    }
    const blob = JSON.stringify(person);
    if (/[А-Яа-яЁё]{3,}/.test(blob)) {
      throw new Error(`Cyrillic text must not appear in structural fixture (person ${person.id})`);
    }
  }
}

export function loadStructuralPeople(fixture) {
  return structuredClone(fixture.people || []);
}
