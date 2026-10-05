import type { HostRoutePin, HostSessionStatus, TaskTarget } from "./types";
import { workspaceIdentity } from "./content-origin";

export function hostPinKey(pin?: HostRoutePin | null): string {
  return pin ? JSON.stringify([pin.source_id, pin.client, pin.engine, pin.native_session_id, pin.gui_session_id,
    pin.cwd, pin.client_instance_id, pin.window_id, pin.lease_id, pin.generation]) : "";
}
const returnable = (host: HostSessionStatus) => host.reachable && host.capabilities.includes("canvas_requests") && host.capabilities.includes("durable_receipts");
export function hostTarget(source: string, hosts: HostSessionStatus[], captured?: TaskTarget): TaskTarget | undefined {
  const candidates = hosts.filter(host => returnable(host) && host.host_pin.source_id === source
    && (!captured?.thread_id || host.host_pin.native_session_id === captured.thread_id)
    && (!captured?.cwd || workspaceIdentity(host.host_pin.cwd) === workspaceIdentity(captured.cwd)));
  // One explicit source with several live windows is ambiguous; do not vote by time/cwd.
  if (candidates.length !== 1) return undefined;
  const host = candidates[0];
  return { source_id: source, thread_id: host.host_pin.native_session_id, cwd: captured?.cwd || host.host_pin.cwd,
    label: `${host.host_pin.client === "ccgui" ? "CC GUI" : host.host_pin.client} · ${host.label || host.host_pin.native_session_id.slice(0, 8)}`, host_pin: { ...host.host_pin } };
}
export function canReturnHost(target: TaskTarget | undefined, hosts: HostSessionStatus[]): boolean {
  const pin = target?.host_pin;
  return Boolean(pin && hosts.some(host => returnable(host) && hostPinKey(host.host_pin) === hostPinKey(pin)
    && host.host_pin.source_id === target?.source_id
    && host.host_pin.native_session_id === target?.thread_id
    && (!target.cwd || workspaceIdentity(host.host_pin.cwd) === workspaceIdentity(target.cwd))));
}

export function recentHostTarget(hosts: HostSessionStatus[]): TaskTarget | undefined {
  const active = hosts.filter(host => returnable(host) && host.active);
  return active.length === 1 ? hostTarget(active[0].host_pin.source_id, hosts) : undefined;
}
