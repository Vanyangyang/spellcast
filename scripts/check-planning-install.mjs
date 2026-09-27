// Read-only check against the closed pre-install backup. Never imports config or submits work.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import path from 'node:path';

const backup=process.argv[2];assert.ok(backup,'Pass the closed pre-install backup directory');
const db=new DatabaseSync(path.join(backup,'spellcast.sqlite3'),{readOnly:true});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash=data=>createHash('sha256').update(data).digest('hex');
async function api(route){const r=await fetch('http://127.0.0.1:47194'+route,{signal:AbortSignal.timeout(10000)});assert.equal(r.status,200,route);return r.json();}
assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0],'ok');
const previous=JSON.parse(db.prepare('SELECT value FROM spellcast_state WHERE id=1').get().value);
const board=await api('/api/board');
const fields=['canvas','replies','nodes','edges','messages','topic','form','form_reason'];
const select=value=>Object.fromEntries(fields.map(k=>[k,value[k]]));
assert.deepEqual(select(board),select(previous.session.board),'Existing Canvas changed during install');
const projects=await api('/api/projects');
assert.equal(projects.length,db.prepare('SELECT COUNT(*) AS n FROM spellcast_projects').get().n);
let recordCount=0,objectCount=0,historyCount=0;
const evidenceCounts={candidates:0,trials:0,adoptions:0};
for(const project of projects){
  const bundle=await api(`/api/projects/${project.id}/export`);
  for(const [table,items,key] of [['spellcast_projects',[bundle.project],'id'],['spellcast_project_objects',bundle.objects,'project_id'],['spellcast_project_records',bundle.records,'project_id'],['spellcast_project_history',bundle.history,'project_id']]){
    const rows=db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(project.id);assert.equal(items.length,rows.length,table);
    for(const row of rows){
      const item=items.find(value=>value.id===(row.id??row.entity_id)&&(!row.entity_id||(value.kind===row.kind&&value.revision===row.revision)));assert.ok(item,table);
      for(const [column,value]of Object.entries(row)){
        const field=column==='entity_id'?'id':column.replace(/_json$/,'');
        const expected=column.endsWith('_json')&&value!==null?JSON.parse(value):column==='archived'?Boolean(value):value;
        assert.deepEqual(item[field]??null,expected,`${table}.${field}`);
      }
    }
  }
  recordCount+=bundle.records.length;objectCount+=bundle.objects.length;historyCount+=bundle.history.length;
  for(const key of Object.keys(evidenceCounts)){
    const table=`spellcast_project_${key}`;
    const existed=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const rows=existed?db.prepare(`SELECT value_json FROM ${table} WHERE project_id=?`).all(project.id):[];
    const items=bundle[key]||[];
    assert.equal(items.length,rows.length,`${table} count changed during install`);
    for(const row of rows){
      const expected=JSON.parse(row.value_json);
      assert.deepEqual(items.find(item=>item.id===expected.id),expected,`${table}.${expected.id}`);
    }
    evidenceCounts[key]+=items.length;
  }
}
db.close();
// The app holds an exclusive database lock. Inspect a snapshot copied after the app has exited,
// then compare the restarted app's API above against the pre-install backup.
const migratedPath=process.argv[3];assert.ok(migratedPath,'Pass the closed post-install database snapshot');
const migrated=new DatabaseSync(migratedPath,{readOnly:true});
assert.equal(Object.values(migrated.prepare('PRAGMA quick_check').get())[0],'ok','Migrated database integrity');
const projectSchema=migrated.prepare('SELECT schema_version FROM spellcast_project_schema_version WHERE id=1').get().schema_version;
assert.equal(projectSchema,4,'Installed application has not migrated the project schema');
migrated.close();
const release=await readFile('G:/VibeProj/spellcast/src-tauri/target/release/spellcast.exe');
const installed=await readFile('C:/Users/Administrator/AppData/Local/Spellcast/spellcast.exe');
function normalize(binary){const output=Buffer.from(binary);for(const suffix of ['UNK','NSS']){const needle=Buffer.from(`__TAURI_BUNDLE_TYPE_VAR_${suffix}`);let i=output.indexOf(needle);while(i>=0){output.write('__TAURI_BUNDLE_TYPE_VAR_XXX',i,'ascii');i=output.indexOf(needle,i+needle.length);}}return output;}
assert.equal(hash(normalize(release)),hash(normalize(installed)),'Installed executable differs from build');
const sourceGuide=await readFile('G:/VibeProj/spellcast/skills/spellcast/references/project-records.md');
for(const guide of ['C:/Users/Administrator/.codex/skills/spellcast/references/project-records.md','C:/Users/Administrator/AppData/Local/Spellcast/resources/codex-plugin/skills/spellcast/references/project-records.md'])assert.equal(hash(await readFile(guide)),hash(sourceGuide),guide);
console.log(JSON.stringify({passed:true,projectSchema,migratedSnapshotIntegrity:'ok',projects:projects.length,records:recordCount,objects:objectCount,history:historyCount,...evidenceCounts,canvasObjects:board.canvas.objects.length,boardDigest:digest(select(board)),installedSHA256:hash(installed),guideSHA256:hash(sourceGuide)}));
