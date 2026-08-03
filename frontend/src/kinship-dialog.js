import { formatKinshipKind, formatPathStep } from './kinship-formatter-ru.js';
import { formatPersonName } from './person-card-formatters.js';

function year(value) {
  const match = /^(\d{4})-/.exec(String(value || ''));
  return match?.[1] || '';
}

function personLabel(person, { dates = false } = {}) {
  if (!person) return 'Неизвестный человек';
  const name = formatPersonName(person);
  if (!dates) return name;
  const birth = year(person?.data?.birth_date);
  const death = year(person?.data?.death_date);
  const lifespan = birth || death ? `${birth || '…'}–${death || '…'}` : '';
  return lifespan ? `${name}, ${lifespan}` : name;
}

function pathModel(path, peopleById) {
  if (!path) return null;
  return {
    people: path.personIds.map((id) => {
      const person = peopleById.get(String(id));
      return { id: String(id), label: personLabel(person) };
    }),
    steps: path.steps.map((step) => {
      const next = peopleById.get(String(step.toId));
      return {
        ...step,
        label: formatPathStep(step.type, String(next?.data?.gender || '').toUpperCase()),
      };
    }),
  };
}

export function buildKinshipDialogModel(people, relationship) {
  if (!relationship) return null;
  const peopleById = new Map(
    (Array.isArray(people) ? people : []).map((person) => [String(person?.id), person]),
  );
  const commonAncestor =
    relationship.distanceFromCenter > 0 && relationship.distanceFromTarget > 0
      ? relationship.commonAncestorIds.map((id) => peopleById.get(String(id))).find(Boolean)
      : null;
  return {
    center: personLabel(peopleById.get(String(relationship.centerId))),
    target: personLabel(peopleById.get(String(relationship.targetId))),
    label: relationship.label,
    kindLabel: formatKinshipKind(relationship.kind),
    commonAncestor: commonAncestor ? personLabel(commonAncestor, { dates: true }) : '',
    primaryPath: pathModel(relationship.primaryPath, peopleById),
    alternativePaths: relationship.alternativePaths
      .slice(0, 2)
      .map((path) => pathModel(path, peopleById)),
    additionalRelations: relationship.additionalRelations || [],
  };
}

function appendFact(list, label, value) {
  const wrapper = document.createElement('div');
  const term = document.createElement('dt');
  const description = document.createElement('dd');
  term.textContent = label;
  description.textContent = value;
  wrapper.append(term, description);
  list.append(wrapper);
}

function renderPath(model) {
  const chain = document.createElement('ol');
  chain.className = 'kinship-chain';
  for (let index = 0; index < model.people.length; index += 1) {
    const item = document.createElement('li');
    item.className = 'kinship-chain-person';
    item.textContent = model.people[index].label;
    chain.append(item);
    const step = model.steps[index];
    if (step) {
      const relation = document.createElement('li');
      relation.className = 'kinship-chain-step';
      relation.textContent = `↓ ${step.label}`;
      chain.append(relation);
    }
  }
  return chain;
}

export class KinshipDialog {
  constructor(dialog) {
    if (!dialog) throw new Error('Kinship dialog element is required.');
    this.dialog = dialog;
    this.content = dialog.querySelector('[data-kinship-content]');
    this.alternatives = dialog.querySelector('[data-kinship-alternatives]');
    this.toggle = dialog.querySelector('[data-kinship-toggle]');
    dialog.querySelector('[data-kinship-close]').addEventListener('click', () => dialog.close());
    this.toggle.addEventListener('click', () => {
      const hidden = this.alternatives.classList.toggle('hidden');
      this.toggle.setAttribute('aria-expanded', String(!hidden));
      this.toggle.textContent = hidden
        ? `Ещё ${this.alternatives.children.length} связей`
        : 'Скрыть дополнительные связи';
    });
  }

  open(people, relationship) {
    const model = buildKinshipDialogModel(people, relationship);
    if (!model) return;
    this.content.replaceChildren();
    const facts = document.createElement('dl');
    facts.className = 'kinship-dialog-facts';
    appendFact(facts, 'Центральный человек', model.center);
    appendFact(facts, 'Выбранный человек', model.target);
    appendFact(facts, 'Степень родства', model.label);
    appendFact(facts, 'Тип', model.kindLabel);
    if (model.commonAncestor) appendFact(facts, 'Общий предок', model.commonAncestor);
    for (const relation of model.additionalRelations) {
      appendFact(facts, 'Дополнительная связь', relation.label);
    }
    this.content.append(facts);
    if (model.primaryPath) {
      const heading = document.createElement('h3');
      heading.textContent = 'Основная цепочка';
      this.content.append(heading, renderPath(model.primaryPath));
    }

    this.alternatives.replaceChildren();
    this.alternatives.classList.add('hidden');
    model.alternativePaths.forEach((path, index) => {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = `Дополнительная связь ${index + 1}`;
      section.append(heading, renderPath(path));
      this.alternatives.append(section);
    });
    this.toggle.classList.toggle('hidden', model.alternativePaths.length === 0);
    this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.textContent = `Ещё ${model.alternativePaths.length} связей`;
    if (!this.dialog.open) this.dialog.showModal();
  }
}
