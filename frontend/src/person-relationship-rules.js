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

export function getSpouseSectionLabel(selectedPerson, spouseCount) {
  const gender = normalisedGender(selectedPerson);
  if (spouseCount > 1) {
    return gender === 'M' ? 'Супруги' : 'Супруги и партнёры';
  }
  if (gender === 'M') return 'Супруга';
  if (gender === 'F') return 'Супруг';
  return 'Супруг(а)';
}

export function shouldShowMaidenName(person) {
  const data = personData(person);
  return normalisedGender(data) === 'F' && Boolean(cleanText(data.maiden_name));
}

export function getInitialMaidenName(person) {
  const data = personData(person);
  return cleanText(data.maiden_name) || cleanText(data.last_name);
}
