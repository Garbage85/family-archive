import {
  addRelative,
  addRelativeWithLinks,
  cloneTree,
  deletePerson,
  updatePerson,
} from './tree-utils.js';

export function canEditPeople(role, previewMode = false) {
  return !previewMode && ['admin', 'member'].includes(role);
}

export function applyPersonAction(state, action) {
  if (!canEditPeople(state.role, state.previewMode)) {
    throw new Error('Редактирование недоступно.');
  }

  let data;
  let createdPersonId = null;

  if (action.type === 'update') {
    data = updatePerson(state.data, action.personId, action.values);
  } else if (action.type === 'add-relative') {
    const presets = {
      father: { relation: 'parent', gender: 'M' },
      mother: { relation: 'parent', gender: 'F' },
      son: { relation: 'child', gender: 'M' },
      daughter: { relation: 'child', gender: 'F' },
      brother: { relation: 'sibling', gender: 'M' },
      sister: { relation: 'sibling', gender: 'F' },
      husband: { relation: 'spouse', gender: 'M' },
      wife: { relation: 'spouse', gender: 'F' },
    };
    const preset = presets[action.relation];
    const relation = preset?.relation || action.relation;
    const values = preset ? { ...action.values, gender: preset.gender } : action.values;
    const result = Object.prototype.hasOwnProperty.call(action, 'links')
      ? addRelativeWithLinks(state.data, action.personId, relation, values, action.links)
      : addRelative(state.data, action.personId, relation, values);
    data = result.data;
    createdPersonId = result.person.id;
  } else if (action.type === 'delete') {
    data = deletePerson(state.data, action.personId);
  } else if (action.type === 'set-photo') {
    data = updatePerson(state.data, action.personId, { avatar: action.photoUrl || '' });
  } else {
    throw new Error('Неизвестное действие редактора.');
  }

  return { data, dirty: true, createdPersonId };
}

export async function persistTreeChanges({
  role,
  previewMode = false,
  tree,
  data,
  userId,
  comment = '',
  save,
  propose,
}) {
  if (!canEditPeople(role, previewMode)) throw new Error('Сохранение недоступно.');

  const snapshot = cloneTree(data);
  if (role === 'admin') {
    return { kind: 'saved', tree: await save(tree, snapshot, userId) };
  }

  const proposal = await propose(tree, snapshot, userId, comment);
  return { kind: 'proposed', proposal };
}
