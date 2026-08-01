import {
  getParentRoleLabel,
  getSpouseRoleLabel,
  getSpouseSectionLabel,
  shouldShowMaidenName,
} from './person-relationship-rules.js';

const FIELD_DEFINITIONS = [
  ['first_name', 'Имя'],
  ['last_name', 'Фамилия'],
  ['maiden_name', 'Девичья фамилия'],
  ['middle_name', 'Отчество'],
  ['gender', 'Пол', formatGender],
  ['birth_date', 'Дата рождения', formatDate],
  ['death_date', 'Дата смерти', formatDate],
  ['birth_place', 'Место рождения'],
  ['occupation', 'Профессия'],
  ['notes', 'Заметки'],
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

function relationPeople(ids, peopleById, { getRoleLabel, relationType } = {}) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  return uniqueIds.map((id) => {
    const person = peopleById.get(id);
    return {
      id,
      name: person ? sidebarPersonName(person) : 'Неизвестный человек',
      initials: person ? personInitials(person) : '—',
      roleLabel: getRoleLabel?.(person) || '',
      ...(relationType ? { relationType } : {}),
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
  })).filter(
    (field) => field.value && (field.key !== 'maiden_name' || shouldShowMaidenName(person)),
  );

  const relations = person.rels || {};
  const parentPeople = relationPeople(relations.parents, peopleById, {
    getRoleLabel: getParentRoleLabel,
    // TODO: Move this display-only default into a parent-child relation object such as
    // { parentId, childId, type: 'biological' | 'adoptive' | 'step' | 'guardian' }.
    // Until that model is introduced, trees.data continues to store parent IDs only.
    relationType: 'biological',
  });
  const spousePeople = relationPeople(relations.spouses, peopleById, {
    getRoleLabel: getSpouseRoleLabel,
  });
  const relationGroups = [
    { key: 'parents', label: 'Родители', people: parentPeople },
    {
      key: 'spouses',
      label: getSpouseSectionLabel(person, spousePeople.length),
      people: spousePeople,
    },
    { key: 'children', label: 'Дети', people: relationPeople(relations.children, peopleById) },
  ];

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
