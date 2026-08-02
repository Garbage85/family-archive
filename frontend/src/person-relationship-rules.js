function personData(person) {
  if (person?.data && typeof person.data === 'object') return person.data;
  return person || {};
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const result = String(value).trim();
  return ['null', 'undefined'].includes(result.toLowerCase()) ? '' : result;
}

function normalisedGender(person) {
  const gender = cleanText(personData(person).gender).toLowerCase();
  if (['m', 'male'].includes(gender)) return 'M';
  if (['f', 'female'].includes(gender)) return 'F';
  return '';
}

export function getParentRoleLabel(parent) {
  const gender = normalisedGender(parent);
  if (gender === 'M') return 'Отец';
  if (gender === 'F') return 'Мать';
  return 'Родитель';
}

export function getSpouseRoleLabel(person) {
  const gender = normalisedGender(person);
  if (gender === 'M') return 'Супруг';
  if (gender === 'F') return 'Супруга';
  return 'Супруг(а)';
}

export function getSpouseSectionLabel(spouse, spouseCount) {
  if (spouseCount > 1) return 'Супруги';
  return getSpouseRoleLabel(spouse);
}

export function shouldShowMaidenName(person) {
  const data = personData(person);
  return normalisedGender(data) === 'F' && Boolean(cleanText(data.maiden_name));
}
