import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPersonAction, canEditPeople, persistTreeChanges } from '../src/person-editor.js';

const baseTree = [
  {
    id: 'person-1',
    data: { first_name: 'Анна', last_name: 'Петрова', gender: 'F', avatar: '' },
    rels: { parents: ['person-2'], spouses: [], children: [] },
  },
  {
    id: 'person-2',
    data: { first_name: 'Иван', last_name: 'Петров', gender: 'M', avatar: '' },
    rels: { parents: [], spouses: [], children: ['person-1'] },
  },
];

function editableState(overrides = {}) {
  return {
    data: baseTree,
    dirty: false,
    role: 'admin',
    previewMode: false,
    ...overrides,
  };
}

test('admin changes are saved directly through the existing save path', async () => {
  const tree = { id: 'tree-1', revision: 4, data: baseTree };
  const changed = applyPersonAction(editableState(), {
    type: 'update',
    personId: 'person-1',
    values: { first_name: 'Анна-Мария', gender: 'F' },
  });
  let savedArgs;

  const result = await persistTreeChanges({
    role: 'admin',
    tree,
    data: changed.data,
    userId: 'admin-1',
    save: async (...args) => {
      savedArgs = args;
      return { ...tree, revision: 5, data: args[1] };
    },
    propose: async () => assert.fail('proposal path must not be used for admin'),
  });

  assert.equal(result.kind, 'saved');
  assert.equal(result.tree.revision, 5);
  assert.equal(savedArgs[0], tree);
  assert.equal(savedArgs[1][0].data.first_name, 'Анна-Мария');
  assert.equal(savedArgs[2], 'admin-1');
});

test('member changes create a proposal through the existing proposal path', async () => {
  const tree = { id: 'tree-1', revision: 4, data: baseTree };
  const changed = applyPersonAction(editableState({ role: 'member' }), {
    type: 'update',
    personId: 'person-1',
    values: { occupation: 'Архитектор', gender: 'F' },
  });
  let proposalArgs;

  const result = await persistTreeChanges({
    role: 'member',
    tree,
    data: changed.data,
    userId: 'member-1',
    comment: 'Уточнена профессия',
    save: async () => assert.fail('direct save path must not be used for member'),
    propose: async (...args) => {
      proposalArgs = args;
      return { id: 'proposal-1' };
    },
  });

  assert.equal(result.kind, 'proposed');
  assert.equal(result.proposal.id, 'proposal-1');
  assert.equal(proposalArgs[0], tree);
  assert.equal(proposalArgs[1][0].data.occupation, 'Архитектор');
  assert.deepEqual(proposalArgs.slice(2), ['member-1', 'Уточнена профессия']);
});

test('viewer is read-only', async () => {
  assert.equal(canEditPeople('viewer'), false);
  assert.throws(
    () =>
      applyPersonAction(editableState({ role: 'viewer' }), {
        type: 'delete',
        personId: 'person-1',
      }),
    /Редактирование недоступно/,
  );
  await assert.rejects(
    persistTreeChanges({
      role: 'viewer',
      tree: { data: baseTree },
      data: baseTree,
      save: async () => {},
      propose: async () => {},
    }),
    /Сохранение недоступно/,
  );
});

test('preview mode is read-only for admin and member', async () => {
  for (const role of ['admin', 'member']) {
    assert.equal(canEditPeople(role, true), false);
    assert.throws(
      () =>
        applyPersonAction(editableState({ role, previewMode: true }), {
          type: 'update',
          personId: 'person-1',
          values: { first_name: 'Нельзя' },
        }),
      /Редактирование недоступно/,
    );
    await assert.rejects(
      persistTreeChanges({
        role,
        previewMode: true,
        tree: { data: baseTree },
        data: baseTree,
        save: async () => assert.fail('preview must not save'),
        propose: async () => assert.fail('preview must not create a proposal'),
      }),
      /Сохранение недоступно/,
    );
  }
});

test('adding every supported relative marks the tree dirty and creates reciprocal links', () => {
  for (const relation of ['parent', 'spouse', 'child', 'sibling']) {
    const result = applyPersonAction(editableState(), {
      type: 'add-relative',
      personId: 'person-1',
      relation,
      values: { first_name: `Новый ${relation}`, gender: 'M' },
    });
    const person = result.data.find((item) => item.id === 'person-1');
    const relative = result.data.find((item) => item.id === result.createdPersonId);

    assert.equal(result.dirty, true);
    assert.ok(relative);
    if (relation === 'parent') {
      assert.ok(person.rels.parents.includes(relative.id));
      assert.ok(relative.rels.children.includes(person.id));
    } else if (relation === 'spouse') {
      assert.ok(person.rels.spouses.includes(relative.id));
      assert.ok(relative.rels.spouses.includes(person.id));
    } else if (relation === 'child') {
      assert.ok(person.rels.children.includes(relative.id));
      assert.ok(relative.rels.parents.includes(person.id));
    } else {
      assert.deepEqual(relative.rels.parents, ['person-2']);
    }
  }
});

test('father action creates a male parent and preserves existing parents', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'father',
    values: { first_name: 'Сергей', gender: 'F' },
  });
  const child = result.data.find((person) => person.id === 'person-1');
  const father = result.data.find((person) => person.id === result.createdPersonId);

  assert.equal(father.data.gender, 'M');
  assert.deepEqual(child.rels.parents, ['person-2', father.id]);
  assert.deepEqual(father.rels.children, ['person-1']);
});

test('mother action creates a female parent and stores maiden_name', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'mother',
    values: { first_name: 'Мария', gender: 'M', maiden_name: 'Соколова' },
  });
  const child = result.data.find((person) => person.id === 'person-1');
  const mother = result.data.find((person) => person.id === result.createdPersonId);

  assert.equal(mother.data.gender, 'F');
  assert.equal(mother.data.maiden_name, 'Соколова');
  assert.deepEqual(child.rels.parents, ['person-2', mother.id]);
  assert.deepEqual(mother.rels.children, ['person-1']);
});

test('generic parent action supports an unknown gender from additional actions', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'parent',
    values: { first_name: 'Другой родитель', gender: '' },
  });
  const child = result.data.find((person) => person.id === 'person-1');
  const parent = result.data.find((person) => person.id === result.createdPersonId);

  assert.equal(parent.data.gender, '');
  assert.deepEqual(child.rels.parents, ['person-2', parent.id]);
  assert.deepEqual(parent.rels.children, ['person-1']);
});

test('an unchecked suggested link is omitted while the required link is created', () => {
  const spouseTree = [
    ...baseTree,
    {
      id: 'spouse',
      data: { first_name: 'Супруг', gender: 'M' },
      rels: { parents: [], spouses: ['person-1'], children: [] },
    },
  ];
  spouseTree[0] = {
    ...spouseTree[0],
    rels: { ...spouseTree[0].rels, spouses: ['spouse'] },
  };

  const result = applyPersonAction(editableState({ data: spouseTree }), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'daughter',
    values: { first_name: 'Дочь' },
    links: [],
  });
  const selected = result.data.find((item) => item.id === 'person-1');
  const relative = result.data.find((item) => item.id === result.createdPersonId);

  assert.ok(selected.rels.children.includes(relative.id));
  assert.deepEqual(relative.rels.parents, ['person-1']);
  assert.equal(relative.rels.parents.includes('spouse'), false);
});

test('checked suggested links are created reciprocally with the new person', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'mother',
    values: { first_name: 'Мария' },
    links: [{ personId: 'person-2', relation: 'spouse' }],
  });
  const relative = result.data.find((item) => item.id === result.createdPersonId);
  const existingFather = result.data.find((item) => item.id === 'person-2');

  assert.deepEqual(relative.rels.children, ['person-1']);
  assert.deepEqual(relative.rels.spouses, ['person-2']);
  assert.ok(existingFather.rels.spouses.includes(relative.id));
});

test('autofill field state is never stored in the person data', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'daughter',
    values: {
      first_name: 'Дочь',
      middle_name: 'Ивановна',
      fieldSources: { middle_name: 'suggested' },
    },
    links: [],
  });
  const relative = result.data.find((item) => item.id === result.createdPersonId);

  assert.equal(relative.data.middle_name, 'Ивановна');
  assert.equal(Object.hasOwn(relative.data, 'fieldSources'), false);
  assert.deepEqual(Object.keys(relative.rels).sort(), ['children', 'parents', 'spouses']);
});

test('duplicate suggested links do not create duplicate relationships', () => {
  const link = { personId: 'person-2', relation: 'parent' };
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'son',
    values: { first_name: 'Сын' },
    links: [link, link],
  });
  const relative = result.data.find((item) => item.id === result.createdPersonId);
  const existingParent = result.data.find((item) => item.id === 'person-2');

  assert.deepEqual(relative.rels.parents, ['person-1', 'person-2']);
  assert.equal(existingParent.rels.children.filter((id) => id === relative.id).length, 1);
});

test('sibling creation uses only explicitly selected shared parents', () => {
  const result = applyPersonAction(editableState(), {
    type: 'add-relative',
    personId: 'person-1',
    relation: 'sister',
    values: { first_name: 'Сестра' },
    links: [{ personId: 'person-2', relation: 'parent' }],
  });
  const relative = result.data.find((item) => item.id === result.createdPersonId);

  assert.equal(relative.data.gender, 'F');
  assert.deepEqual(relative.rels.parents, ['person-2']);
});

test('a failed multi-link action leaves the original local tree unchanged', () => {
  const snapshot = structuredClone(baseTree);

  assert.throws(
    () =>
      applyPersonAction(editableState(), {
        type: 'add-relative',
        personId: 'person-1',
        relation: 'son',
        values: { first_name: 'Сын' },
        links: [{ personId: 'missing', relation: 'parent' }],
      }),
    /не найден/,
  );
  assert.deepEqual(baseTree, snapshot);
});

test('a sibling cannot be created without a selected shared parent', () => {
  assert.throws(
    () =>
      applyPersonAction(editableState(), {
        type: 'add-relative',
        personId: 'person-1',
        relation: 'brother',
        values: { first_name: 'Брат' },
        links: [],
      }),
    /Выберите хотя бы одного общего родителя/,
  );
});

test('deleting a person removes links and marks the tree dirty', () => {
  const result = applyPersonAction(editableState(), {
    type: 'delete',
    personId: 'person-1',
  });

  assert.equal(result.dirty, true);
  assert.deepEqual(
    result.data.map((person) => person.id),
    ['person-2'],
  );
  assert.deepEqual(result.data[0].rels.children, []);
});

test('uploading and removing a photo preserves other fields and marks the tree dirty', () => {
  const uploaded = applyPersonAction(editableState(), {
    type: 'set-photo',
    personId: 'person-1',
    photoUrl: '/api/files/media/photo.webp',
  });
  const uploadedPerson = uploaded.data.find((person) => person.id === 'person-1');

  assert.equal(uploaded.dirty, true);
  assert.equal(uploadedPerson.data.avatar, '/api/files/media/photo.webp');
  assert.equal(uploadedPerson.data.gender, 'F');

  const removed = applyPersonAction(
    { ...editableState(), data: uploaded.data, dirty: true },
    { type: 'set-photo', personId: 'person-1', photoUrl: '' },
  );
  assert.equal(removed.dirty, true);
  assert.equal(removed.data.find((person) => person.id === 'person-1').data.avatar, '');
});
