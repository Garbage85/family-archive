import { getParentRoleLabel, getSpouseSectionLabel } from './person-relationship-rules.js';
import { cleanNamePart, formatPersonName, formatPersonSurname } from './person-card-formatters.js';
import { normalisePersonNotes } from './tree-utils.js';

const DETAILS_FIELD_DEFINITIONS = [
  ['gender', 'Пол', formatGender],
  ['birth_date', 'Дата рождения', formatDate],
  ['death_date', 'Дата смерти', formatDate],
  ['birth_place', 'Место рождения'],
  ['occupation', 'Профессия'],
  ['notes', 'Заметки'],
];

const VALUE_FIELDS = [
  'first_name',
  'last_name',
  'maiden_name',
  'middle_name',
  ...DETAILS_FIELD_DEFINITIONS.map(([key]) => key),
];

function cleanText(value) {
  return cleanNamePart(value);
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

function fieldDefinitions(person) {
  const female = cleanText(person?.data?.gender).toUpperCase() === 'F';
  const nameFields = female
    ? [
        ['maiden_name', 'Девичья фамилия'],
        ['last_name', 'Фамилия'],
        ['first_name', 'Имя'],
        ['middle_name', 'Отчество'],
      ]
    : [
        ['last_name', 'Фамилия'],
        ['first_name', 'Имя'],
        ['middle_name', 'Отчество'],
      ];
  return [...nameFields, ...DETAILS_FIELD_DEFINITIONS];
}

function personInitials(person) {
  const data = person?.data || {};
  const parts = [cleanText(data.first_name), formatPersonSurname(data)].filter(Boolean);
  return (
    parts
      .map((part) => part[0].toLocaleUpperCase('ru-RU'))
      .join('')
      .slice(0, 2) || '—'
  );
}

function relationPeople(ids, peopleById, { getRoleLabel, relationType } = {}) {
  const uniqueIds = [...new Set((Array.isArray(ids) ? ids : []).map(String))];
  return uniqueIds.map((id) => {
    const person = peopleById.get(id);
    return {
      id,
      name: person ? formatPersonName(person) : 'Неизвестный человек',
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
  const fields = fieldDefinitions(person)
    .map(([key, label, formatter = cleanText]) => ({
      key,
      label,
      value: formatter(key === 'notes' ? normalisePersonNotes(data[key]) : data[key]),
    }))
    .filter((field) => field.value);

  const relations = person.rels || {};
  const parentPeople = relationPeople(relations.parents, peopleById, {
    getRoleLabel: getParentRoleLabel,
    // TODO: Move this display-only default into a parent-child relation object such as
    // { parentId, childId, type: 'biological' | 'adoptive' | 'step' | 'guardian' }.
    // Until that model is introduced, trees.data continues to store parent IDs only.
    relationType: 'biological',
  });
  const spousePeople = relationPeople(relations.spouses, peopleById);
  const singleSpouse =
    spousePeople.length === 1 ? peopleById.get(String(relations.spouses?.[0])) : null;
  const relationGroups = [
    { key: 'parents', label: 'Родители', people: parentPeople },
    {
      key: 'spouses',
      label: getSpouseSectionLabel(singleSpouse, spousePeople.length),
      people: spousePeople,
    },
    { key: 'children', label: 'Дети', people: relationPeople(relations.children, peopleById) },
  ];

  return {
    id: String(person.id),
    fullName: formatPersonName(person),
    initials: personInitials(person),
    photoUrl: cleanText(data.avatar),
    values: Object.fromEntries(
      VALUE_FIELDS.map((key) => [
        key,
        cleanText(key === 'notes' ? normalisePersonNotes(data[key]) : data[key]),
      ]),
    ),
    fields,
    relationGroups,
  };
}
