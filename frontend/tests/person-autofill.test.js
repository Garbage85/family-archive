import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRelativeDraft,
  buildRussianPatronymic,
  deriveFatherNameFromPatronymic,
  feminizeRussianSurname,
  getRelativeActionTypes,
  markDraftFieldExplicit,
  masculinizeRussianSurname,
  mergeRelativeDraft,
  resetDraftFieldSuggestion,
  suggestSecondParent,
  suggestSharedParentsForSibling,
  suggestSpouseLinkForNewParent,
} from '../src/person-autofill.js';

function person(id, data, rels = {}) {
  return {
    id,
    data,
    rels: { parents: [], spouses: [], children: [], ...rels },
  };
}

const father = person('father', {
  first_name: 'Сергей',
  last_name: 'Иванов',
  middle_name: 'Алексеевич',
  gender: 'M',
});
const mother = person('mother', {
  first_name: 'Елена',
  last_name: 'Иванова',
  middle_name: 'Викторовна',
  gender: 'F',
});
const alexey = person(
  'alexey',
  { first_name: 'Алексей', last_name: 'Сапожников', middle_name: 'Ильич', gender: 'M' },
  { spouses: ['elena'], children: ['child'] },
);
const elena = person(
  'elena',
  { first_name: 'Елена', last_name: 'Сапожникова', middle_name: 'Павловна', gender: 'F' },
  { spouses: ['alexey'], children: ['child'] },
);
const child = person(
  'child',
  { first_name: 'Иван', last_name: 'Иванов', middle_name: 'Сергеевич', gender: 'M' },
  { parents: ['father', 'mother'] },
);
const people = [father, mother, alexey, elena, child];

test('feminizeRussianSurname handles -ов and related conservative forms', () => {
  assert.equal(feminizeRussianSurname('Сапожников'), 'Сапожникова');
  assert.equal(feminizeRussianSurname('Иванов'), 'Иванова');
  assert.equal(feminizeRussianSurname('Сергеев'), 'Сергеева');
  assert.equal(feminizeRussianSurname('Пушкин'), 'Пушкина');
  assert.equal(feminizeRussianSurname('Ильин'), 'Ильина');
});

test('masculinizeRussianSurname reverses conservative feminine forms', () => {
  assert.equal(masculinizeRussianSurname('Сапожникова'), 'Сапожников');
  assert.equal(masculinizeRussianSurname('Иванова'), 'Иванов');
});

test('Tolstoy surname has its irregular gender pair', () => {
  assert.equal(feminizeRussianSurname('Толстой'), 'Толстая');
  assert.equal(masculinizeRussianSurname('Толстая'), 'Толстой');
});

test('invariable surnames remain unchanged', () => {
  for (const surname of ['Шевченко', 'Долгих', 'Черных', 'Седых', 'Бондарь', 'Коваль']) {
    assert.equal(feminizeRussianSurname(surname), surname);
    assert.equal(masculinizeRussianSurname(surname), surname);
  }
});

test('unknown surname is not corrupted and produces a draft warning', () => {
  assert.equal(feminizeRussianSurname('Необычная'), 'Необычная');
  const selected = person('unknown-surname', { last_name: 'Необычная', gender: 'M' });
  const draft = buildRelativeDraft({
    selectedPerson: selected,
    relationType: 'daughter',
    people: [selected],
  });
  assert.equal(draft.person.last_name, 'Необычная');
  assert.match(draft.warnings.join(' '), /нельзя надёжно изменить/);
});

test('buildRussianPatronymic builds the common Alexey forms', () => {
  assert.equal(buildRussianPatronymic('Алексей', 'M'), 'Алексеевич');
  assert.equal(buildRussianPatronymic('Алексей', 'F'), 'Алексеевна');
});

test('buildRussianPatronymic applies required exceptions', () => {
  assert.deepEqual(
    ['Илья', 'Павел', 'Лев', 'Никита', 'Фома', 'Лука'].map((name) => [
      name,
      buildRussianPatronymic(name, 'M'),
      buildRussianPatronymic(name, 'F'),
    ]),
    [
      ['Илья', 'Ильич', 'Ильинична'],
      ['Павел', 'Павлович', 'Павловна'],
      ['Лев', 'Львович', 'Львовна'],
      ['Никита', 'Никитич', 'Никитична'],
      ['Фома', 'Фомич', 'Фоминична'],
      ['Лука', 'Лукич', 'Лукинична'],
    ],
  );
});

test('unknown first name is not used to invent a patronymic', () => {
  assert.equal(buildRussianPatronymic('Женя', 'M'), '');
  assert.equal(buildRussianPatronymic('Женя', 'F'), '');

  const selected = person('unknown-name', {
    first_name: 'Женя',
    last_name: 'Шевченко',
    gender: 'M',
  });
  const draft = buildRelativeDraft({
    selectedPerson: selected,
    relationType: 'son',
    people: [selected],
  });
  assert.equal(draft.person.patronymic, '');
  assert.match(draft.warnings.join(' '), /нельзя надёжно построить/);
});

test('deriveFatherNameFromPatronymic recognises common and exception forms', () => {
  assert.equal(deriveFatherNameFromPatronymic('Сергеевич'), 'Сергей');
  assert.equal(deriveFatherNameFromPatronymic('Сергеевна'), 'Сергей');
  assert.equal(deriveFatherNameFromPatronymic('Алексеевич'), 'Алексей');
  assert.equal(deriveFatherNameFromPatronymic('Алексеевна'), 'Алексей');
  assert.equal(deriveFatherNameFromPatronymic('Ильич'), 'Илья');
  assert.equal(deriveFatherNameFromPatronymic('Ильинична'), 'Илья');
  assert.equal(deriveFatherNameFromPatronymic('Кузьмич'), '');
});

test('father draft derives name and offers the existing mother as spouse', () => {
  const draft = buildRelativeDraft({ selectedPerson: child, relationType: 'father', people });
  assert.deepEqual(draft.person, {
    first_name: 'Сергей',
    last_name: 'Иванов',
    patronymic: '',
    gender: 'M',
    maiden_name: '',
  });
  assert.equal(draft.fieldSources.first_name, 'suggested');
  assert.equal(draft.fieldSources.gender, 'explicit');
  assert.deepEqual(
    draft.requiredLinks.map((item) => item.relation),
    ['child'],
  );
  assert.deepEqual(
    draft.suggestedLinks.map((item) => [item.personId, item.relation, item.checked]),
    [['mother', 'spouse', true]],
  );
});

test('mother draft suggests feminine and maiden surnames and the existing father', () => {
  const draft = buildRelativeDraft({ selectedPerson: child, relationType: 'mother', people });
  assert.equal(draft.person.gender, 'F');
  assert.equal(draft.person.last_name, 'Иванова');
  assert.equal(draft.person.maiden_name, 'Иванова');
  assert.equal(draft.fieldSources.maiden_name, 'suggested');
  assert.equal(draft.suggestedLinks[0].personId, 'father');
});

test('son and daughter drafts from Alexey receive surname and patronymic', () => {
  const son = buildRelativeDraft({ selectedPerson: alexey, relationType: 'son', people });
  const daughter = buildRelativeDraft({ selectedPerson: alexey, relationType: 'daughter', people });
  assert.deepEqual(
    [son.person.gender, son.person.last_name, son.person.patronymic],
    ['M', 'Сапожников', 'Алексеевич'],
  );
  assert.deepEqual(
    [daughter.person.gender, daughter.person.last_name, daughter.person.patronymic],
    ['F', 'Сапожникова', 'Алексеевна'],
  );
  assert.equal(son.requiredLinks[0].relation, 'parent');
  assert.equal(son.suggestedLinks[0].personId, 'elena');
});

test('child of a woman with one male spouse gets patronymic from that spouse', () => {
  const draft = buildRelativeDraft({ selectedPerson: elena, relationType: 'daughter', people });
  assert.equal(draft.person.patronymic, 'Алексеевна');
  assert.equal(draft.suggestedLinks[0].personId, 'alexey');
  assert.equal(draft.suggestedLinks[0].checked, true);
});

test('siblings copy patronymic and offer every shared parent separately', () => {
  for (const [relationType, expectedGender, expectedSurname] of [
    ['brother', 'M', 'Иванов'],
    ['sister', 'F', 'Иванова'],
  ]) {
    const draft = buildRelativeDraft({ selectedPerson: child, relationType, people });
    assert.equal(draft.person.gender, expectedGender);
    assert.equal(draft.person.last_name, expectedSurname);
    assert.equal(draft.person.patronymic, 'Сергеевич');
    assert.deepEqual(
      draft.suggestedLinks.map((item) => [item.personId, item.checked]),
      [
        ['father', true],
        ['mother', true],
      ],
    );
  }
});

test('husband draft leaves surname empty and creates a required spouse link', () => {
  const draft = buildRelativeDraft({ selectedPerson: elena, relationType: 'husband', people });
  assert.equal(draft.person.gender, 'M');
  assert.equal(draft.person.last_name, '');
  assert.equal(draft.requiredLinks[0].relation, 'spouse');
});

test('wife draft suggests a feminine surname with a low-confidence maiden name', () => {
  const draft = buildRelativeDraft({ selectedPerson: alexey, relationType: 'wife', people });
  assert.equal(draft.person.gender, 'F');
  assert.equal(draft.person.last_name, 'Сапожникова');
  assert.equal(draft.person.maiden_name, 'Сапожникова');
  assert.match(draft.warnings.join(' '), /низкой уверенностью/);
});

test('spouse of a selected person with unknown gender remains gender-neutral', () => {
  const selected = person('unknown', { first_name: 'Саша', last_name: 'Шевченко', gender: '' });
  const draft = buildRelativeDraft({
    selectedPerson: selected,
    relationType: 'spouse',
    people: [selected],
  });
  assert.equal(draft.person.gender, '');
  assert.equal(draft.fieldSources.gender, 'explicit');
  assert.equal(draft.requiredLinks[0].relation, 'spouse');
});

test('relative actions use a logical spouse label without hiding universal actions', () => {
  const common = ['father', 'mother', 'son', 'daughter', 'brother', 'sister'];
  assert.deepEqual(getRelativeActionTypes(alexey).slice(0, 6), common);
  assert.ok(getRelativeActionTypes(alexey).includes('wife'));
  assert.ok(getRelativeActionTypes(elena).includes('husband'));
  assert.ok(getRelativeActionTypes(person('unknown-gender', { gender: '' })).includes('spouse'));
  assert.ok(getRelativeActionTypes(alexey).includes('parent'));
});

test('suggestion helpers do not select the first of several candidates', () => {
  const secondSpouse = person('second-spouse', { first_name: 'Мария', gender: 'F' });
  const selected = { ...alexey, rels: { ...alexey.rels, spouses: ['elena', 'second-spouse'] } };
  const links = suggestSecondParent(selected, [...people, secondSpouse]);
  assert.equal(links.length, 2);
  assert.equal(
    links.every((item) => item.checked === false),
    true,
  );
});

test('relationship suggestion helpers return only resolved relationship targets', () => {
  assert.deepEqual(
    suggestSharedParentsForSibling(child, people).map((item) => item.personId),
    ['father', 'mother'],
  );
  assert.deepEqual(
    suggestSpouseLinkForNewParent(child, 'father', people).map((item) => item.personId),
    ['mother'],
  );
});

test('suggested draft fields recalculate while explicit fields are preserved', () => {
  const initial = buildRelativeDraft({ selectedPerson: alexey, relationType: 'son', people });
  const explicit = markDraftFieldExplicit(initial, 'last_name', 'Выбранная');
  const recalculated = buildRelativeDraft({
    selectedPerson: alexey,
    relationType: 'daughter',
    people,
  });
  const merged = mergeRelativeDraft(explicit, recalculated);

  assert.equal(merged.person.last_name, 'Выбранная');
  assert.equal(merged.fieldSources.last_name, 'explicit');
  assert.equal(merged.person.patronymic, 'Алексеевна');
  assert.equal(merged.fieldSources.patronymic, 'suggested');
});

test('changing gender recalculates untouched suggestions for a generic parent', () => {
  const initial = buildRelativeDraft({ selectedPerson: child, relationType: 'parent', people });
  const changed = buildRelativeDraft({
    selectedPerson: child,
    relationType: 'parent',
    people,
    genderOverride: 'F',
  });
  const explicitGender = markDraftFieldExplicit(initial, 'gender', 'F');
  const merged = mergeRelativeDraft(explicitGender, changed);

  assert.equal(merged.person.gender, 'F');
  assert.equal(merged.person.last_name, 'Иванова');
  assert.equal(merged.person.maiden_name, 'Иванова');
  assert.equal(merged.fieldSources.last_name, 'suggested');
});

test('resetting an explicit field restores the current suggestion', () => {
  const suggested = buildRelativeDraft({
    selectedPerson: alexey,
    relationType: 'daughter',
    people,
  });
  const explicit = markDraftFieldExplicit(suggested, 'last_name', 'Другая');
  const reset = resetDraftFieldSuggestion(explicit, suggested, 'last_name');
  assert.equal(reset.person.last_name, 'Сапожникова');
  assert.equal(reset.fieldSources.last_name, 'suggested');
});
