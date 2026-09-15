import '../shared/style.css';
import katex from 'katex';
import 'katex/dist/katex.min.css';
const state = await window.spellcast.ready;
const length = document.querySelector('#length'), angle = document.querySelector('#angle');
const clamp = (value, low, high, fallback) => Number.isFinite(Number(value)) ? Math.max(low, Math.min(high, Number(value))) : fallback;
length.value = String(clamp(state.length, .2, 3, 1)); angle.value = String(clamp(state.angle, 5, 15, 12));
let time = Math.max(0, Number(state.time) || 0), playing = false, previous = 0, raf = 0;
const period = l => 2 * Math.PI * Math.sqrt(l / 9.81);
if (Math.abs(period(1) - 2.0060666807) > .000001 || Math.abs(period(2) / period(.5) - 2) > .000001) throw new Error('Pendulum reference check failed.');
katex.render('T = 2\\pi\\sqrt{\\frac{L}{g}}', document.querySelector('#formula'), { displayMode: true, output: 'htmlAndMathml', throwOnError: true });
function draw() {
  const l = Number(length.value), a = Number(angle.value), theta = a * Math.PI / 180 * Math.cos(2 * Math.PI * time / period(l));
  const r = 85 + l * 68, x = 250 + r * Math.sin(theta), y = 48 + r * Math.cos(theta), rod = document.querySelector('#rod'), bob = document.querySelector('#bob');
  rod.setAttribute('x1', '250'); rod.setAttribute('y1', '48'); rod.setAttribute('x2', String(x)); rod.setAttribute('y2', String(y)); bob.setAttribute('cx', String(x)); bob.setAttribute('cy', String(y));
  document.querySelector('#length-label').textContent = l.toFixed(1) + ' m'; document.querySelector('#angle-label').textContent = a + '°';
  document.querySelector('#period').textContent = period(l).toFixed(3) + ' s'; document.querySelector('#phase').textContent = 't = ' + time.toFixed(2) + ' s';
}
function persist() { window.spellcast.setState({ length: Number(length.value), angle: Number(angle.value), time }); }
function tick(at) { if (!playing) return; time += previous ? Math.min(.05, (at - previous) / 1000) : 0; previous = at; draw(); raf = requestAnimationFrame(tick); }
function pause(save = true) { playing = false; cancelAnimationFrame(raf); previous = 0; document.querySelector('#play').textContent = '播放'; if (save) persist(); }
document.querySelector('#play').onclick = () => { if (playing) pause(); else { playing = true; previous = 0; document.querySelector('#play').textContent = '暂停'; raf = requestAnimationFrame(tick); } };
document.querySelector('#zero').onclick = () => { pause(); time = 0; persist(); draw(); };
for (const control of [length, angle]) control.oninput = () => { persist(); draw(); };
const choose = () => window.spellcast.setState({ length: Number(length.value), angle: Number(angle.value), time, selection: { ids: ['pendulum-bob'], label: '摆锤 · 摆长 ' + length.value + ' m', time } });
document.querySelector('#bob').onclick = choose; document.querySelector('#bob').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
window.spellcast.onRestore(s => { pause(false); length.value = String(clamp(s.length, .2, 3, 1)); angle.value = String(clamp(s.angle, 5, 15, 12)); time = Number(s.time) || 0; draw(); });
addEventListener('pagehide', () => { playing = false; cancelAnimationFrame(raf); }); draw();
