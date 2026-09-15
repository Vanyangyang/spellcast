import '../shared/style.css';
const saved = await window.spellcast.ready;
const view = document.querySelector('#view'), split = document.querySelector('#split'), target = document.querySelector('#target'), image = document.querySelector('#image');
view.value = ['compare', 'original', 'amber'].includes(saved.view) ? saved.view : 'compare';
split.value = String(Number.isFinite(saved.split) ? Math.min(100, Math.max(0, saved.split)) : 50);
target.value = saved.target === 'original' ? 'original' : 'amber';
let region = saved.region ?? null, start = null, beforeDrag = null;
const fields = Object.fromEntries(['x', 'y', 'w', 'h'].map(id => [id, document.querySelector('#' + id)]));
function valid(r) { return r && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(r[k])) && r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0 && r.x + r.width <= 1.001 && r.y + r.height <= 1.001; }
if (!valid(region)) region = null;
function syncFields(draft) {
  const numbers = region ? [region.x, region.y, region.width, region.height] : [];
  Object.entries(fields).forEach(([id, field], index) => { field.value = draft && typeof draft[id] === 'string' ? draft[id] : numbers.length ? (numbers[index] * 100).toFixed(1) : ''; });
}
syncFields(saved.region_draft);
const asset = () => 'assets/pavilion-' + (target.value === 'original' ? 'original' : 'amber') + '.png';
function paint() {
  const compare = view.value === 'compare'; document.querySelector('#comparison').hidden = !compare; document.querySelector('#target-label').hidden = !compare;
  if (!compare) target.value = view.value;
  const amount = view.value === 'original' ? 0 : view.value === 'amber' ? 100 : Number(split.value);
  document.querySelector('.after').style.clipPath = 'inset(0 ' + (100 - amount) + '% 0 0)';
  const line = document.querySelector('#divider'); line.style.display = compare ? '' : 'none'; line.setAttribute('x1', String(amount * 10)); line.setAttribute('x2', String(amount * 10));
  const rect = document.querySelector('#region'); rect.style.display = region ? '' : 'none';
  if (region) for (const [key, value] of Object.entries(region)) rect.setAttribute(key, String(value * 1000));
  document.querySelector('#region-info').textContent = region ? (target.value === 'original' ? '原图' : '编辑版') + ' · 选区 ' + [region.x, region.y, region.width, region.height].map(n => (n * 100).toFixed(1) + '%').join(' / ') : '拖出一个区域，或输入下方百分比。';
}
function save() {
  window.spellcast.setState({ view: view.value, split: Number(split.value), target: target.value, region, region_draft: Object.fromEntries(Object.entries(fields).map(([id, field]) => [id, field.value])),
    selection: region ? { asset: asset(), region, coordinate_space: 'normalized-image', label: (target.value === 'original' ? '原图' : '编辑版') + '中的区域' } : null });
}
function point(event) { const box = image.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)), y: Math.max(0, Math.min(1, (event.clientY - box.top) / box.height)) }; }
image.onpointerdown = event => { if (event.button !== 0) return; beforeDrag = region ? { ...region } : null; start = point(event); image.setPointerCapture(event.pointerId); };
image.onpointermove = event => { if (!start) return; const end = point(event); region = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }; paint(); };
image.onpointerup = event => { if (!start) return; start = null; image.releasePointerCapture(event.pointerId); if (!valid(region) || region.width < .01 || region.height < .01) region = null; syncFields(); save(); paint(); };
image.onpointercancel = () => { start = null; region = beforeDrag; syncFields(); save(); paint(); };
view.onchange = () => { region = null; syncFields(); paint(); save(); }; target.onchange = () => { region = null; syncFields(); paint(); save(); }; split.oninput = () => { paint(); save(); };
for (const field of Object.values(fields)) field.oninput = save;
document.querySelector('#apply').onclick = () => {
  const [x, y, width, height] = ['x', 'y', 'w', 'h'].map(id => Number(document.querySelector('#' + id).value) / 100);
  const next = { x, y, width, height };
  if (!valid(next)) { document.querySelector('#region-info').textContent = '请输入图像范围内、宽高大于零的区域。'; return; }
  region = next; syncFields(); paint(); save();
};
document.querySelector('#clear').onclick = () => { region = null; syncFields(); paint(); save(); };
window.spellcast.onRestore(s => { view.value = ['compare','original','amber'].includes(s.view) ? s.view : 'compare'; split.value = String(s.split ?? 50); target.value = s.target === 'original' ? 'original' : 'amber'; region = valid(s.region) ? s.region : null; syncFields(s.region_draft); paint(); }); paint();
