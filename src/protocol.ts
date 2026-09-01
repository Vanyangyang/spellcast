import type { BoardNode, BoardSnapshot, StageForm } from "./types";

/** Host (plugin / editor) → Orbit environment */
export type HostToEnv =
  | { type: "orbit.hello" }
  | { type: "orbit.utter"; text: string; focus?: string }
  | { type: "orbit.import"; transcript: string }
  | { type: "orbit.setForm"; form: StageForm }
  | { type: "orbit.reset" };

/** Orbit environment → host */
export type EnvToHost =
  | { type: "orbit.ready"; version: string; embed: boolean }
  | { type: "orbit.board"; board: BoardSnapshot }
  | { type: "orbit.uttered"; reply: string; form: StageForm; added: number }
  | { type: "orbit.select"; node: BoardNode | null }
  | { type: "orbit.error"; message: string };

export const ORBIT_VERSION = "0.1.0";

export function isHostToEnv(data: unknown): data is HostToEnv {
  if (!data || typeof data !== "object") return false;
  const type = (data as { type?: string }).type;
  return typeof type === "string" && type.startsWith("orbit.");
}

export function isEnvToHost(data: unknown): data is EnvToHost {
  return isHostToEnv(data);
}
