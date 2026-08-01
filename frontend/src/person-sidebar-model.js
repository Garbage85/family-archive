const FIELD_DEFINITIONS = [
  ['first_name', 'Имя'],
  ['last_name', 'Фамилия'],
  ['middle_name', 'Отчество'],
  ['gender', 'Пол', formatGender],
  ['birth_date', 'Дата рождения', formatDate],
  ['death_date', 'Дата смерти', formatDate],
  ['birth_place', 'Место рождения'],
  ['occupation', 'Профессия'],
  ['notes', 'Заметки'],
];

const RELATION_DEFINITIONS = [
  ['parents', 'Родители'],
  ['spouses', 'Супруги'],
  ['children', 'Дети'],
];

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const result = String(value).trim();
  return ['null', 'undefined'].includes(result.toLowerCase()) ? '' : result;
}

function formatGender(value) {
  const gender = cleanText(value).toUpperCase();
  if (gender === 'M') return 'Мужчина';
  if (gender === 'F') return 'Женщина';
  return cleanText(value);
}

function formatDate(value) {
  const date = cleanText(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}.${match[2]}.${match[1]}` : date;
}

function personInitials(person) {
  const data = person?.data || {};
  const parts = [cleanText(data.first_name), cleanText(data.last_name)].filter(Boolean);
  return (
    parts
      .map((part) => part[0].toLocaleUpperCase('ru-RU'))
      .join('')
      .slice(0, 2) || '—'
  );
}

function sidebarPersonName(person) {
  const data = person?.data || {};
  const parts = [data.last_name, data.first_name, data.middle_name].map(cleanText).filter(Boolean);
  return parts.join(' ') || 'Без имени';
}

function relationPeople(ids, peopleById) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  return uniqueIds.map((id) => {
    const person = peopleById.get(id);
    return {
      id,
      name: person ? sidebarPersonName(person) : 'Неизвестный человек',
      initials: person ? personInitials(person) : '—',
    };
  });
}

export function preparePersonSidebarData(treeData, personId) {
  if (!Array.isArray(treeData) || personId === null || personId === undefined) return null;

  const peopleById = new Map(treeData.map((person) => [String(person?.id), person]));
  const person = peopleById.get(String(personId));
  if (!person) return null;

  const data = person.data || {};
  const fields = FIELD_DEFINITIONS.map(([key, label, formatter = cleanText]) => ({
    key,
    label,
    value: formatter(data[key]),
  })).filter((field) => field.value);

  const relations = person.rels || {};
  const relationGroups = RELATION_DEFINITIONS.map(([key, label]) => ({
    key,
    label,
    people: relationPeople(relations[key], peopleById),
  }));

  return {
    id: String(person.id),
    fullName: sidebarPersonName(person),
    initials: personInitials(person),
    photoUrl: cleanText(data.avatar),
    values: Object.fromEntries(FIELD_DEFINITIONS.map(([key]) => [key, cleanText(data[key])])),
    fields,
    relationGroups,
  };
}
