import test from 'node:test';
import assert from 'node:assert/strict';
import { PersonSidebar } from '../src/person-sidebar.js';
import { preparePersonSidebarData } from '../src/person-sidebar-model.js';

test('click navigation delegates a sibling id to the existing person selection handler', () => {
  const selectedIds = [];
  const sidebar = {
    handlers: { onSelect: (personId) => selectedIds.push(personId) },
  };

  PersonSidebar.prototype.openRelatedPerson.call(sidebar, 'sibling');

  assert.deepEqual(selectedIds, ['sibling']);
});

test('click navigation ignores an empty relationship target', () => {
  let selections = 0;
  const sidebar = { handlers: { onSelect: () => (selections += 1) } };

  PersonSidebar.prototype.openRelatedPerson.call(sidebar, '');

  assert.equal(selections, 0);
});

test('dangling relationship model has no navigation target', () => {
  const view = preparePersonSidebarData(
    [
      {
        id: 'selected',
        data: { first_name: 'Анна' },
        rels: { spouses: ['missing-person'] },
      },
    ],
    'selected',
  );
  const dangling = view.relationGroups.find((group) => group.key === 'spouses').people[0];

  assert.equal(dangling.isResolved, false);
  assert.equal(dangling.name, 'Неизвестный человек');
});
