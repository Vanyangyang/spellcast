import '../shared/style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
const state = await window.spellcast.ready;
const host = document.querySelector('#viewer'), slider = document.querySelector('#explode');
const scene = new THREE.Scene(); scene.background = new THREE.Color('#f1f5f8');
const camera = new THREE.PerspectiveCamera(34, 1, .1, 100); camera.position.set(5, 3.6, 6);
const renderer = new THREE.WebGLRenderer({ antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; host.append(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement); controls.target.set(0, 1.4, 0); controls.minDistance = 3; controls.maxDistance = 14; controls.maxPolarAngle = Math.PI * .9;
scene.add(new THREE.HemisphereLight(0xffffff, 0x859a9b, 2.7)); const light = new THREE.DirectionalLight(0xffffff, 3.5); light.position.set(4, 8, 4); scene.add(light);
const floor = new THREE.Mesh(new THREE.CircleGeometry(3.2, 64), new THREE.MeshStandardMaterial({ color: '#e2e9ed', roughness: 1 })); floor.rotation.x = -Math.PI / 2; floor.position.y = -.15; scene.add(floor);
const gltf = await new GLTFLoader().loadAsync('./assets/weather-station.glb'); scene.add(gltf.scene);
const model = gltf.scene.getObjectByName('WeatherStation'); if (!model || model.children.length !== 5) throw new Error('The glTF assembly must contain five named parts.');
const parts = model.children; for (const part of parts) { part.userData.original = part.position.clone(); part.traverse(node => { if (node.isMesh) { node.material = node.material.clone(); node.userData.part = part.name; } }); }
const descriptions = { foundation: '固定装置与地面的连接，并承受上部组件的载荷。', mast: '为传感器提供安装高度，也把载荷传回底座。', sensor: '容纳测量与信号处理组件，正面的小窗代表读数区。', hood: '为下方传感器提供简单遮雨，示意通风与防护之间的关系。', rotor: '风杯随来流转动；这个教具仅展示部件组成，没有模拟空气动力学。' };
let selected = parts.some(p => p.name === state.selected) ? state.selected : 'sensor';
slider.value = String(Math.min(100, Math.max(0, Number(state.explode) || 0)));
function restoreCamera(s) { if (Array.isArray(s.camera) && s.camera.length === 3 && s.camera.every(Number.isFinite)) camera.position.fromArray(s.camera); if (Array.isArray(s.target) && s.target.length === 3 && s.target.every(Number.isFinite)) controls.target.fromArray(s.target); controls.update(); }
restoreCamera(state);
function save() { window.spellcast.setState({ explode: Number(slider.value), selected, camera: camera.position.toArray(), target: controls.target.toArray(), selection: { ids: [selected], asset: 'assets/weather-station.glb', label: parts.find(p => p.name === selected).userData.title } }); }
function render() { renderer.render(scene, camera); }
function draw(saveState = true) {
  const amount = Number(slider.value) / 100;
  for (const part of parts) { part.position.copy(part.userData.original).addScaledVector(new THREE.Vector3().fromArray(part.userData.explode), amount);
    part.traverse(node => { if (node.isMesh && node.material.emissive) { node.material.emissive.set(part.name === selected ? '#5a3e08' : '#000000'); node.material.emissiveIntensity = .35; } });
  }
  document.querySelector('#amount').textContent = slider.value + '%';
  document.querySelectorAll('#parts button').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.part === selected)));
  document.querySelector('#part-detail').textContent = descriptions[selected]; render(); if (saveState) save();
}
for (const part of parts) { const button = document.createElement('button'); button.type = 'button'; button.textContent = part.userData.title; button.dataset.part = part.name; button.onclick = () => { selected = part.name; draw(); }; document.querySelector('#parts').append(button); }
const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let down;
renderer.domElement.addEventListener('pointerdown', event => { down = [event.clientX, event.clientY]; });
renderer.domElement.addEventListener('pointerup', event => { if (!down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 6) return; const rect = renderer.domElement.getBoundingClientRect(); pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2); raycaster.setFromCamera(pointer, camera); const hit = raycaster.intersectObjects(parts, true).find(hit => hit.object.userData.part); if (hit) { selected = hit.object.userData.part; draw(); } });
slider.oninput = () => draw(); controls.addEventListener('change', render); controls.addEventListener('end', save);
function fit(direction) {
  scene.updateMatrixWorld(true);
  const sphere = new THREE.Box3().setFromObject(gltf.scene).getBoundingSphere(new THREE.Sphere());
  const vertical = THREE.MathUtils.degToRad(camera.fov), horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance = sphere.radius / Math.sin(Math.min(vertical, horizontal) / 2) * 1.1;
  controls.maxDistance = Math.max(controls.maxDistance, distance * 1.2);
  controls.target.copy(sphere.center); camera.position.copy(sphere.center).addScaledVector(direction.normalize(), distance); controls.update(); save();
}
for (const [id, direction] of [['front', [0, .1, 1]], ['side', [1, .1, 0]], ['isometric', [1, .6, 1.2]]]) document.querySelector('#' + id).onclick = () => fit(new THREE.Vector3().fromArray(direction));
document.querySelector('#fit').onclick = () => fit(camera.position.clone().sub(controls.target));
const resize = new ResizeObserver(() => { const width = host.clientWidth, height = host.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / height; camera.updateProjectionMatrix(); render(); }); resize.observe(host);
window.spellcast.onRestore(s => { slider.value = String(Math.min(100, Math.max(0, Number(s.explode) || 0))); if (parts.some(p => p.name === s.selected)) selected = s.selected; restoreCamera(s); draw(false); });
addEventListener('pagehide', () => { resize.disconnect(); controls.dispose(); scene.traverse(node => { if (node.isMesh) { node.geometry.dispose(); for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose(); } }); renderer.dispose(); renderer.forceContextLoss(); });
document.querySelector('#model-status').textContent = 'glTF / GLB · 5 个有稳定标识的部件'; draw(false);
