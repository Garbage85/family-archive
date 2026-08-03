import { computeAllKinships } from './kinship-engine.js';

export const CENTER_PERSON_STORAGE_KEY = 'familyArchive.centerPersonId';

function existingIds(people) {
  return new Set((Array.isArray(people) ? people : []).map((person) => String(person?.id ?? '')));
}

export function readStoredCenterPersonId(storage = globalThis.localStorage) {
  try {
    return String(storage?.getItem(CENTER_PERSON_STORAGE_KEY) || '');
  } catch {
    return '';
  }
}

export function persistCenterPersonId(personId, storage = globalThis.localStorage) {
  try {
    if (personId) storage?.setItem(CENTER_PERSON_STORAGE_KEY, String(personId));
    else storage?.removeItem(CENTER_PERSON_STORAGE_KEY);
  } catch {
    // A blocked localStorage must not make the tree unusable.
  }
}

/** Resolves saved ID, then current app selection, then the first person. */
export function resolveCenterPersonId(people, { savedCenterId = '', currentPersonId = '' } = {}) {
  const ids = existingIds(people);
  for (const candidate of [savedCenterId, currentPersonId]) {
    const id = String(candidate || '');
    if (id && ids.has(id)) return id;
  }
  const first = (Array.isArray(people) ? people : []).find(
    (person) => person?.id !== null && person?.id !== undefined,
  );
  return first ? String(first.id) : '';
}

export function ensureCenterPersonId(
  people,
  currentCenterId,
  { currentPersonId = '', storage = globalThis.localStorage } = {},
) {
  const centerId = resolveCenterPersonId(people, {
    savedCenterId: currentCenterId,
    currentPersonId,
  });
  persistCenterPersonId(centerId, storage);
  return centerId;
}

export function selectCenterPersonId(people, requestedPersonId, storage = globalThis.localStorage) {
  const id = String(requestedPersonId || '');
  if (!existingIds(people).has(id)) return '';
  persistCenterPersonId(id, storage);
  return id;
}

/** Memoizes derived relationships by people-array identity, revision and center. */
export class KinshipCalculator {
  constructor() {
    this.people = null;
    this.revision = null;
    this.centerId = null;
    this.result = null;
  }

  compute(people, centerId, revision = null) {
    if (
      this.result &&
      this.people === people &&
      this.revision === revision &&
      this.centerId === centerId
    ) {
      return this.result;
    }
    this.people = people;
    this.revision = revision;
    this.centerId = centerId;
    this.result = computeAllKinships({ people, centerId, maxAlternativePaths: 3 });
    return this.result;
  }

  invalidate() {
    this.people = null;
    this.revision = null;
    this.centerId = null;
    this.result = null;
  }
}
