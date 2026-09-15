import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GLTFExporter uses the browser FileReader interface; Blob supplies the actual byte operations in Node.
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) { blob.arrayBuffer().then(result => { this.result = result; this.onloadend?.(); }).catch(error => this.onerror?.(error)); }
  readAsDataURL(blob) { blob.arrayBuffer().then(result => { this.result = 'data:' + blob.type + ';base64,' + Buffer.from(result).toString('base64'); this.onloadend?.(); }).catch(error => this.onerror?.(error)); }
};
const root = new THREE.Group(); root.name = 'WeatherStation';
function part(id, title, y, vector) { const g = new THREE.Group(); g.name = id; g.position.y = y; g.userData = { title, explode: vector }; root.add(g); return g; }
function mesh(group, geometry, color, position = [0, 0, 0]) {
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: .55, metalness: .12 }));
  m.position.fromArray(position); m.name = group.name + '-' + group.children.length; group.add(m); return m;
}
mesh(part('foundation', '固定底座', .05, [0, 0, 0]), new THREE.CylinderGeometry(1.3, 1.42, .22, 48), 0x7c8fa1);
mesh(part('mast', '支撑立柱', .75, [-1.1, 0, 0]), new THREE.CylinderGeometry(.14, .19, 1.4, 24), 0xbdcbd4);
const sensor = part('sensor', '传感器舱', 1.55, [1.2, 0, 0]);
mesh(sensor, new THREE.BoxGeometry(1.0, .75, .75), 0xeeeeE2);
mesh(sensor, new THREE.BoxGeometry(.4, .22, .035), 0x346e63, [0, .1, .4]);
for (let i = 0; i < 3; i++) mesh(sensor, new THREE.BoxGeometry(.68, .035, .045), 0x89958c, [0, -.12 - i * .09, .4]);
mesh(part('hood', '遮雨罩', 2.02, [0, .65, .8]), new THREE.CylinderGeometry(.79, .7, .12, 6), 0x3e8575);
const rotor = part('rotor', '风杯组件', 2.62, [0, 1.05, 0]);
mesh(rotor, new THREE.CylinderGeometry(.16, .16, .85, 24), 0x647b8c, [0, -.35, 0]);
for (let i = 0; i < 3; i++) {
  const theta = i * Math.PI * 2 / 3;
  const arm = mesh(rotor, new THREE.BoxGeometry(1.7, .055, .055), 0x667a84, [.68 * Math.cos(theta), 0, .68 * Math.sin(theta)]); arm.rotation.y = -theta;
  const cup = mesh(rotor, new THREE.SphereGeometry(.3, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), 0xd6aa5b, [1.43 * Math.cos(theta), 0, 1.43 * Math.sin(theta)]); cup.rotation.z = Math.PI / 2; cup.rotation.y = -theta;
}
const buffer = await new GLTFExporter().parseAsync(root, { binary: true });
if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected a binary glTF model.');
const output = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets'); await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'weather-station.glb'), new Uint8Array(buffer));
console.log(JSON.stringify({ file: path.join(output, 'weather-station.glb'), bytes: buffer.byteLength, parts: root.children.map(g => g.name) }));
