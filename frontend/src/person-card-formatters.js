export function cleanNamePart(value) {
  if (value === null || value === undefined) return '';

  const result = String(value).trim().replace(/\s+/g, ' ');
  return ['null', 'undefined'].includes(result.toLowerCase()) ? '' : result;
}

function personData(person) {
  return person?.data && typeof person.data === 'object' ? person.data : person || {};
}

function normalisedGender(value) {
  const gender = cleanNamePart(value).toUpperCase();
  return ['M', 'MALE'].includes(gender) ? 'M' : ['F', 'FEMALE'].includes(gender) ? 'F' : '';
}

function sameSurname(left, right) {
  return (
    cleanNamePart(left).toLocaleLowerCase('ru-RU') ===
    cleanNamePart(right).toLocaleLowerCase('ru-RU')
  );
}

export function formatPersonSurname(person) {
  const data = personData(person);
  const lastName = cleanNamePart(data.last_name);
  const maidenName = cleanNamePart(data.maiden_name);
  if (normalisedGender(data.gender) !== 'F') return lastName;
  if (lastName && maidenName && !sameSurname(lastName, maidenName)) {
    return `${lastName} (${maidenName})`;
  }
  return lastName || maidenName;
}

export function formatPersonNameLines(personData) {
  const data =
    personData?.data && typeof personData.data === 'object' ? personData.data : personData;
  return [
    formatPersonSurname(data),
    cleanNamePart(data?.first_name),
    cleanNamePart(data?.middle_name ?? data?.patronymic),
  ].filter(Boolean);
}

export function formatPersonName(person) {
  return formatPersonNameLines(person).join(' ') || 'Без имени';
}

export function formatBirthDate(value) {
  if (typeof value !== 'string') return '';

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return '';

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1]) {
    return '';
  }

  return `${match[3]}.${match[2]}.${match[1]}`;
}

export function formatPersonCardName(person) {
  return formatPersonNameLines(person?.data).join('\n');
}

export function formatPersonCardBirthDate(person) {
  return formatBirthDate(person?.data?.birth_date);
}
