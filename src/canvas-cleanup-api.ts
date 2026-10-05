import { apiBase } from "./api";
import type { BoardSnapshot, CanvasBatchRequest, CanvasBatchResult, DeliveryPhase, FeedbackState } from "./types";

export type CleanupGuard = {
  expected_canvas_revision: number;
  expected_feedback: { pending: number[]; deliveries: { sequence: number; phase: DeliveryPhase }[] };
};

export function cleanupGuard(board: BoardSnapshot, feedback: FeedbackState): CleanupGuard {
  return {
    expected_canvas_revision: board.canvas?.revision ?? 0,
    expected_feedback: {
      pending: feedback.pending.map(event => event.seq).sort((a, b) => a - b),
      deliveries: feedback.deliveries.map(receipt => ({ sequence: receipt.event.seq, phase: receipt.phase }))
        .sort((a, b) => a.sequence - b.sequence),
    },
  };
}

export async function applyCleanup(guard: CleanupGuard, batch: CanvasBatchRequest): Promise<{ board: BoardSnapshot; result: CanvasBatchResult }> {
  const response = await fetch(`${await apiBase()}/api/canvas/organize`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...guard, batch }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || response.statusText);
  return value;
}
