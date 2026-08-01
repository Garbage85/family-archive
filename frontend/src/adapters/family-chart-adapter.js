import * as f3 from 'family-chart';
import 'family-chart/styles/family-chart.css';
import { cloneTree, normaliseTree, personName } from '../tree-utils.js';

export class FamilyTreeChart {
  constructor(containerSelector) {
    this.containerSelector = containerSelector;
    this.chart = null;
    this.card = null;
    this.data = [];
    this.selectedPersonId = null;
    this.orientation = 'vertical';
    this.onSelect = () => {};
  }

  mount(rawData, { onSelect } = {}) {
    this.destroy();
    this.data = normaliseTree(rawData);
    this.onSelect = onSelect || (() => {});

    const host = document.querySelector(this.containerSelector);
    const searchHost = document.querySelector('#search-host');
    host.innerHTML = '';
    if (searchHost) searchHost.innerHTML = '';

    this.chart = f3
      .createChart(this.containerSelector, cloneTree(this.data))
      .setTransitionTime(300)
      .setAncestryDepth(8)
      .setProgenyDepth(8)
      .setShowSiblingsOfMain(true)
      .setSingleParentEmptyCard(false);

    if (this.orientation === 'horizontal') this.chart.setOrientationHorizontal();

    this.card = this.chart
      .setCardHtml()
      .setStyle('imageCircleRect')
      .setCardImageField('avatar')
      .setCardDisplay([['first_name', 'last_name'], ['middle_name'], ['birth_date', 'death_date']])
      .setOnCardClick((_event, treeDatum) => {
        const person = this.extractPerson(treeDatum);
        if (!person) return;
        this.select(person.id);
      });

    this.chart.setPersonDropdown((datum) => personName(datum), {
      cont: searchHost,
      placeholder: 'Найти человека',
      onSelect: (id) => {
        this.select(id);
        this.chart.updateMainId(id).updateTree({ tree_position: 'main_to_middle' });
      },
    });

    this.chart.updateTree({ initial: true, tree_position: 'fit' });
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

  updateData(rawData, { fit = false, focusId = null } = {}) {
    this.data = normaliseTree(rawData);
    this.chart.updateData(cloneTree(this.data));
    if (focusId) this.chart.updateMainId(focusId);
    this.chart.updateTree({ tree_position: fit ? 'fit' : 'inherit' });
  }

  focus(id) {
    if (!this.chart || !id) return;
    this.chart.updateMainId(id).updateTree({ tree_position: 'main_to_middle' });
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
    this.chart = null;
    this.card = null;
    this.selectedPersonId = null;
  }
}
