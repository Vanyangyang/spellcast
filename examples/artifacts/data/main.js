import '../shared/style.css';
import * as echarts from 'echarts';
import { TabulatorFull as Tabulator } from 'tabulator-tables';
import 'tabulator-tables/dist/css/tabulator_simple.min.css';
const rows = [
  { id: 'courtyard', name: '庭院公寓', kind: '住宅', water: 184, people: 92 },
  { id: 'river', name: '河岸社区', kind: '住宅', water: 256, people: 128 },
  { id: 'library', name: '城市图书馆', kind: '公共', water: 112, people: 350 },
  { id: 'school', name: '青禾小学', kind: '公共', water: 238, people: 420 },
  { id: 'terrace', name: '台地住宅', kind: '住宅', water: 168, people: 84 },
  { id: 'workshop', name: '共享工坊', kind: '公共', water: 142, people: 110 },
];
if (rows.reduce((sum, row) => sum + row.water, 0) !== 1100) throw new Error('Sample total changed.');
const saved = await window.spellcast.ready, kind = document.querySelector('#kind');
kind.value = ['all', '住宅', '公共'].includes(saved.kind) ? saved.kind : 'all';
let visible = [], selected = Array.isArray(saved.selected) ? saved.selected : [], syncing = false;
const chart = echarts.init(document.querySelector('#chart'), null, { renderer: 'svg' });
const table = new Tabulator('#table', { data: rows, index: 'id', layout: 'fitColumns', height: 260, selectableRows: true,
  initialSort: Array.isArray(saved.sort) ? saved.sort : [{ column: 'water', dir: 'desc' }],
  columns: [{ title: '建筑', field: 'name', minWidth: 130 }, { title: '类型', field: 'kind', width: 88 },
    { title: '用水 / m³', field: 'water', sorter: 'number', minWidth: 115 }, { title: '使用人数', field: 'people', sorter: 'number', minWidth: 100 }] });
function choose(ids, fromTable = false) {
  selected = ids.filter(id => visible.some(row => row.id === id));
  window.spellcast.setState({ kind: kind.value, selected, selection: { ids: selected, label: selected.map(id => rows.find(row => row.id === id).name).join('、') || '当前筛选范围' } });
  if (!fromTable) { syncing = true; table.deselectRow(); table.selectRow(selected); syncing = false; }
  paintChart();
}
function paintChart() {
  chart.setOption({ color: ['#398575'], animation: false, grid: { left: 54, right: 24, top: 48, bottom: 50 },
    tooltip: { trigger: 'axis' }, toolbox: { feature: { brush: { type: ['rect', 'clear'] } } }, brush: { xAxisIndex: 0, brushMode: 'multiple' },
    xAxis: { type: 'category', data: visible.map(row => row.name), axisLabel: { color: '#63748a', interval: 0 } },
    yAxis: { type: 'value', name: 'm³', splitLine: { lineStyle: { color: '#e9eef3' } } },
    series: [{ type: 'bar', barMaxWidth: 62, data: visible.map(row => ({ value: row.water, itemStyle: { color: selected.includes(row.id) ? '#d5a657' : '#398575', borderRadius: [7, 7, 0, 0] } })) }] });
  document.querySelector('#selection').textContent = selected.length ? '当前选择：' + selected.map(id => rows.find(row => row.id === id).name).join('、') : '点击图中的建筑或选择数据行，继续讨论同一对象。';
}
function filter() {
  visible = rows.filter(row => kind.value === 'all' || row.kind === kind.value);
  selected = selected.filter(id => visible.some(row => row.id === id));
  if (kind.value === 'all') table.clearFilter(); else table.setFilter('kind', '=', kind.value);
  document.querySelector('#total').textContent = String(visible.reduce((sum, row) => sum + row.water, 0));
  choose(selected);
}
table.on('tableBuilt', () => { filter(); });
table.on('rowSelectionChanged', data => { if (!syncing) choose(data.map(row => row.id), true); });
table.on('dataSorted', sort => { window.spellcast.setState({ sort: sort.map(item => ({ column: item.field, dir: item.dir })) }); });
chart.on('click', event => { if (event.componentType === 'series' && visible[event.dataIndex]) choose([visible[event.dataIndex].id]); });
chart.on('brushSelected', event => { const list = event.batch?.[0]?.selected?.[0]?.dataIndex; if (list) choose(list.map(i => visible[i]?.id).filter(Boolean)); });
kind.onchange = filter;
const resize = new ResizeObserver(() => chart.resize()); resize.observe(document.querySelector('#chart'));
window.spellcast.onRestore(state => { kind.value = ['all', '住宅', '公共'].includes(state.kind) ? state.kind : 'all'; selected = state.selected ?? []; filter(); });
addEventListener('pagehide', () => { resize.disconnect(); chart.dispose(); table.destroy(); });
