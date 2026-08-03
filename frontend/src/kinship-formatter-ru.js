const COUSIN_PREFIXES = {
  2: ['двоюродный', 'двоюродная'],
  3: ['троюродный', 'троюродная'],
  4: ['четвероюродный', 'четвероюродная'],
  5: ['пятиюродный', 'пятиюродная'],
  6: ['шестиюродный', 'шестиюродная'],
  7: ['семиюродный', 'семиюродная'],
  8: ['восьмиюродный', 'восьмиюродная'],
  9: ['девятиюродный', 'девятиюродная'],
  10: ['десятиюродный', 'десятиюродная'],
};

function genderIndex(gender) {
  return gender === 'F' ? 1 : 0;
}

function gendered(gender, male, female, unknown) {
  return gender === 'M' ? male : gender === 'F' ? female : unknown;
}

function cousinPrefix(degree, gender) {
  if (degree <= 1) return '';
  const known = COUSIN_PREFIXES[degree];
  return known ? known[genderIndex(gender)] : `${degree}-юродн${gender === 'F' ? 'ая' : 'ый'}`;
}

function withCousinPrefix(term, degree, gender) {
  const prefix = cousinPrefix(degree, gender);
  return prefix ? `${prefix} ${term}` : term;
}

function directAncestorLabel(distance, gender) {
  if (distance === 1) return gendered(gender, 'отец', 'мать', 'родитель');
  if (distance === 2) return gendered(gender, 'дедушка', 'бабушка', 'прародитель');
  if (distance <= 8) {
    const prefix = 'пра'.repeat(distance - 2);
    return gendered(
      gender,
      `${prefix}дедушка`,
      `${prefix}бабушка`,
      `предок в ${distance}-м поколении`,
    );
  }
  return `предок в ${distance}-м поколении по прямой линии`;
}

function directDescendantLabel(distance, gender) {
  if (distance === 1) return gendered(gender, 'сын', 'дочь', 'ребёнок');
  if (distance === 2) return gendered(gender, 'внук', 'внучка', 'внук/внучка');
  if (distance <= 8) {
    const prefix = 'пра'.repeat(distance - 2);
    return gendered(
      gender,
      `${prefix}внук`,
      `${prefix}внучка`,
      `потомок в ${distance}-м поколении`,
    );
  }
  return `потомок в ${distance}-м поколении по прямой линии`;
}

function sameGenerationLabel(distance, gender) {
  const base = gendered(gender, 'брат', 'сестра', 'сиблинг');
  return withCousinPrefix(base, distance, gender);
}

function olderLateralLabel(a, generationDelta, gender) {
  let base;
  if (generationDelta === 1) base = gendered(gender, 'дядя', 'тётя', 'дядя/тётя');
  else if (generationDelta === 2) base = gendered(gender, 'дед', 'бабушка', 'дед/бабушка');
  else if (generationDelta <= 7) {
    const prefix = 'пра'.repeat(generationDelta - 2);
    base = gendered(gender, `${prefix}дед`, `${prefix}бабушка`, `старший родственник`);
  } else {
    base = gendered(
      gender,
      `родственник на ${generationDelta} поколений старше`,
      `родственница на ${generationDelta} поколений старше`,
      `родственник на ${generationDelta} поколений старше`,
    );
  }
  return withCousinPrefix(base, a - 1, gender);
}

function youngerLateralLabel(a, generationDelta, gender) {
  const gap = Math.abs(generationDelta);
  let base;
  if (gap === 1) base = gendered(gender, 'племянник', 'племянница', 'племянник/племянница');
  else if (gap === 2) {
    base = gendered(
      gender,
      'внучатый племянник',
      'внучатая племянница',
      'внучатый племянник/племянница',
    );
  } else if (gap === 3) {
    base = gendered(
      gender,
      'правнучатый племянник',
      'правнучатая племянница',
      'правнучатый племянник/племянница',
    );
  } else {
    base = gendered(
      gender,
      `родственник на ${gap} поколений младше`,
      `родственница на ${gap} поколений младше`,
      `родственник на ${gap} поколений младше`,
    );
  }
  return withCousinPrefix(base, a, gender);
}

/**
 * Formats a relationship descriptor produced by the graph engine in Russian.
 * The formatter contains no graph or DOM logic.
 */
export function formatKinshipLabel({ kind, relationType, gender, a = 0, b = 0 }) {
  if (kind === 'self') return 'Центр дерева';
  if (kind === 'spouse') return gendered(gender, 'супруг', 'супруга', 'супруг(а)');
  if (kind === 'unrelated') return 'Родство не найдено';
  if (kind !== 'blood') return 'Родство не найдено';

  if (relationType === 'ancestor') return directAncestorLabel(a, gender);
  if (relationType === 'descendant') return directDescendantLabel(b, gender);
  if (a === b) return sameGenerationLabel(a, gender);
  const generationDelta = a - b;
  return generationDelta > 0
    ? olderLateralLabel(a, generationDelta, gender)
    : youngerLateralLabel(a, generationDelta, gender);
}

export function formatKinshipShortLabel(descriptor) {
  return formatKinshipLabel(descriptor);
}

export function formatPathStep(type, gender) {
  if (type === 'parent') return gendered(gender, 'отец', 'мать', 'родитель');
  if (type === 'child') return gendered(gender, 'сын', 'дочь', 'ребёнок');
  if (type === 'spouse') return gendered(gender, 'супруг', 'супруга', 'супруг(а)');
  return 'родственник';
}

export function formatKinshipKind(kind) {
  if (kind === 'blood') return 'Кровное родство';
  if (kind === 'spouse') return 'Супруги';
  if (kind === 'self') return 'Центр дерева';
  return 'Родство не найдено';
}
