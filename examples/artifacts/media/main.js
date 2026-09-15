import '../shared/style.css';
const state = await window.spellcast.ready;
const picker = document.querySelector('#asset'), video = document.querySelector('#video'), audio = document.querySelector('#audio');
const start = document.querySelector('#start'), end = document.querySelector('#end'), seek = document.querySelector('#seek');
picker.value = state.asset === 'audio' ? 'audio' : 'video';
let active, range = null, looping = false, lastSave = 0;
const assetPath = () => picker.value === 'audio' ? 'assets/four-notes.wav' : 'assets/water-route.mp4';
function validRange(value) { const start = Number(value?.start), end = Number(value?.end); return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= 8 ? { start, end } : null; }
function save() { window.spellcast.setState({ asset: picker.value, time: active.currentTime, range, selection: range ? { asset: assetPath(), time_range: range, label: (picker.value === 'audio' ? '音频' : '视频') + ' ' + range.start.toFixed(1) + '–' + range.end.toFixed(1) + ' s' } : null }); }
function paint() { document.querySelector('#position').textContent = active.currentTime.toFixed(2) + ' s'; seek.value = String(active.currentTime); document.querySelector('#range').textContent = range ? '当前片段：' + range.start.toFixed(1) + '–' + range.end.toFixed(1) + ' 秒' : '尚未选择时间段。'; document.querySelector('#loop').textContent = looping ? '停止循环' : '循环所选片段'; }
function switchAsset(restored = null) {
  video.pause(); audio.pause(); active = picker.value === 'audio' ? audio : video; active.volume = .3;
  video.hidden = picker.value !== 'video'; document.querySelector('#audio-wrap').hidden = picker.value !== 'audio';
  looping = false; range = validRange(restored?.range);
  start.value = String(range?.start ?? 1); end.value = String(range?.end ?? 3); document.querySelector('#error').textContent = '';
  const time = Math.min(8, Math.max(0, Number(restored?.time) || 0));
  const current = active;
  const ready = () => { if (current !== active) return; current.currentTime = time; seek.max = String(Number.isFinite(current.duration) ? current.duration : 8); paint(); };
  if (active.readyState >= 1) ready(); else active.addEventListener('loadedmetadata', ready, { once: true });
  if (!restored) save(); paint();
}
for (const media of [video, audio]) {
  media.addEventListener('timeupdate', () => { if (media !== active) return; if (looping && range && media.currentTime >= range.end) media.currentTime = range.start; paint(); if (Date.now() - lastSave > 900) { lastSave = Date.now(); save(); } });
  media.addEventListener('error', () => { const message = '素材播放失败：' + (media.error?.message || media.error?.code); document.querySelector('#error').textContent = message; window.spellcast.reportError(message); });
}
document.querySelector('#play').onclick = () => active.play().catch(error => { document.querySelector('#error').textContent = error.message; });
document.querySelector('#pause').onclick = () => { active.pause(); save(); };
document.querySelector('#loop').onclick = () => { if (!range) { document.querySelector('#error').textContent = '先选择一段有效时间。'; return; } looping = !looping; if (looping) { active.currentTime = range.start; void active.play(); } paint(); };
document.querySelector('#select').onclick = () => {
  const a = Number(start.value), b = Number(end.value), duration = Number.isFinite(active.duration) ? active.duration : 8;
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b <= a || b > duration) { document.querySelector('#error').textContent = '时间段应位于素材范围内，结束必须晚于开始。'; return; }
  document.querySelector('#error').textContent = ''; range = { start: a, end: b }; active.currentTime = a; save(); paint();
};
seek.oninput = () => { active.currentTime = Number(seek.value); save(); paint(); }; picker.onchange = () => switchAsset();
const decoded = await new OfflineAudioContext(1, 1, 32000).decodeAudioData(await (await fetch('./assets/four-notes.wav')).arrayBuffer());
const samples = decoded.getChannelData(0), bucket = Math.floor(samples.length / 120);
for (let i = 0; i < 120; i++) { let peak = 0; for (let j = i * bucket; j < (i + 1) * bucket; j++) peak = Math.max(peak, Math.abs(samples[j])); const h = Math.max(2, peak * 400); const line = document.createElementNS('http://www.w3.org/2000/svg', 'line'); line.setAttribute('x1', String(i * 5)); line.setAttribute('x2', String(i * 5)); line.setAttribute('y1', String(45 - h / 2)); line.setAttribute('y2', String(45 + h / 2)); line.setAttribute('stroke', '#3d8b78'); line.setAttribute('stroke-width', '2'); document.querySelector('#wave').append(line); }
window.spellcast.onRestore(s => { picker.value = s.asset === 'audio' ? 'audio' : 'video'; switchAsset(s); });
addEventListener('pagehide', () => { video.pause(); audio.pause(); for (const media of [video, audio]) { media.removeAttribute('src'); media.load(); } }); switchAsset(state);
