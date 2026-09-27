# Project records phase 1 implementation contract

This file coordinates the approved implementation. Existing Canvas content, layout,
annotations, deletion locks and dirty edits must be preserved. No migration of existing
Markdown and no media library in this phase.

## Technology boundary (user asked before expansion)

The current Tauri / TypeScript / Rust / SQLite stack fits this local, single-user records
phase. This is an architectural judgment based on current source and SQLite's documented
desktop storage use, not a load-test result. X6 remains an optional Canvas presentation
surface; it does not own records/history/authorization. Keep the game-development entry
separate and retain the original Canvas and idea-layout entry points.

Known engineering pressure: the existing Canvas/main/Bridge modules are already large;
new records use isolated modules with small integration hooks. Transaction tests, process
restart tests and export/import tests are required before depending on the new store.
JSON export is user-invoked recovery, not automatic scheduled backup. Existing design
documents remain until migration is separately verified. Local agents share one serialized
writer and use optimistic concurrency. Multi-machine synchronization, high concurrent
write volume, large media storage/streaming and cross-platform native UI acceptance are
separate future work; do not promise them based on this phase.

Sources: https://www.sqlite.org/whentouse.html,
https://www.sqlite.org/atomiccommit.html,
https://v2.tauri.app/concept/process-model/.

## Data and storage

New Rust module `spellcast-bridge/src/project_records.rs` owns public serde/JsonSchema types.
`project_record_store.rs` implements methods on Store using its existing connection.
Use separate versioned project tables, without changing the legacy state schema version.
Projects have stable UUID ids; directory aliases are discovery metadata, never permissions.
Development objects and records are scoped by project id. Their ids survive export/import.

- Project: id, name, aliases:string[], revision:u64, archived:bool, created_at_ms, updated_at_ms.
- DevelopmentObject: id, project_id, name, kind:string, revision, archived.
- RecordFields: object_id:optional string, title, goal, scope, status, result, boundaries,
  next_step, references:SourceReference[]. All strings except title optional/default empty.
  status: planned | active | blocked | done | cancelled (default planned). No inferred completion.
- SourceReference: label:string, uri:string, version:string (default empty). References
  are external links only; no source file reads, no embedded originals, no script URLs.
- WorkRecord: id, project_id, flattened RecordFields, revision, archived, created_at_ms,
  updated_at_ms, updated_by:RecordActor.
- RecordActor: kind:string (user/agent/import), source_id/thread_id/cwd optional strings,
  label:string. The bridge supplies this, never the mutation body.
- RecordHistory: project_id, kind:project|object|record, id, revision, at_ms, actor,
  operation, request_id, snapshot:JSON. Append complete immutable snapshots.

RecordCommand: request_id, project_id, flattened tagged change (`op`):
- create_project {name, aliases:[]}
- update_project {expected_revision, name, aliases, archived}
- put_object {id, expected_revision, name, kind, archived}
- put_record {id, expected_revision, fields:RecordFields}
- archive_record {id, expected_revision, archived}
- restore_record {id, expected_revision, restore_revision}
- import_project {bundle:ProjectExport, name:string} (new, empty target project only).

Expected revision 0 creates an object/record; all later writes require current revision.
No hard-delete operation. Archived project/object records remain exportable and queryable.
Restore copies the chosen historical record fields/archived state to a NEW current revision.
Create/update/current row + history snapshot + durable request receipt commit in ONE SQLite
transaction. Same request and actor replays identical result; reused id with different body
or actor rejects. No fallible writes after commit. Validate size, references and membership.
RecordMutationResult {project?:Project, object?:DevelopmentObject, record?:WorkRecord, replayed:bool}.

Store methods (Result<_,String>): init_project_schema(&Connection),
project_list(), project_get(id), project_objects(project), project_records(project, query, status,
include_archived), project_record(project,id), project_history(project,kind,id),
project_mutate(&mut self, command:&RecordCommand, actor:&RecordActor),
project_export(project), project_markdown(project).
List returns at most 1000 matched records in this first release; export is complete with
explicit bounded import size. Query matches title/goal/result/boundaries/next step.

ProjectExport {format:"spellcast.project", version:1, exported_at_ms, project, objects,
records, history, external_files:[{uri, original_included:false}]}.
No permissions, tokens, or user Canvas layout in portable export. Import remaps project_id
to the caller's new project UUID, preserves object/record ids and historical snapshots,
validates all relationships and contiguous histories, and appends import provenance.
Markdown is a one-way snapshot including stable IDs, versions and external-file disclaimer.

## Bridge and access (primary owner)

Bridge owns `project_workspace.rs` and REST/MCP integration. UI local routes:
GET /api/projects -> Project[]
POST /api/projects/command -> RecordMutationResult (RecordCommand body)
GET /api/projects/:project/objects -> DevelopmentObject[]
GET /api/projects/:project/records?query=&status=&archived=true -> WorkRecord[]
GET /api/projects/:project/records/:id -> WorkRecord
GET /api/projects/:project/history/:kind/:id -> RecordHistory[]
GET /api/projects/:project/export -> ProjectExport
GET /api/projects/:project/markdown -> {markdown:string}
POST /api/projects/:project/pin {record_id,request_id} -> BoardSnapshot
GET /api/projects/:project/access -> ProjectAccess[] (no secrets)
POST /api/projects/:project/access/:id {expected_revision, decision:"approved"|"revoked"}
ProjectAccess {id, project_id, source_id, thread_id, cwd, label, state, revision,
created_at_ms, expires_at_ms}. Access state pending|approved|revoked. Verified Codex metadata
is obtained before creating request. Secret bearer token is returned ONLY to requesting
Agent, stored hashed, never listed/exported. User grants access in the app; cwd aliases
never grant it. Mutation actor is derived from approved credential, not supplied source_id.
Queries are read only; writes require a credential. Project-scoped grants cannot manage projects.
User-authorized local automation can create/update projects and maintain records through
`spellcast_project_manage` or POST `/api/projects/local/command`, using a separate OS-owner-
protected credential plus verified actual Codex task metadata. It cannot import projects or
approve/revoke grants. Current/history/receipt writes use the same canonical transaction path.
The desktop credential lives beside the database at `credentials/project-api.key`; it is never
returned over HTTP/IPC or exported. The bundled `scripts/project-api.mjs` reads it internally
and sends only to loopback. Headless fixtures explicitly provision SPELLCAST_PROJECT_LOCAL_KEY.
UI writes additionally require a private process-lifetime window key obtained through
main-window Tauri IPC; an Origin header alone is never UI authority. Headless integration
fixtures explicitly provision their own key using SPELLCAST_PROJECT_UI_KEY.

## Canvas reference (separate worker)

New CanvasContent `work_record {project_id,record_id}` stores ids ONLY. No title/body cache
in canonical Canvas state. Existing locks/source ownership protect the reference placement.
Removing/deleting reference does not touch project data. Editing opens project record UI.
Canvas card asynchronously fetches current record; show unavailable explicitly (no fallback
fabrication). Use `src/project-record-api.ts` API client/types described above. After record
mutation main refreshes board; card load reads current canonical record. Source tasks remain
distinct from project identity. Do not globally relax canvas source permissions.
Main callback `onOpenProjectRecord?: (projectId:string, recordId:string)=>void` lets main
open workspace. If callback integration is awkward, dispatch a CustomEvent
`spellcast:open-project-record` with detail {projectId,recordId}, handled by main.

## Frontend workspace (separate worker)

User clarified: Game development is a separate top-level entry. Keep original Canvas
and idea-layout entry points and all their functions; do not make record management the
Canvas default. Reference cards are an explicit optional bridge between the surfaces.

Regrouping decision: serve one independent developer collaborating with multiple AI tasks.
The acceptance journey is capture -> actual result/boundaries -> handoff -> recover.
Existing records open as a saved-state reading summary, with result, boundaries and next
step visible; editing is explicit. Development-object assignment and other details are
optional. Export/import/access administration are secondary actions. No statistics,
planning hierarchy, media-library expansion or automatic historical-completion import.

New `src/project-record-api.ts`, `src/project-workspace.ts`, `src/project-workspace.css`
and `src/i18n/projects.ts`. Public `createProjectWorkspace({onChanged:()=>void})` returns
{open(projectId?:string,recordId?:string):Promise<void>,close():void}. Primary adds nav button.
Use a near-full-window dialog, project selector + searchable list + spacious detail/editor.
Creation requires only project name / record title. Collapsible optional fields, automatic
dates/source. Support development object picker/create, current/history/restore, archive /
restore, source references, pin to Canvas, JSON export+import into NEW project, Markdown export,
access request approval/revoke with task label/id/cwd and clear warning that aliases are not
permissions. Never evaluate imported HTML; use textContent. Protect dirty draft on navigation
or closing; conflicts keep draft for review. Use en/zh-CN/ja local strings. No remote publishing.

## Verification

Isolated tests only: create/update/result boundaries/history/restore/reopen; atomic rollback;
idempotency + changed-body refusal; stale revision rejection; unauthorized/forged-source write
rejected; two approved tasks write same record; removed/locked cards preserve record; portable
export/import equality (with remapped project) and external files explicit. UI interactions,
REST/MCP transport, actual host native callable tools and installed app reported separately.
