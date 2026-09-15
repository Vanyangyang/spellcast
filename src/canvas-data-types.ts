/** Finite, declared work ports. Inputs are runtime snapshots, never saved work state. */
export type CanvasScalar = number | string | boolean | null;
export type CanvasPortType = "number" | "string" | "boolean" | "null";
export type ArtifactIO = { inputs: Record<string, CanvasPortType>; outputs: Record<string, CanvasPortType> };
export type CanvasBinding = { from: { object_id: string; block_id: string; port: string }; to: { block_id?: string | null; port: string } };
export type CanvasDataSource = { object_id: string; content_revision: number; block_id: string; bundle_id: string; state_revision: number };
export type CanvasPortValue = { status: "available" | "unavailable"; value?: CanvasScalar; reason?: string; sources: CanvasDataSource[] };
export type CanvasInputSnapshot = { revision: number; ports: Record<string, CanvasPortValue> };
