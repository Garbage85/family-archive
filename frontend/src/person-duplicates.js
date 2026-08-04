import { formatPersonName } from './person-card-formatters.js';

function normaliseText(value) {
  return String(value || '')
    .trim()
    .toLocaleLowerCase('ru-RU')
    .replace(/\s+/g, ' ');
}

function surnameParts(data = {}) {
  return new Set([data.last_name, data.maiden_name].map(normaliseText).filter(Boolean));
}

function sharesSurname(left, right) {
  const leftParts = surnameParts(left);
  return [...surnameParts(right)].some((value) => leftParts.has(value));
}

function hasRelationshipContext(person, relationshipPersonIds) {
  const contextIds = new Set((relationshipPersonIds || []).map(String));
  return ['parents', 'spouses', 'children'].some((relation) =>
    (person?.rels?.[relation] || []).some((id) => contextIds.has(String(id))),
  );
}

export function findPotentialPersonDuplicates(
  people,
  values,
  { excludeIds = [], relationshipPersonIds = [] } = {},
) {
  const firstName = normaliseText(values?.first_name);
  if (!firstName) return [];

  const excluded = new Set(excludeIds.map(String));
  const wantedBirthDate = normaliseText(values?.birth_date);
  const wantedMiddleName = normaliseText(values?.middle_name);
  const wantedDeathDate = normaliseText(values?.death_date);
  const wantedBirthPlace = normaliseText(values?.birth_place);

  return (Array.isArray(people) ? people : [])
    .filter((person) => !excluded.has(String(person?.id)))
    .map((person) => {
      const data = person?.data || {};
      if (normaliseText(data.first_name) !== firstName) return null;

      const reasons = ['совпадает имя'];
      let score = 3;
      const sameSurname = sharesSurname(data, values);
      const sameBirthDate =
        Boolean(wantedBirthDate) && normaliseText(data.birth_date) === wantedBirthDate;

      if (sameSurname) {
        score += 3;
        reasons.push('фамилия');
      }
      if (wantedMiddleName && normaliseText(data.middle_name) === wantedMiddleName) {
        score += 2;
        reasons.push('отчество');
      }
      if (sameBirthDate) {
        score += 4;
        reasons.push('дата рождения');
      }
      if (wantedDeathDate && normaliseText(data.death_date) === wantedDeathDate) {
        score += 2;
        reasons.push('дата смерти');
      }
      if (wantedBirthPlace && normaliseText(data.birth_place) === wantedBirthPlace) {
        score += 1;
        reasons.push('место рождения');
      }
      if (hasRelationshipContext(person, relationshipPersonIds)) {
        score += 1;
        reasons.push('существующие связи');
      }

      if (!sameSurname && !sameBirthDate) return null;
      return {
        id: String(person.id),
        name: formatPersonName(person),
        birthDate: String(data.birth_date || ''),
        reasons,
        score,
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name, 'ru'));
}
