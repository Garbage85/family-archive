export const ROLE_LABELS = {
  viewer: 'Просмотр',
  member: 'Участник',
  admin: 'Администратор',
};

export function cloneTree(data) {
  return typeof structuredClone === 'function'
    ? structuredClone(data)
    : JSON.parse(JSON.stringify(data));
}

export function personName(person) {
  const parts = [
    person?.data?.last_name,
    person?.data?.first_name,
    person?.data?.middle_name,
  ].filter(Boolean);
  return parts.join(' ') || 'Без имени';
}

export function normaliseTree(input) {
  const data = Array.isArray(input) ? cloneTree(input) : [];
  return data.map((person, index) => ({
    id: String(person?.id || crypto.randomUUID?.() || `person-${Date.now()}-${index}`),
    data: {
      ...(person?.data || {}),
      gender: person?.data?.gender === 'F' ? 'F' : 'M',
      first_name: String(person?.data?.first_name || ''),
      last_name: String(person?.data?.last_name || ''),
      middle_name: String(person?.data?.middle_name || ''),
      birth_date: String(person?.data?.birth_date || ''),
      death_date: String(person?.data?.death_date || ''),
      birth_place: String(person?.data?.birth_place || ''),
      occupation: String(person?.data?.occupation || ''),
      notes: String(person?.data?.notes || ''),
      avatar: String(person?.data?.avatar || ''),
    },
    rels: {
      ...(person?.rels || {}),
      parents: Array.isArray(person?.rels?.parents) ? person.rels.parents.map(String) : [],
      spouses: Array.isArray(person?.rels?.spouses) ? person.rels.spouses.map(String) : [],
      children: Array.isArray(person?.rels?.children) ? person.rels.children.map(String) : [],
    },
  }));
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
    if (!['M', 'F'].includes(person?.data?.gender)) {
      errors.push(`${personName(person)}: пол должен быть M или F.`);
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
        gender: values.gender === 'F' ? 'F' : 'M',
        first_name: values.first_name || '',
        last_name: values.last_name || '',
        middle_name: values.middle_name || '',
        birth_date: values.birth_date || '',
        death_date: values.death_date || '',
        birth_place: values.birth_place || '',
        occupation: values.occupation || '',
        notes: values.notes || '',
        avatar: values.avatar || '',
      },
      rels: { parents: [], spouses: [], children: [] },
    },
  ])[0];
}

function addUnique(list, id) {
  if (!list.includes(id)) list.push(id);
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
  person.data = {
    ...person.data,
    ...values,
    gender: values.gender === 'F' ? 'F' : 'M',
  };
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
