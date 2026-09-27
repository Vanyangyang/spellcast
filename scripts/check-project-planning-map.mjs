import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

// Compile the real pure model without starting the application or writing fixture data.
const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const moduleUrl=source=>'data:text/javascript;base64,'+Buffer.from(source).toString('base64');
const planningUrl=moduleUrl(compile(await readFile(new URL('../src/project-planning-model.ts',import.meta.url),'utf8')));
const source=compile(await readFile(new URL('../src/project-planning-map-model.ts',import.meta.url),'utf8')).replace('"./project-planning-model"',JSON.stringify(planningUrl));
const {planningMapModel,planningMapExample}=await import(moduleUrl(source));
const {emptyPlanning}=await import(planningUrl);
const {wheelScale}=await import(moduleUrl(compile(await readFile(new URL('../src/canvas-wheel.ts',import.meta.url),'utf8'))));
for(const [scale,delta,expected] of [[.01,-120,.02],[.05,120,.04],[.15,-120,.16],[.2,-120,.25],[.2,120,.15],[1,-120,1.2],[1,120,.85],[1.5,-120,1.5]]) {
  assert.ok(Math.abs(wheelScale(scale,delta)-expected)<1e-9,'original Canvas wheel behavior changed');
}
assert.equal(wheelScale(.25,120,{min:.25,max:2}),.25);
assert.equal(wheelScale(2,-120,{min:.25,max:2}),2);
assert.equal(wheelScale(2,120,{min:.25,max:2}),1.65);
const object=(id,kind,links=[])=>({id,name:id,kind,project_id:'fixture',revision:1,archived:false,planning:{...emptyPlanning(kind),links}});
const link=(id,relation='uses')=>({target_id:id,relation,note:''});
const objects=[object('a','system'),object('b','system',[link('a','follows')]),object('value','parameter',[link('b','belongs_to')]),
  object('content','content',[link('a','belongs_to'),{...link('value'),local:{value:'5',reason:'fixture'}}]),
  object('shared','rule',[link('a'),link('b')]),object('cycle1','hook',[link('cycle2')]),object('cycle2','content',[link('cycle1')]),
  object('legacy','zone')];delete objects.at(-1).planning;
const before=JSON.stringify(objects), model=planningMapModel(objects);
assert.deepEqual(model.hosts.get('content'),['a'],'explicit attachment wins over used values');
assert.deepEqual(model.hosts.get('value'),['b']);
assert.deepEqual(model.hosts.get('shared'),['a','b'],'shared object has multiple placements, one canonical identity');
assert.equal(model.nodes.find(n=>n.object.id==='a').items.find(o=>o.id==='shared'),objects[4]);
assert.equal(model.nodes.find(n=>n.object.id==='b').items.find(o=>o.id==='shared'),objects[4]);
assert.ok(model.connections.some(c=>c.source.id==='content'&&c.target.id==='value'&&c.from==='a'&&c.to==='b'&&c.link.local.value==='5'));
assert.equal(model.nodes.filter(n=>n.unattached).length,2,'unanchored cycles remain visible without inferred systems');
assert.ok(!model.objects.some(o=>o.id==='legacy'));
assert.equal(JSON.stringify(objects),before,'projection must not mutate saved data');
const example=planningMapExample(['A','B','C','content','hook','parameter','rule','reason']);
assert.ok(example.every(o=>o.project_id==='example-only'&&o.revision===0));
assert.equal(planningMapModel(example).nodes.length,3);
console.log('planning map model passed: canonical references, explicit attachment, projected edge provenance, cycles, legacy exclusion, read-only example and unchanged Canvas wheel defaults');
