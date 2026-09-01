import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { currentLocale } from "../i18n";
import type { BoardNode, BoardSnapshot } from "../types";
import { kindLabel, weightLabel } from "../types";
import { KIND_TONE, weightScale } from "./shared";

type SpatialHandle = {
  update: (board: BoardSnapshot, selected: string | null) => void;
  focus: (id: string | null) => void;
  destroy: () => void;
};

const textures = new Map<string, THREE.CanvasTexture>();

export function mountSpatial(
  canvas: HTMLCanvasElement,
  board: BoardSnapshot,
  selected: string | null,
  onSelect: (id: string | null) => void,
): SpatialHandle {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x07080c, 1);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x07080c, 0.028);

  const camera = new THREE.PerspectiveCamera(48, 1, 0.1, 120);
  camera.position.set(0, 8.5, 22);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 8;
  controls.maxDistance = 42;
  controls.target.set(0, 0, 0);

  scene.add(new THREE.AmbientLight(0xb8c4d8, 0.7));
  const key = new THREE.PointLight(0x9ad9cc, 18, 40);
  key.position.set(8, 12, 6);
  scene.add(key);
  const fill = new THREE.PointLight(0xc4a1ff, 10, 36);
  fill.position.set(-10, 4, -8);
  scene.add(fill);

  scene.add(starfield());
  const nucleus = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.55, 1),
    new THREE.MeshStandardMaterial({
      color: 0x1b2430,
      emissive: 0x3d5a52,
      emissiveIntensity: 0.8,
      roughness: 0.35,
      metalness: 0.2,
    }),
  );
  scene.add(nucleus);

  const group = new THREE.Group();
  scene.add(group);
  const meshes = new Map<string, THREE.Object3D>();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();

  const resize = () => {
    const w = canvas.clientWidth || canvas.parentElement?.clientWidth || 800;
    const h = canvas.clientHeight || canvas.parentElement?.clientHeight || 600;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  resize();
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement ?? canvas);

  const draw = (next: BoardSnapshot, sel: string | null) => {
    group.clear();
    meshes.clear();
    for (const edge of next.edges) {
      const a = next.nodes.find((n) => n.id === edge.from);
      const b = next.nodes.find((n) => n.id === edge.to);
      if (!a || !b) continue;
      const geo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(a.x, a.y, a.z),
        new THREE.Vector3(b.x, b.y, b.z),
      ]);
      group.add(
        new THREE.Line(
          geo,
          new THREE.LineBasicMaterial({ color: 0x8aa0b8, transparent: true, opacity: 0.28 }),
        ),
      );
    }
    for (const node of next.nodes) {
      const card = makeCard(node, node.id === sel);
      card.position.set(node.x, node.y, node.z);
      card.lookAt(camera.position);
      group.add(card);
      meshes.set(node.id, card);
    }
  };

  draw(board, selected);

  const onPointer = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects([...meshes.values()], true);
    const root = hits[0]?.object;
    let id: string | null = null;
    let walk: THREE.Object3D | undefined = root;
    while (walk) {
      if (walk.userData.nodeId) {
        id = walk.userData.nodeId;
        break;
      }
      walk = walk.parent ?? undefined;
    }
    onSelect(id);
  };
  canvas.addEventListener("pointerdown", onPointer);

  let alive = true;
  const tick = () => {
    if (!alive) return;
    nucleus.rotation.y += 0.004;
    nucleus.rotation.x += 0.0015;
    for (const obj of meshes.values()) {
      obj.lookAt(camera.position);
      obj.position.y += Math.sin(performance.now() * 0.001 + obj.position.x) * 0.002;
    }
    controls.update();
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  };
  tick();

  return {
    update: (next, sel) => draw(next, sel),
    focus: (id) => {
      const node = [...meshes.values()].find((m) => m.userData.nodeId === id);
      if (!node) return;
      controls.target.copy(node.position);
    },
    destroy: () => {
      alive = false;
      canvas.removeEventListener("pointerdown", onPointer);
      ro.disconnect();
      controls.dispose();
      renderer.dispose();
      textures.forEach((t) => t.dispose());
      textures.clear();
    },
  };
}

function makeCard(node: BoardNode, selected: boolean): THREE.Group {
  const group = new THREE.Group();
  group.userData.nodeId = node.id;
  const scale = weightScale(node.weight) * (selected ? 1.12 : 1);
  const texture = cardTexture(node, selected);
  const mat = new THREE.MeshStandardMaterial({
    map: texture,
    transparent: true,
    roughness: 0.45,
    metalness: 0.08,
    emissive: new THREE.Color(KIND_TONE[node.kind]),
    emissiveIntensity: selected ? 0.22 : 0.08,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(3.4 * scale, 1.95 * scale), mat);
  mesh.userData.nodeId = node.id;
  group.add(mesh);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 12, 12),
    new THREE.MeshStandardMaterial({
      color: KIND_TONE[node.kind],
      emissive: KIND_TONE[node.kind],
      emissiveIntensity: 0.9,
    }),
  );
  core.position.set(0, 1.12 * scale, 0.04);
  core.userData.nodeId = node.id;
  group.add(core);
  return group;
}

function cardTexture(node: BoardNode, selected: boolean): THREE.CanvasTexture {
  const key = `${currentLocale()}:${node.id}:${node.title}:${selected}`;
  const hit = textures.get(key);
  if (hit) return hit;

  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 288;
  const ctx = canvas.getContext("2d")!;
  const tone = KIND_TONE[node.kind];

  round(ctx, 18, 18, 476, 252, 28);
  ctx.fillStyle = selected ? "rgba(22, 28, 38, 0.96)" : "rgba(14, 17, 24, 0.92)";
  ctx.fill();
  ctx.strokeStyle = tone;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.globalAlpha = 1;

  ctx.fillStyle = tone;
  ctx.fillRect(18, 18, 476, 8);

  ctx.font = "600 18px 'IBM Plex Sans', 'Noto Sans SC', sans-serif";
  ctx.fillStyle = tone;
  ctx.fillText(kindLabel(node.kind), 40, 58);
  ctx.fillStyle = "rgba(230,236,242,0.45)";
  ctx.fillText(weightLabel(node.weight), 400, 58);

  ctx.font = "600 32px 'IBM Plex Sans', 'Noto Sans SC', sans-serif";
  ctx.fillStyle = "#f4f1ea";
  wrap(ctx, node.title, 40, 108, 430, 36, 1);

  ctx.font = "400 20px 'IBM Plex Sans', 'Noto Sans SC', sans-serif";
  ctx.fillStyle = "rgba(230,236,242,0.72)";
  wrap(ctx, node.body, 40, 168, 430, 28, 3);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  textures.set(key, texture);
  return texture;
}

function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  max: number,
  lh: number,
  lines: number,
) {
  let line = "";
  let used = 0;
  for (const ch of text) {
    const trial = line + ch;
    if (ctx.measureText(trial).width > max) {
      ctx.fillText(line, x, y + used * lh);
      line = ch;
      used += 1;
      if (used >= lines) return;
    } else {
      line = trial;
    }
  }
  if (used < lines) ctx.fillText(line, x, y + used * lh);
}

function round(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function starfield(): THREE.Points {
  const count = 900;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 90;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 50;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 90;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0xc9d4e2, size: 0.05, transparent: true, opacity: 0.55 }),
  );
}
