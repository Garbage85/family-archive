import * as f3 from 'family-chart';
import 'family-chart/styles/family-chart.css';
import { createFamilyChartCardHtml } from '../family-chart-card.js';
import { formatPersonName } from '../person-card-formatters.js';
import { cloneTree, normaliseTree } from '../tree-utils.js';
import { layoutFullFamilyTree, prepareFamilyChartData } from './family-chart-data.js';

const CARD_WIDTH = 184;
const CARD_HEIGHT = 170;
const CARD_X_SPACING = 236;
const CARD_Y_SPACING = 224;

function comparePersonIds(left, right) {
  const a = String(left.id);
  const b = String(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortSpouseIds(person) {
  person.rels.spouses?.sort((left, right) => {
    const a = String(left);
    const b = String(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export class FamilyTreeChart {
  constructor(containerSelector) {
    this.containerSelector = containerSelector;
    this.chart = null;
    this.card = null;
    this.data = [];
    this.chartData = [];
    this.selectedPersonId = null;
    this.rootPersonId = null;
    this.kinships = new Map();
    this.orientation = 'vertical';
    this.onSelect = () => {};
    this.onRootSelect = () => {};
    this.onKinshipClick = () => {};
  }

  mount(
    rawData,
    { onSelect, onRootSelect, onKinshipClick, rootPersonId = null, kinships = new Map() } = {},
  ) {
    this.destroy();
    this.data = normaliseTree(rawData);
    this.chartData = prepareFamilyChartData(this.data);
    this.onSelect = onSelect || (() => {});
    this.onRootSelect = onRootSelect || (() => {});
    this.onKinshipClick = onKinshipClick || (() => {});
    this.kinships = kinships instanceof Map ? kinships : new Map();
    this.rootPersonId = this.resolvePersonId(rootPersonId);

    const host = document.querySelector(this.containerSelector);
    const searchHost = document.querySelector('#search-host');
    host.innerHTML = '';
    if (searchHost) searchHost.innerHTML = '';

    this.chart = f3
      .createChart(this.containerSelector, cloneTree(this.chartData))
      .setTransitionTime(300)
      .setAncestryDepth(8)
      .setProgenyDepth(8)
      .setShowSiblingsOfMain(true)
      .setSingleParentEmptyCard(false)
      .setCardXSpacing(CARD_X_SPACING)
      .setCardYSpacing(CARD_Y_SPACING)
      .setSortChildrenFunction(comparePersonIds)
      .setSortSpousesFunction(sortSpouseIds)
      .setBeforeUpdate(() => {
        layoutFullFamilyTree(this.chart.store.getTree(), this.chartData, this.rootPersonId, {
          nodeSeparation: CARD_X_SPACING,
          levelSeparation: CARD_Y_SPACING,
          isHorizontal: this.orientation === 'horizontal',
        });
      });

    this.chart.updateMainId(this.rootPersonId);

    if (this.orientation === 'horizontal') this.chart.setOrientationHorizontal();

    const adapter = this;
    this.card = this.chart
      .setCardHtml()
      .setCardImageField('avatar')
      .setCardDim({ width: CARD_WIDTH, height: CARD_HEIGHT })
      .setCardInnerHtmlCreator((treeDatum) =>
        createFamilyChartCardHtml(
          treeDatum.data,
          this.kinships.get(String(treeDatum.data?.id || '')),
        ),
      )
      .setOnCardClick((_event, treeDatum) => {
        const person = this.extractPerson(treeDatum);
        if (!person) return;
        this.select(person.id);
      })
      .setOnCardUpdate(function setKinshipCardState(treeDatum) {
        const personId = String(treeDatum?.data?.id || '');
        const relationship = adapter.kinships.get(personId);
        const card = this.querySelector('.card');
        const inner = this.querySelector('.card-inner');
        const label = this.querySelector('[data-kinship-card-label]');
        const isCenter = personId === adapter.rootPersonId;
        card?.classList.toggle('kinship-center-card', isCenter);
        inner?.classList.toggle('kinship-center-card-inner', isCenter);
        if (!relationship || !label) return;
        label.setAttribute('role', 'button');
        label.tabIndex = 0;
        const open = (event) => {
          event.stopPropagation();
          adapter.onKinshipClick(personId);
        };
        label.addEventListener('click', open);
        label.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          open(event);
        });
      });

    this.chart.setPersonDropdown((datum) => formatPersonName(datum), {
      cont: searchHost,
      placeholder: 'Найти человека',
      onSelect: (id) => {
        this.onRootSelect(String(id));
      },
    });

    this.chart.updateTree({ initial: true, tree_position: 'fit' });
  }

  resolvePersonId(personId) {
    const requested = String(personId ?? '');
    return this.data.some((person) => person.id === requested) ? requested : this.data[0]?.id || '';
  }

  extractPerson(treeDatum) {
    if (treeDatum?.data?.id && treeDatum?.data?.data) return treeDatum.data;
    if (treeDatum?.id && treeDatum?.data) return treeDatum;
    return null;
  }

  select(id) {
    this.selectedPersonId = id;
    this.onSelect(id);
  }

  getData() {
    return cloneTree(this.data);
  }

  updateData(rawData, { fit = false, focusId = null, rootPersonId, kinships } = {}) {
    this.data = normaliseTree(rawData);
    this.chartData = prepareFamilyChartData(this.data);
    if (kinships instanceof Map) this.kinships = kinships;
    this.rootPersonId = this.resolvePersonId(rootPersonId ?? this.rootPersonId);
    this.chart.updateData(cloneTree(this.chartData));
    this.chart.updateMainId(this.rootPersonId);
    this.chart.updateTree({ tree_position: fit ? 'fit' : 'inherit' });
    if (focusId) this.selectedPersonId = String(focusId);
  }

  focus(id) {
    if (!this.chart || !id) return;
    this.selectedPersonId = String(id);
  }

  setRootPerson(personId, { fit = true, kinships } = {}) {
    if (!this.chart) return false;
    const nextId = this.resolvePersonId(personId);
    if (!nextId) return false;
    if (kinships instanceof Map) this.kinships = kinships;
    this.rootPersonId = nextId;
    this.chart.updateMainId(nextId).updateTree({
      tree_position: fit ? 'main_to_middle' : 'inherit',
    });
    return true;
  }

  setKinships(kinships, { fit = false } = {}) {
    this.kinships = kinships instanceof Map ? kinships : new Map();
    this.chart?.updateTree({ tree_position: fit ? 'fit' : 'inherit' });
  }

  openPersonSearch() {
    const input = document.querySelector('#search-host input');
    input?.focus();
    input?.click();
  }

  fit() {
    this.chart?.updateTree({ tree_position: 'fit' });
  }

  toggleOrientation() {
    if (!this.chart) return this.orientation;
    if (this.orientation === 'vertical') {
      this.chart.setOrientationHorizontal();
      this.orientation = 'horizontal';
    } else {
      this.chart.setOrientationVertical();
      this.orientation = 'vertical';
    }
    this.chart.updateTree({ tree_position: 'fit' });
    return this.orientation;
  }

  destroy() {
    if (this.chart?.personSearch) this.chart.unSetPersonSearch();
    const host = document.querySelector(this.containerSelector);
    const searchHost = document.querySelector('#search-host');
    if (host) host.innerHTML = '';
    if (searchHost) searchHost.innerHTML = '';
    this.chart = null;
    this.card = null;
    this.selectedPersonId = null;
  }
}
