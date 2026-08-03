import { formatPersonName } from './person-card-formatters.js';

const DRAFT_FIELDS = ['first_name', 'last_name', 'patronymic', 'gender', 'maiden_name'];

const INVARIABLE_SURNAMES = new Set(['шевченко', 'долгих', 'черных', 'седых', 'бондарь', 'коваль']);

const PATRONYMIC_EXCEPTIONS = new Map([
  ['юрий', ['Юрьевич', 'Юрьевна']],
  ['сергей', ['Сергеевич', 'Сергеевна']],
  ['алексей', ['Алексеевич', 'Алексеевна']],
  ['андрей', ['Андреевич', 'Андреевна']],
  ['дмитрий', ['Дмитриевич', 'Дмитриевна']],
  ['василий', ['Васильевич', 'Васильевна']],
  ['илья', ['Ильич', 'Ильинична']],
  ['павел', ['Павлович', 'Павловна']],
  ['лев', ['Львович', 'Львовна']],
  ['никита', ['Никитич', 'Никитична']],
  ['фома', ['Фомич', 'Фоминична']],
  ['лука', ['Лукич', 'Лукинична']],
]);

const FATHER_NAME_EXCEPTIONS = new Map(
  [...PATRONYMIC_EXCEPTIONS].flatMap(([name, forms]) =>
    forms.map((form) => [form.toLowerCase(), name]),
  ),
);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  const text = String(value).trim();
  return ['null', 'undefined'].includes(text.toLowerCase()) ? '' : text;
}

function cloneDraft(draft) {
  return typeof structuredClone === 'function'
    ? structuredClone(draft)
    : JSON.parse(JSON.stringify(draft));
}

function personData(person) {
  return person?.data && typeof person.data === 'object' ? person.data : person || {};
}

function personId(person) {
  return person?.id === null || person?.id === undefined ? '' : String(person.id);
}

function personGender(person) {
  const gender = cleanText(personData(person).gender).toUpperCase();
  return ['M', 'F'].includes(gender) ? gender : '';
}

function personPatronymic(person) {
  const data = personData(person);
  return cleanText(data.patronymic ?? data.middle_name);
}

function applyOriginalCase(source, value) {
  if (!source || !value) return value;
  if (source === source.toLowerCase()) return value.toLowerCase();
  if (source === source.toUpperCase()) return value.toUpperCase();
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

function replaceEnding(value, pattern, replacement) {
  const match = pattern.exec(value);
  if (!match) return null;
  const suffix = match[0];
  const nextSuffix = applyOriginalCase(suffix, replacement);
  return `${value.slice(0, -suffix.length)}${nextSuffix}`;
}

function transformRussianSurname(value, targetGender) {
  const surname = cleanText(value);
  if (!surname) return { value: '', reliable: true };

  const lower = surname.toLowerCase();
  if (INVARIABLE_SURNAMES.has(lower)) return { value: surname, reliable: true };

  if (targetGender === 'F') {
    if (/(?:ова|ева|ина)$/i.test(surname) || lower === 'толстая') {
      return { value: surname, reliable: true };
    }
    if (lower === 'толстой') {
      return { value: applyOriginalCase(surname, 'толстая'), reliable: true };
    }
    const transformed = replaceEnding(surname, /(?:ов|ев|ин)$/i, `${surname.slice(-2)}а`);
    if (transformed) return { value: transformed, reliable: true };
  }

  if (targetGender === 'M') {
    if (/(?:ов|ев|ин)$/i.test(surname) || lower === 'толстой') {
      return { value: surname, reliable: true };
    }
    if (lower === 'толстая') {
      return { value: applyOriginalCase(surname, 'толстой'), reliable: true };
    }
    const transformed = replaceEnding(surname, /(?:ова|ева|ина)$/i, surname.slice(-3, -1));
    if (transformed) return { value: transformed, reliable: true };
  }

  return { value: surname, reliable: false };
}

export function feminizeRussianSurname(value) {
  return transformRussianSurname(value, 'F').value;
}

export function masculinizeRussianSurname(value) {
  return transformRussianSurname(value, 'M').value;
}

export function buildRussianPatronymic(firstName, gender) {
  const name = cleanText(firstName);
  const normalisedGender = cleanText(gender).toUpperCase();
  if (!name || !['M', 'F'].includes(normalisedGender)) return '';

  const exception = PATRONYMIC_EXCEPTIONS.get(name.toLowerCase());
  if (exception) return applyOriginalCase(name, exception[normalisedGender === 'M' ? 0 : 1]);

  let result = '';
  if (/ей$/i.test(name)) {
    result = `${name.slice(0, -1)}${normalisedGender === 'M' ? 'евич' : 'евна'}`;
  } else if (/[бвгджзклмнпрстфхцчшщ]$/iu.test(name)) {
    result = `${name}${normalisedGender === 'M' ? 'ович' : 'овна'}`;
  }
  return result;
}

export function deriveFatherNameFromPatronymic(patronymic) {
  const value = cleanText(patronymic);
  if (!value) return '';
  const exception = FATHER_NAME_EXCEPTIONS.get(value.toLowerCase());
  if (exception) return applyOriginalCase(value, exception);
  return '';
}

function peopleById(people) {
  return new Map((Array.isArray(people) ? people : []).map((person) => [personId(person), person]));
}

function relatedPeople(selectedPerson, people, relation) {
  const ids = Array.isArray(selectedPerson?.rels?.[relation]) ? selectedPerson.rels[relation] : [];
  const index = peopleById(people);
  return [...new Set(ids.map(String))].map((id) => index.get(id)).filter(Boolean);
}

function link({ person, relation, kind, label, checked }) {
  const id = personId(person);
  return {
    id: `${kind}:${id}`,
    personId: id,
    relation,
    kind,
    label,
    checked: Boolean(checked),
  };
}

export function suggestSecondParent(selectedPerson, people) {
  const spouses = relatedPeople(selectedPerson, people, 'spouses');
  return spouses.map((person) =>
    link({
      person,
      relation: 'parent',
      kind: 'second-parent',
      label: `Добавить ${formatPersonName(person)} как второго родителя`,
      checked: spouses.length === 1,
    }),
  );
}

export function suggestSpouseLinkForNewParent(selectedPerson, relationType, people) {
  const expectedGender = relationType === 'father' ? 'F' : relationType === 'mother' ? 'M' : '';
  if (!expectedGender) return [];
  const candidates = relatedPeople(selectedPerson, people, 'parents').filter(
    (person) => personGender(person) === expectedGender,
  );
  return candidates.map((person) =>
    link({
      person,
      relation: 'spouse',
      kind: 'parent-spouse',
      label: `Связать с ${formatPersonName(person)} как супругом/супругой`,
      checked: candidates.length === 1,
    }),
  );
}

export function suggestSharedParentsForSibling(selectedPerson, people) {
  return relatedPeople(selectedPerson, people, 'parents').map((person) =>
    link({
      person,
      relation: 'parent',
      kind: 'shared-parent',
      label: formatPersonName(person),
      checked: true,
    }),
  );
}

export function getRelativeActionTypes(selectedPerson) {
  const spouseType =
    personGender(selectedPerson) === 'M'
      ? 'wife'
      : personGender(selectedPerson) === 'F'
        ? 'husband'
        : 'spouse';
  return ['father', 'mother', 'son', 'daughter', 'brother', 'sister', spouseType, 'parent'];
}

function emptyDraft() {
  return {
    person: Object.fromEntries(DRAFT_FIELDS.map((field) => [field, ''])),
    fieldSources: Object.fromEntries(DRAFT_FIELDS.map((field) => [field, 'empty'])),
    requiredLinks: [],
    suggestedLinks: [],
    warnings: [],
  };
}

function setDraftField(draft, field, value, source) {
  const text = cleanText(value);
  draft.person[field] = text;
  draft.fieldSources[field] = text || source === 'explicit' ? source : 'empty';
}

function addSurnameSuggestion(draft, surname, gender) {
  const transformed = transformRussianSurname(surname, gender);
  setDraftField(draft, 'last_name', transformed.value, transformed.value ? 'suggested' : 'empty');
  if (transformed.value && !transformed.reliable) {
    draft.warnings.push(
      `Форму фамилии «${transformed.value}» нельзя надёжно изменить: оставлено исходное значение.`,
    );
  }
}

function addMaidenSurnameSuggestion(draft, surname) {
  const transformed = transformRussianSurname(surname, 'F');
  setDraftField(draft, 'maiden_name', transformed.value, transformed.value ? 'suggested' : 'empty');
  if (transformed.value && !transformed.reliable) {
    draft.warnings.push(
      `Форму фамилии «${transformed.value}» нельзя надёжно изменить: оставлено исходное значение.`,
    );
  }
}

function addMotherSurnameSuggestion(draft, selectedPerson) {
  const data = personData(selectedPerson);
  const maidenName = cleanText(data.maiden_name);
  if (personGender(selectedPerson) !== 'F' || !maidenName) {
    const currentSurname = cleanText(data.last_name);
    const transformed = transformRussianSurname(currentSurname, 'F');
    if (transformed.reliable) {
      setDraftField(
        draft,
        'last_name',
        transformed.value,
        transformed.value ? 'suggested' : 'empty',
      );
    } else {
      setDraftField(draft, 'last_name', '', 'empty');
      if (currentSurname) {
        draft.warnings.push(
          `Фамилию матери нельзя надёжно вывести из «${currentSurname}»: оставьте поле пустым или укажите её вручную.`,
        );
      }
    }
    return;
  }
  setDraftField(draft, 'last_name', maidenName, 'suggested');
  setDraftField(draft, 'maiden_name', '', 'empty');
}

function requiredLink(selectedPerson, relation) {
  return {
    id: `required:${relation}:${personId(selectedPerson)}`,
    personId: personId(selectedPerson),
    relation,
    kind: 'required',
    label: `Обязательная связь с ${formatPersonName(selectedPerson)}`,
    required: true,
  };
}

export function buildRelativeDraft({
  selectedPerson,
  relationType,
  people,
  secondParentId,
  genderOverride,
} = {}) {
  const draft = emptyDraft();
  if (!selectedPerson || !personId(selectedPerson)) {
    draft.warnings.push('Не удалось определить выбранного человека.');
    return draft;
  }

  const type = cleanText(relationType).toLowerCase();
  const selectedData = personData(selectedPerson);
  const selectedSurname = cleanText(selectedData.last_name) || cleanText(selectedData.maiden_name);
  const allPeople = Array.isArray(people) ? people : [];
  let gender = '';

  if (type === 'father') gender = 'M';
  if (type === 'mother') gender = 'F';
  if (['son', 'brother', 'husband'].includes(type)) gender = 'M';
  if (['daughter', 'sister', 'wife'].includes(type)) gender = 'F';
  if (type === 'child' || type === 'sibling') gender = 'M';
  if (type === 'spouse') {
    gender =
      personGender(selectedPerson) === 'M' ? 'F' : personGender(selectedPerson) === 'F' ? 'M' : '';
  }
  if (genderOverride !== undefined && ['', 'M', 'F'].includes(genderOverride)) {
    gender = genderOverride;
  }
  if (gender || ['parent', 'spouse'].includes(type))
    setDraftField(draft, 'gender', gender, 'explicit');

  if (['father', 'mother', 'parent'].includes(type)) {
    draft.requiredLinks.push(requiredLink(selectedPerson, 'child'));
    if (type === 'mother' && personGender(selectedPerson) === 'F') {
      addMotherSurnameSuggestion(draft, selectedPerson);
    } else if (type !== 'parent' && gender) {
      addSurnameSuggestion(draft, selectedSurname, gender);
    }

    if (type === 'father') {
      const fatherName = deriveFatherNameFromPatronymic(personPatronymic(selectedPerson));
      setDraftField(draft, 'first_name', fatherName, fatherName ? 'suggested' : 'empty');
      if (personPatronymic(selectedPerson) && !fatherName) {
        draft.warnings.push('Имя отца нельзя надёжно вывести из отчества.');
      }
    }
    draft.suggestedLinks = suggestSpouseLinkForNewParent(selectedPerson, type, allPeople);
  } else if (['son', 'daughter', 'child'].includes(type)) {
    draft.requiredLinks.push(requiredLink(selectedPerson, 'parent'));
    if (gender === 'F') addMaidenSurnameSuggestion(draft, selectedSurname);
    else addSurnameSuggestion(draft, selectedSurname, gender);
    draft.suggestedLinks = suggestSecondParent(selectedPerson, allPeople);

    let patronymicSource = null;
    if (personGender(selectedPerson) === 'M') patronymicSource = selectedPerson;
    if (personGender(selectedPerson) === 'F') {
      const maleSpouses = relatedPeople(selectedPerson, allPeople, 'spouses').filter(
        (person) => personGender(person) === 'M',
      );
      patronymicSource = secondParentId
        ? maleSpouses.find((person) => personId(person) === String(secondParentId))
        : maleSpouses.length === 1
          ? maleSpouses[0]
          : null;
    }
    if (patronymicSource) {
      const fatherName = cleanText(personData(patronymicSource).first_name);
      const patronymic = buildRussianPatronymic(fatherName, gender);
      setDraftField(draft, 'patronymic', patronymic, patronymic ? 'suggested' : 'empty');
      if (fatherName && !patronymic) {
        draft.warnings.push(`Отчество нельзя надёжно построить от имени «${fatherName}».`);
      }
    }
  } else if (['brother', 'sister', 'sibling'].includes(type)) {
    draft.requiredLinks.push(requiredLink(selectedPerson, 'sibling'));
    if (gender === 'F') addMaidenSurnameSuggestion(draft, selectedSurname);
    else addSurnameSuggestion(draft, selectedSurname, gender);
    setDraftField(
      draft,
      'patronymic',
      personPatronymic(selectedPerson),
      personPatronymic(selectedPerson) ? 'suggested' : 'empty',
    );
    draft.suggestedLinks = suggestSharedParentsForSibling(selectedPerson, allPeople);
    if (!draft.suggestedLinks.length) {
      draft.warnings.push('Для связи брата или сестры нужен хотя бы один общий родитель.');
    }
  } else if (['husband', 'wife', 'spouse'].includes(type)) {
    draft.requiredLinks.push(requiredLink(selectedPerson, 'spouse'));
    if (gender === 'F' && personGender(selectedPerson) === 'M') {
      addSurnameSuggestion(draft, selectedSurname, 'F');
    }
  } else {
    draft.warnings.push('Этот тип родства не поддерживается.');
  }

  draft.warnings = [...new Set(draft.warnings)];
  return draft;
}

export function markDraftFieldExplicit(draft, field, value) {
  if (!DRAFT_FIELDS.includes(field)) return cloneDraft(draft);
  const next = cloneDraft(draft);
  setDraftField(next, field, value, 'explicit');
  return next;
}

export function mergeRelativeDraft(currentDraft, nextDraft) {
  const merged = cloneDraft(nextDraft);
  for (const field of DRAFT_FIELDS) {
    if (currentDraft?.fieldSources?.[field] === 'explicit') {
      merged.person[field] = currentDraft.person[field];
      merged.fieldSources[field] = 'explicit';
    }
  }
  const checkedById = new Map(
    (currentDraft?.suggestedLinks || []).map((item) => [item.id, Boolean(item.checked)]),
  );
  merged.suggestedLinks = merged.suggestedLinks.map((item) => ({
    ...item,
    checked: checkedById.has(item.id) ? checkedById.get(item.id) : item.checked,
  }));
  return merged;
}

export function resetDraftFieldSuggestion(draft, freshDraft, field) {
  if (!DRAFT_FIELDS.includes(field)) return cloneDraft(draft);
  const next = cloneDraft(draft);
  next.person[field] = freshDraft.person[field];
  next.fieldSources[field] = freshDraft.fieldSources[field];
  return next;
}
