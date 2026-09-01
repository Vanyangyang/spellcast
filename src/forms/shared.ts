import type { BoardNode, FragmentWeight, NodeKind } from "../types";
import { kindLabel, weightLabel } from "../types";

export const KIND_TONE: Record<NodeKind, string> = {
  idea: "#7ee0c8",
  question: "#f0c36a",
  risk: "#ff8a7a",
  action: "#7eb6ff",
  insight: "#d4b3ff",
};

export function cardHtml(node: BoardNode, selected: boolean): string {
  return `
    <article class="frag ${node.weight} ${selected ? "is-on" : ""}" data-id="${node.id}" style="--tone:${KIND_TONE[node.kind]}">
      <header>
        <span class="kind">${kindLabel(node.kind)}</span>
        <span class="weight">${weightLabel(node.weight)}</span>
      </header>
      <h3>${escapeHtml(node.title)}</h3>
      <p>${escapeHtml(node.body)}</p>
    </article>
  `;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function bounds(nodes: BoardNode[]) {
  if (!nodes.length) return { minX: -8, maxX: 8, minZ: -8, maxZ: 8 };
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z);
    maxZ = Math.max(maxZ, n.z);
  }
  if (maxX - minX < 4) {
    minX -= 2;
    maxX += 2;
  }
  if (maxZ - minZ < 4) {
    minZ -= 2;
    maxZ += 2;
  }
  return { minX, maxX, minZ, maxZ };
}

export function mapRange(v: number, a: number, b: number, c: number, d: number) {
  if (b === a) return (c + d) / 2;
  return c + ((v - a) / (b - a)) * (d - c);
}

export function weightScale(weight: FragmentWeight): number {
  if (weight === "spark") return 0.86;
  if (weight === "anchor") return 1.08;
  return 1;
}
