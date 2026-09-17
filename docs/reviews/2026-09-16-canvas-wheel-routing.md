# Wheel routing over Canvas content

The reported dead wheel occurred after entering content. An isolated reproduction confirmed that selection alone zoomed 100% → 85%, but double-clicking into short native text then rolling left the canvas at 85%. The content listener unconditionally stopped wheel propagation; iframe events also needed a separate route.

## Behavior

- Short/non-scrollable active native content now passes unused vertical wheel input to the Canvas zoom handler.
- Native scrollable regions retain wheel ownership, including at their scroll boundaries. Number/range inputs and selects retain their own wheel behavior.
- Live sandboxed works can forward unused trusted vertical wheel input through their existing private port. They must be explicitly enabled by the host. The host accepts normalized, bounded input only for the active hovered work, outside open dialogs.
- Work handlers can prevent the event or stop propagation to keep it local. Read-only views, standalone exports, modifier/horizontal events, synthetic events and unsupported hosts do not forward it.
- Host-side events targeting an active iframe are left to the child to resolve. Treating the iframe element as a non-scrollable native element would steal the wheel from its inner controls.
- Canvas zoom remains centered on the pointer. Navigation does not alter component dimensions, saved work parameters or send task feedback.

## Existing works

The saved SDK is immutable inside each published bundle. The forwarding code is therefore a separate host-owned `artifact-wheel.js` injected by the live HTML response, before the saved SDK. Stored files and export bytes remain unchanged. HTML shell responses revalidate; a namespaced shell query avoids reusing previously immutable cached HTML. Other asset responses retain their immutable caching.

## Verification

- Browser: active native text now zoomed 100% → 85% → 100% through wheel input.
- Windows desktop: the user's existing calendar work was entered by double-click and received actual `sky.scroll` input over its picture. Canvas zoom changed 95% → 80% → 95%; the work retained its 15-minute parameter. This used the existing published bundle without regeneration.
- The separate shim test verifies opt-in, trusted-parent initialization, older SDK coexistence, normalized output, deferred/default-prevented input, scrollable ancestors including at their bottom, controls, synthetic/read-only/standalone rejection, and modifier/horizontal input. It asserts no state/output/ready feedback is produced by the shim.
- The real resource test verifies the injected HTML shell, unchanged saved SDK bytes and immutable caching, unchanged export bytes, sandbox restrictions, and media range behavior.
- TypeScript, Vite, capture-protocol checks, wheel-protocol checks, all 91 bridge tests, Tauri build, and `git diff --check` passed. The previous core suite was not rerun because core behavior did not change.
- The in-app browser could not reliably target fractional/scaled iframe wheel coordinates. Earlier apparent iframe zoom was caused by parent interception, and is not counted as a valid child-wheel pass. Scrollable/custom work handling has protocol-test evidence, not a completed browser input verdict. The existing-work wheel path was subsequently verified on the actual Windows desktop.
- Isolated fixture feedback remained pending 0 / deliveries 0. Both temporary fixture services and the browser tab were closed.

Evidence directories: `artifacts/durable-canvas-work/browser-1789492459073/` (reproduction) and `artifacts/durable-canvas-work/browser-1789493146024/` (isolated wheel fixture).

## Runtime

Executable SHA256: `585899c2e7ea00d6733b095da44d24d9a057fe12c532db0646aab00edbb09787`. Deployment evidence is under `artifacts/workbench-20260914/canvas-wheel-routing-20260916/`; running PID at deployment was 60260. Database, executable/resources and profile backups were made before replacement. Before/after preservation checks passed with 6 nodes, 5 edges, 2 replies, 13 messages, 20 objects and 2 compositions. Native verification changed only selection and camera zoom; the original 95% zoom was restored.
