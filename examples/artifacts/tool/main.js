import '../shared/style.css';
const state = await window.spellcast.ready;
const controls = Object.fromEntries(['area', 'rain', 'efficiency', 'capacity'].map(key => [key, document.querySelector('#' + key)]));
const note = document.querySelector('#note'); note.value = typeof state.note === 'string' ? state.note : '';
for (const [key, control] of Object.entries(controls)) if (Number.isFinite(state[key])) control.value = String(Math.max(Number(control.min), Math.min(Number(control.max), state[key])));
function calculate(area, rain, efficiency, capacity) { const collected = area * rain * efficiency / 100; return { collected, stored: Math.min(capacity, collected), overflow: Math.max(0, collected - capacity) }; }
if (calculate(80, 40, 75, 5000).collected !== 2400 || calculate(200, 150, 100, 5000).overflow !== 25000 || calculate(80, 0, 75, 5000).collected !== 0) throw new Error('Water volume checks failed.');
const values = () => Object.fromEntries(Object.entries(controls).map(([key, control]) => [key, Number(control.value)]));
function save() { window.spellcast.setState({ ...values(), note: note.value }); }
function draw() {
  const v = values(), result = calculate(v.area, v.rain, v.efficiency, v.capacity), height = result.stored / v.capacity * 150;
  document.querySelector('#collected').textContent = result.collected.toLocaleString(); document.querySelector('#overflow').textContent = result.overflow.toLocaleString();
  for (const [key, unit] of [['area', ' m²'], ['rain', ' mm'], ['efficiency', '%'], ['capacity', ' L']]) document.querySelector('#' + key + '-value').textContent = v[key] + unit;
  document.querySelector('#water-level').setAttribute('height', String(height)); document.querySelector('#water-level').setAttribute('y', String(278 - height));
  document.querySelector('#explanation').textContent = '储水比例为 ' + (result.stored / v.capacity * 100).toFixed(1) + '%。' + (result.overflow ? '收集量超过容量，额外水量需要去向。' : '储水箱尚有 ' + (v.capacity - result.stored).toLocaleString() + ' L 空间。');
}
for (const control of Object.values(controls)) control.oninput = () => { save(); draw(); }; note.oninput = save;
for (const id of ['roof', 'tank']) { const element = document.querySelector('#' + id), choose = () => { window.spellcast.setState({ ...values(), note: note.value, selection: { ids: [id], label: id === 'roof' ? '收集屋顶' : '储水箱' } }); }; element.onclick = choose; element.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } }; }
function download(text, name, type) { const url = URL.createObjectURL(new Blob([text], { type })), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
document.querySelector('#csv').onclick = () => { const v = values(), result = calculate(v.area, v.rain, v.efficiency, v.capacity); download('parameter,value\n' + Object.entries({ ...v, ...result }).map(([key, value]) => key + ',' + value).join('\n'), 'rainwater-parameters.csv', 'text/csv'); };
document.querySelector('#svg').onclick = () => download(document.querySelector('#diagram').outerHTML, 'rainwater-diagram.svg', 'image/svg+xml');
window.spellcast.onRestore(s => { for (const [key, control] of Object.entries(controls)) if (Number.isFinite(s[key])) control.value = String(Math.max(Number(control.min), Math.min(Number(control.max), s[key]))); note.value = typeof s.note === 'string' ? s.note : ''; draw(); }); draw();
