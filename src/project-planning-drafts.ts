/** Compare JSON data by values, never by serialization key order. */
export function dataEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => dataEqual(v, b[i]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].every(key => dataEqual(left[key], right[key]));
}
export type DraftConflict = { path: string[]; local: unknown; remote: unknown };
/** Arrays stay atomic: concurrent changes to the same array require an explicit choice. */
export function mergeDraft<T>(base: T, local: T, remote: T): { value: T; conflicts: DraftConflict[] } {
  const conflicts: DraftConflict[] = [];
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  function merge(b: unknown, l: unknown, r: unknown, path: string[]): unknown {
    if (dataEqual(l, b) || dataEqual(l, r)) return structuredClone(r);
    if (dataEqual(r, b)) return structuredClone(l);
    if (plain(b) && plain(l) && plain(r)) {
      const result: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(b), ...Object.keys(l), ...Object.keys(r)])) {
        const value = merge(b[key], l[key], r[key], [...path, key]); if (value !== undefined) result[key] = value;
      }
      return result;
    }
    conflicts.push({ path, local: structuredClone(l), remote: structuredClone(r) }); return structuredClone(r);
  }
  return { value: merge(base, local, remote, []) as T, conflicts };
}
export function chooseLocal<T>(value: T, conflicts: DraftConflict[]): T {
  const result = structuredClone(value);
  for (const conflict of conflicts) {
    if (!conflict.path.length) return structuredClone(conflict.local) as T;
    let target = result as Record<string, unknown>;
    for (const key of conflict.path.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const key = conflict.path[conflict.path.length - 1];
    if (conflict.local === undefined) delete target[key]; else target[key] = structuredClone(conflict.local);
  }
  return result;
}
