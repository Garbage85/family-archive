import { formatPersonName } from './person-card-formatters.js';

export const ROLE_LABELS = {
  viewer: 'Просмотр',
  member: 'Участник',
  admin: 'Администратор',
};

export const LEGACY_EMPTY_NOTES =
  'Нажмите на карточку, чтобы изменить данные и добавить родственников.';

export function normalisePersonNotes(value) {
  const notes = String(value || '');
  return notes === LEGACY_EMPTY_NOTES ? '' : notes;
}

export function cloneTree(data) {
  return typeof structuredClone === 'function'
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

export function personName(person) {
  return formatPersonName(person);
}

function normaliseGender(value) {
  if (value === null || value === undefined) return 'M';
  const gender = String(value || '').toUpperCase();
  return ['M', 'F'].includes(gender) ? gender : '';
}

export function normaliseTree(input) {
  const data = Array.isArray(input) ? cloneTree(input) : [];
  return data.map((person, index) => {
    const personData = person?.data || {};
    const optionalMaidenName = Object.prototype.hasOwnProperty.call(personData, 'maiden_name')
      ? { maiden_name: String(personData.maiden_name || '') }
      : {};

    return {
      id: String(person?.id || crypto.randomUUID?.() || `person-${Date.now()}-${index}`),
      data: {
        ...personData,
        ...optionalMaidenName,
        gender: normaliseGender(personData.gender),
        first_name: String(personData.first_name || ''),
        last_name: String(personData.last_name || ''),
        middle_name: String(personData.middle_name || ''),
        birth_date: String(personData.birth_date || ''),
        death_date: String(personData.death_date || ''),
        birth_place: String(personData.birth_place || ''),
        occupation: String(personData.occupation || ''),
        notes: normalisePersonNotes(personData.notes),
        avatar: String(personData.avatar || ''),
      },
      rels: {
        ...(person?.rels || {}),
        parents: Array.isArray(person?.rels?.parents) ? person.rels.parents.map(String) : [],
        spouses: Array.isArray(person?.rels?.spouses) ? person.rels.spouses.map(String) : [],
        children: Array.isArray(person?.rels?.children) ? person.rels.children.map(String) : [],
      },
    };
  });
}

export function validateTree(data) {
  const errors = [];
  if (!Array.isArray(data) || data.length === 0) {
    return ['В древе должен быть хотя бы один человек.'];
  }

  const ids = new Set();
  for (const person of data) {
    if (!person?.id) errors.push('Найдена запись без идентификатора.');
    if (ids.has(person.id)) errors.push(`Повторяется идентификатор ${person.id}.`);
    ids.add(person.id);
    if (!['M', 'F', ''].includes(person?.data?.gender)) {
      errors.push(`${personName(person)}: пол должен быть M, F или не указан.`);
    }
  }

  for (const person of data) {
    for (const kind of ['parents', 'spouses', 'children']) {
      const relations = person?.rels?.[kind] || [];
      for (const relatedId of relations) {
        if (!ids.has(relatedId)) {
          errors.push(
            `${personName(person)}: связь ${kind} ведёт к отсутствующему ID ${relatedId}.`,
          );
        }
        if (relatedId === person.id) {
          errors.push(`${personName(person)} не может быть родственником самому себе.`);
        }
      }
    }
  }

  return [...new Set(errors)];
}

export function diffTrees(before, after) {
  const left = new Map((before || []).map((person) => [person.id, person]));
  const right = new Map((after || []).map((person) => [person.id, person]));
  let added = 0;
  let removed = 0;
  let changed = 0;

  for (const [id, person] of right) {
    if (!left.has(id)) added += 1;
    else if (JSON.stringify(left.get(id)) !== JSON.stringify(person)) changed += 1;
  }
  for (const id of left.keys()) {
    if (!right.has(id)) removed += 1;
  }

  return { added, removed, changed };
}

export function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function isoNow() {
  return new Date().toISOString();
}

export function createPerson(values = {}) {
  const id = crypto.randomUUID?.() || `person-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return normaliseTree([
    {
      id,
      data: {
        gender: normaliseGender(values.gender),
        first_name: values.first_name || '',
        last_name: values.last_name || '',
        middle_name: values.middle_name || '',
        ...(values.maiden_name ? { maiden_name: values.maiden_name } : {}),
        birth_date: values.birth_date || '',
        death_date: values.death_date || '',
        birth_place: values.birth_place || '',
        occupation: values.occupation || '',
        notes: normalisePersonNotes(values.notes),
        avatar: values.avatar || '',
      },
      rels: { parents: [], spouses: [], children: [] },
    },
  ])[0];
}

function addUnique(list, id) {
  if (!list.includes(id)) list.push(id);
}

function applyLinkFromNewPerson(data, relative, related, relation) {
  if (relation === 'parent') {
    addUnique(relative.rels.parents, related.id);
    addUnique(related.rels.children, relative.id);
  } else if (relation === 'child') {
    addUnique(relative.rels.children, related.id);
    addUnique(related.rels.parents, relative.id);
  } else if (relation === 'spouse') {
    addUnique(relative.rels.spouses, related.id);
    addUnique(related.rels.spouses, relative.id);
  } else {
    throw new Error('Неизвестный тип предлагаемой связи.');
  }
}

export function addRelativeWithLinks(tree, personId, relation, values = {}, additionalLinks = []) {
  const data = normaliseTree(tree);
  const selected = data.find((item) => item.id === personId);
  if (!selected) throw new Error('Человек не найден.');

  const uniqueLinks = [];
  const seenLinks = new Set();
  for (const item of Array.isArray(additionalLinks) ? additionalLinks : []) {
    const targetId = String(item?.personId || '');
    const linkRelation = String(item?.relation || '');
    const key = `${linkRelation}:${targetId}`;
    if (!targetId || !['parent', 'child', 'spouse'].includes(linkRelation)) {
      throw new Error('Предлагаемая связь заполнена неверно.');
    }
    if (seenLinks.has(key)) continue;
    const related = data.find((person) => person.id === targetId);
    if (!related) throw new Error('Человек для предлагаемой связи не найден.');
    seenLinks.add(key);
    uniqueLinks.push({ related, relation: linkRelation });
  }

  if (relation === 'sibling' && !uniqueLinks.some((item) => item.relation === 'parent')) {
    throw new Error('Выберите хотя бы одного общего родителя.');
  }
  if (!['parent', 'child', 'spouse', 'sibling'].includes(relation)) {
    throw new Error('Неизвестный тип родства.');
  }

  const relative = createPerson(values);
  data.push(relative);

  if (relation === 'parent') applyLinkFromNewPerson(data, relative, selected, 'child');
  if (relation === 'child') applyLinkFromNewPerson(data, relative, selected, 'parent');
  if (relation === 'spouse') applyLinkFromNewPerson(data, relative, selected, 'spouse');
  for (const item of uniqueLinks) {
    applyLinkFromNewPerson(data, relative, item.related, item.relation);
  }

  return { data, person: relative };
}

export function addRelative(tree, personId, relation, values = {}) {
  const data = normaliseTree(tree);
  const person = data.find((item) => item.id === personId);
  if (!person) throw new Error('Человек не найден.');

  const relative = createPerson(values);
  data.push(relative);

  if (relation === 'parent') {
    addUnique(person.rels.parents, relative.id);
    addUnique(relative.rels.children, person.id);
  } else if (relation === 'child') {
    addUnique(person.rels.children, relative.id);
    addUnique(relative.rels.parents, person.id);
  } else if (relation === 'spouse') {
    addUnique(person.rels.spouses, relative.id);
    addUnique(relative.rels.spouses, person.id);
  } else if (relation === 'sibling') {
    for (const parentId of person.rels.parents) {
      const parent = data.find((item) => item.id === parentId);
      if (!parent) continue;
      addUnique(relative.rels.parents, parentId);
      addUnique(parent.rels.children, relative.id);
    }
    if (!relative.rels.parents.length) {
      throw new Error('Чтобы добавить брата или сестру, сначала укажите хотя бы одного родителя.');
    }
  } else {
    throw new Error('Неизвестный тип родства.');
  }

  return { data, person: relative };
}

export function updatePerson(tree, personId, values) {
  const data = normaliseTree(tree);
  const person = data.find((item) => item.id === personId);
  if (!person) throw new Error('Человек не найден.');
  const hadMaidenName = Object.prototype.hasOwnProperty.call(person.data, 'maiden_name');
  person.data = {
    ...person.data,
    ...values,
    gender: values.gender === undefined ? person.data.gender : normaliseGender(values.gender),
  };
  person.data.notes = normalisePersonNotes(person.data.notes);
  if (!hadMaidenName && !String(values.maiden_name || '').trim()) {
    delete person.data.maiden_name;
  }
  return data;
}

export function deletePerson(tree, personId) {
  const data = normaliseTree(tree);
  if (data.length <= 1) throw new Error('Нельзя удалить единственного человека из древа.');
  const next = data.filter((item) => item.id !== personId);
  for (const person of next) {
    for (const key of ['parents', 'spouses', 'children']) {
      person.rels[key] = person.rels[key].filter((id) => id !== personId);
    }
  }
  return next;
}
