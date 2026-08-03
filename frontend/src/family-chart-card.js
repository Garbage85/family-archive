import {
  formatPersonCardBirthDate,
  formatPersonCardLines,
  formatPersonName,
} from './person-card-formatters.js';

function escapeCardText(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function displayLabel(value) {
  const label = String(value || '').trim();
  return label ? label[0].toLocaleUpperCase('ru-RU') + label.slice(1) : '';
}

function cardPlaceholder() {
  return `<div class="family-archive-card-avatar person-icon" aria-hidden="true">
    <svg viewBox="0 0 64 64" focusable="false" aria-hidden="true">
      <circle cx="32" cy="23" r="12"></circle>
      <path d="M12 58c1-13 9-20 20-20s19 7 20 20"></path>
    </svg>
  </div>`;
}

export function createFamilyChartCardHtml(person, relationship) {
  const { surname, givenName } = formatPersonCardLines(person);
  const birthDate = formatPersonCardBirthDate(person);
  const fullName = formatPersonName(person);
  const kinship = displayLabel(relationship?.shortLabel || relationship?.label);
  const fullKinship = displayLabel(relationship?.label || relationship?.shortLabel);
  const avatar = String(person?.data?.avatar || '').trim();
  const cardLabel = [fullName, fullKinship ? `Родство: ${fullKinship}` : '']
    .filter(Boolean)
    .join('. ');
  const image = avatar
    ? `<img class="family-archive-card-avatar" src="${escapeCardText(avatar)}" alt="Фотография: ${escapeCardText(fullName)}" />`
    : cardPlaceholder();
  return `<div class="card-inner family-archive-card" title="${escapeCardText(cardLabel)}" aria-label="${escapeCardText(cardLabel)}">
    ${kinship ? `<div class="kinship-card-label" data-kinship-card-label title="${escapeCardText(fullKinship)}" aria-label="Родство: ${escapeCardText(fullKinship)}">${escapeCardText(kinship)}</div>` : ''}
    ${image}
    ${surname ? `<div class="family-archive-card-surname" title="${escapeCardText(surname)}" aria-label="${escapeCardText(surname)}">${escapeCardText(surname)}</div>` : ''}
    ${givenName ? `<div class="family-archive-card-given-name">${escapeCardText(givenName)}</div>` : ''}
    ${birthDate ? `<div class="family-archive-card-birth-date">${escapeCardText(birthDate)}</div>` : ''}
  </div>`;
}
