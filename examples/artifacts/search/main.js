import '../shared/style.css';
import mermaid from 'mermaid';
const saved = await window.spellcast.ready;
const W = 8, H = 5, walls = new Set([3, 11, 13, 17, 19, 21, 29, 33]), goal = 39;
const queue = [0], previous = new Map([[0, null]]), snapshots = [];
for (let i = 0; i < queue.length; i++) {
  const node = queue[i]; snapshots.push({ node, visited: queue.slice(0, i + 1), frontier: queue.slice(i + 1) });
  if (node === goal) break;
  const x = node % W, y = Math.floor(node / W);
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const nx = x + dx, ny = y + dy, next = ny * W + nx;
    if (nx >= 0 && nx < W && ny >= 0 && ny < H && !walls.has(next) && !previous.has(next)) { previous.set(next, node); queue.push(next); }
  }
}
const path = []; for (let node = goal; node != null; node = previous.get(node)) path.unshift(node);
if (path[0] !== 0 || path.length !== 12) throw new Error('BFS reference path changed.');
const validStep = value => Math.trunc(Math.max(0, Math.min(snapshots.length - 1, Number(value) || 0)));
const validCell = value => Number.isInteger(value) && value >= 0 && value < W * H && !walls.has(value) ? value : 0;
let step = validStep(saved.step), timer = 0;
let selected = validCell(saved.cell);
function save() { window.spellcast.setState({ cell: selected, step, selection: { ids: ['cell-' + selected], label: '格子 ' + selected + ' · 第 ' + (step + 1) + ' 步' } }); }
const grid = document.querySelector('#grid'), cells = [];
for (let i = 0; i < W * H; i++) {
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  g.setAttribute('tabindex', walls.has(i) ? '-1' : '0'); g.setAttribute('role', 'button');
  g.setAttribute('aria-label', '格子 ' + i); g.style.cursor = 'pointer';
  g.setAttribute('aria-disabled', String(walls.has(i)));
  const x = 18 + (i % W) * 64, y = 16 + Math.floor(i / W) * 64;
  g.innerHTML = '<rect x="' + x + '" y="' + y + '" width="54" height="54" rx="10"/><text x="' + (x + 27) + '" y="' + (y + 32) + '" text-anchor="middle" font-size="13" fill="#284051">' + (i === 0 ? '起点' : i === goal ? '终点' : i) + '</text>';
  const choose = () => { if (walls.has(i)) return; selected = i; save(); draw(); };
  g.onclick = choose; g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } };
  grid.append(g); cells.push(g);
}
function draw() {
  const snapshot = snapshots[step], finished = step === snapshots.length - 1;
  cells.forEach((g, i) => { const rect = g.firstElementChild;
    rect.setAttribute('fill', walls.has(i) ? '#324459' : finished && path.includes(i) ? '#f8cf75' : snapshot.visited.includes(i) ? '#8cc8b6' : '#eaf0f6');
    rect.setAttribute('stroke', i === selected ? '#236cc6' : i === snapshot.node ? '#255f55' : 'none'); rect.setAttribute('stroke-width', '3');
    g.lastElementChild.setAttribute('fill', walls.has(i) ? '#d8e1e9' : '#284051');
  });
  document.querySelector('#step').textContent = (step + 1) + ' / ' + snapshots.length;
  document.querySelector('#detail').textContent = finished ? '到达终点：最短路径为 ' + (path.length - 1) + ' 步。' : '当前展开格子 ' + snapshot.node + '，已访问 ' + snapshot.visited.length + ' 个格子。';
  document.querySelector('#next').disabled = finished;
}
function stop() { clearInterval(timer); timer = 0; document.querySelector('#play').textContent = '播放'; }
function advance() { if (step < snapshots.length - 1) step++; else stop(); save(); draw(); }
document.querySelector('#next').onclick = advance;
document.querySelector('#play').onclick = () => { if (timer) stop(); else { document.querySelector('#play').textContent = '暂停'; timer = setInterval(advance, 450); } };
document.querySelector('#reset').onclick = () => { stop(); step = 0; save(); draw(); };
window.spellcast.onRestore(state => { stop(); step = validStep(state.step); selected = validCell(state.cell); draw(); });
addEventListener('pagehide', stop);
mermaid.initialize({ startOnLoad: false, theme: 'base', securityLevel: 'strict', themeVariables: { primaryColor: '#e7f2ed', primaryTextColor: '#24473f', primaryBorderColor: '#84afa0', fontFamily: 'Segoe UI, Microsoft YaHei, sans-serif' } });
const diagram = await mermaid.render('bfs-flow', 'flowchart TD\n A[起点进入队列] --> B[取出最早的格子]\n B --> C{是终点吗}\n C -- 是 --> D[沿父节点回溯路径]\n C -- 否 --> E[未访问的邻居进入队列]\n E --> B');
document.querySelector('#flow').innerHTML = diagram.svg; draw();
