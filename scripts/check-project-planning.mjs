import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {runMapWheelChecks} from "./check-project-map-wheel.mjs";
import {planTool} from "./check-workspace-nav.mjs";

/** Uses only the intercepted API fixture in check-project-record-workspace.mjs. */
export async function runPlanningChecks({page, objects, projects, mutate, screenshotDir}) {
  const workspace=page.locator('.project-workspace'), root=page.locator('.project-planning');
  const action=name=>root.locator(`[data-plan-action="${name}"]`);
  const field=name=>root.locator(`[data-plan-field="${name}"]`);
  const pick=async id=>{await planTool(root,'editor');await root.locator(`[data-plan-object="${id}"]`).click();};
  const mapAction=name=>root.locator(`[data-map-action="${name}"]`);
  const mapPositions=()=>root.locator('[data-plan-graph-node]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.planGraphNode,left:n.style.left,top:n.style.top})));
  const edit=async()=>{await action('edit').click();await field('name').waitFor({state:'visible'});};
  const save=async()=>{await action('save').click();await page.waitForFunction(()=>document.querySelector('.plan-status')?.textContent==='Saved');};
  const get=name=>[...objects.values()].find(o=>o.name===name);
  async function create(kind,name,body='') {
    await planTool(root,'new'); await root.locator('[data-plan-kind]').selectOption(kind);
    await field('name').fill(name);
    if(body) { if(!await field('body').isVisible())await field('body').locator('xpath=ancestor::details/summary').click();await field('body').fill(body); }
  }
  async function link(target,relation='uses') {
    await action('add-link').click(); const row=root.locator('.plan-link').last();
    await row.locator('select').nth(0).selectOption(relation);await row.locator('select').nth(1).selectOption(target);
  }
  assert.equal(await workspace.getAttribute('data-workspace-view'),'planning');
  assert.equal(await page.locator('[data-project-view="objects"]').count(),0);
  assert.equal(await root.locator('[data-plan-object]').count(),0);
  assert.equal(await root.locator('[data-plan-map][data-example="true"]').count(),1);
  assert.equal(await root.locator('[data-plan-graph-node]').count(),3);
  assert.equal(await root.locator('[data-map-edge]').count(),3);
  assert.equal(await root.locator('form').count(),0);
  await mkdir(screenshotDir,{recursive:true});
  await mapAction('fit').click();
  await runMapWheelChecks(page,root);
  await page.screenshot({path:path.join(screenshotDir,'planning-map-example.png')});
  const examplePositions=await mapPositions();
  await mapAction('skeleton').click();assert.equal(await root.locator('[data-overlay-object]').count(),0);assert.equal(await root.locator('[data-map-edge]').count(),2);
  assert.deepEqual(await mapPositions(),examplePositions);
  await mapAction('layers').click();await root.locator('[data-plan-scope]').selectOption('R1');
  assert.equal(await root.locator('[data-overlay-object="example-content"]').count(),0);assert.deepEqual(await mapPositions(),examplePositions);
  await root.locator('[data-plan-scope]').selectOption('R0');assert.equal(await root.locator('[data-overlay-object="example-content"]').count(),1);
  assert.equal(objects.size,0,'Example must never create project objects');await root.locator('[data-plan-scope]').selectOption('');
  await create('system','Fixture progression','States and design intent');await save(); const system=get('Fixture progression');
  assert.equal(system.planning.locked,true);assert.equal(await root.locator('form').count(),0);
  assert.throws(()=>mutate({op:'put_object',project_id:system.project_id,id:system.id,expected_revision:system.revision,name:'accident',kind:'system',archived:true,planning:{...system.planning,locked:false},request_id:'blocked-write'}),/locked/);
  await planTool(root,'overview');await root.locator(`[data-plan-graph-node="${system.id}"] [data-map-action="select-node"]`).click();
  await root.locator(`[data-plan-create="rule"][data-create-parent="${system.id}"]`).click();
  assert.equal(await root.locator('.plan-link select').nth(1).inputValue(),system.id);
  await field('name').fill('Fixture rule');await field('trigger').fill('After choice');await field('condition').fill('First visit');await field('effect').fill('Remember choice');await save();
  await create('hook','Fixture hook');await field('cue').fill('Visible reward');await field('action').fill('Explore or return');await field('payoff').fill('A new route');await field('continuation').fill('Unanswered question');await save();
  await create('parameter','Fixture reward');await field('value').fill('10');await field('unit').fill('points');await field('min').fill('0');await field('max').fill('100');
  await action('add-variant').click();await field('variant-name-0').fill('Gentle');await field('variant-value-0').fill('8');await field('variant-reason-0').fill('Fixture only');
  await link(system.id,'belongs_to');await save(); const parameter=get('Fixture reward');
  await create('content','Shared consumer');await link(parameter.id);await save();const shared=get('Shared consumer');
  await create('content','Local consumer');await link(parameter.id);
  await root.locator('.plan-link input[type="checkbox"]').check();await field('local-value-0').fill('5');await field('local-reason-0').fill('Intro fixture');
  await save();const local=get('Local consumer');
  await create('flow','Fixture flow');await link(shared.id,'uses');await save();
  await pick(parameter.id);
  assert.equal(await root.locator('[data-plan-impact]').count(),3);
  assert.match(await root.locator(`[data-plan-impact="${local.id}"]`).innerText(),/5.*Intro fixture/);
  await edit();await action('adopt-value').click();await save();assert.equal(get('Fixture reward').planning.parameter.value,'8');
  await pick(shared.id);assert.match(await root.locator('.plan-read-link').innerText(),/Shared value: 8 points/);
  await pick(local.id);assert.match(await root.locator('.plan-read-link').innerText(),/Local: 5.*Intro fixture/);
  await planTool(root,'numbers');assert.match(await root.locator('table').innerText(),/Fixture reward[\s\S]*8[\s\S]*points/);
  await root.locator('[data-plan-scope]').selectOption('R2');assert.equal(await root.locator('[data-plan-object]').count(),0);
  await root.locator('[data-plan-scope]').selectOption('');await pick(parameter.id);await edit();
  await field('body').locator('xpath=ancestor::details/summary').click();
  await field('body').fill('Unsaved draft survives reload');
  await page.reload({waitUntil:'commit'});
  await page.waitForFunction(()=>document.querySelector('#projects-open')?.textContent?.trim()==='Game development');
  await page.locator('#projects-open').evaluate(e=>e.click());await page.waitForSelector('[data-plan-read]');
  assert.equal(await root.locator('form').count(),0);assert.equal(await root.locator('.plan-draft-notice').count(),1);await edit();
  assert.equal(await field('body').inputValue(),'Unsaved draft survives reload');
  // A competing saved revision must never be overwritten silently.
  const now=get('Fixture reward');mutate({op:'put_object',project_id:now.project_id,id:now.id,expected_revision:now.revision,name:now.name,kind:now.kind,archived:false,planning:{...now.planning,body:'Concurrent saved version'},request_id:'fixture-conflict'});
  await action('save').click();await root.locator('.plan-conflict').waitFor();
  assert.equal(await field('body').inputValue(),'Unsaved draft survives reload');
  assert.equal(await action('save').isDisabled(),true);
  await action('rebase').click();await action('resolve-local').click();await save();
  assert.equal(get('Fixture reward').planning.body,'Unsaved draft survives reload');
  await root.locator('[data-plan-history] > summary').click();await action('history').click();
  assert.equal(await action('restore').last().isDisabled(),true);
  await edit();await root.locator('[data-plan-history] > summary').click();await action('history').click();
  await action('restore').last().locator('..').locator('summary').click();await action('restore').last().click();
  await page.waitForFunction(()=>document.querySelector('.plan-status')?.textContent==='Saved');
  assert.equal(get('Fixture reward').planning.parameter.value,'10');
  assert.equal(get('Fixture reward').planning.locked,true);
  await edit();await field('name').fill('Discard this name');await action('discard').click();await root.locator('[data-plan-read]').waitFor();
  assert.equal(get('Fixture reward').planning.locked,true);assert.equal(get('Discard this name'),undefined);
  await planTool(root,'overview');
  const originalObjects=JSON.stringify([...objects.values()]);
  const initialPositions=await mapPositions();
  const basePositions=initialPositions.filter(n=>n.id===system.id||n.id===get('Fixture flow').id);
  await mapAction('skeleton').click();
  assert.equal(await root.locator('[data-overlay-object]').count(),0);
  assert.deepEqual(await mapPositions(),basePositions);
  await root.locator('[data-plan-scope]').selectOption('R2');assert.deepEqual(await mapPositions(),basePositions);
  await root.locator('[data-plan-scope]').selectOption('');await mapAction('layers').click();
  assert.deepEqual(await mapPositions(),initialPositions);
  await mapAction('fit').click();
  const graphSystem=root.locator(`[data-plan-graph-node="${system.id}"]`);
  await graphSystem.locator('[data-map-action="drag"]').press('ArrowRight');
  let movedPositions=await mapPositions();assert.equal(parseFloat(movedPositions.find(n=>n.id===system.id).left),parseFloat(initialPositions.find(n=>n.id===system.id).left)+20);
  const handle=await graphSystem.locator('[data-map-action="drag"]').boundingBox();assert.ok(handle);
  await page.mouse.move(handle.x+handle.width/2,handle.y+handle.height/2);await page.mouse.down();await page.mouse.move(handle.x+handle.width/2+35,handle.y+handle.height/2+20,{steps:5});await page.mouse.up();
  assert.ok(parseFloat((await mapPositions()).find(n=>n.id===system.id).left)>parseFloat(movedPositions.find(n=>n.id===system.id).left)+30);
  movedPositions=await mapPositions();
  await root.locator('[data-plan-scope]').selectOption('R1');await root.locator('[data-plan-scope]').selectOption('');assert.deepEqual(await mapPositions(),movedPositions);
  assert.equal(JSON.stringify([...objects.values()]),originalObjects,'View changes must not mutate design or locks');
  await root.locator(`[data-overlay-object="${local.id}"]`).click();
  assert.match(await root.locator('.plan-map-inspector').innerText(),/Shared: 10 points[\s\S]*Local: 5.*Intro fixture/);
  await page.screenshot({path:path.join(screenshotDir,'planning-map-local-value.png')});
  await mapAction('close-inspector').click();
  await root.locator('[data-map-layer="parameter"]').uncheck();await mapAction('zoom-in').click();
  const cameraBefore=await root.locator('.plan-map-world').evaluate(n=>n.style.transform);
  await page.reload({waitUntil:'commit'});await page.waitForFunction(()=>document.querySelector('#projects-open')?.textContent?.trim()==='Game development');
  await page.locator('#projects-open').evaluate(e=>e.click());await root.locator('[data-plan-map]').waitFor();
  assert.deepEqual(await mapPositions(),movedPositions);assert.equal(await root.locator('[data-map-layer="parameter"]').isChecked(),false);
  assert.equal(await root.locator('.plan-map-world').evaluate(n=>n.style.transform),cameraBefore);
  await root.locator('[data-map-layer="parameter"]').check();
  for(const [width,height] of [[1920,1080],[1280,860],[640,800]]) {
    await page.setViewportSize({width,height});await root.locator('.plan-main').evaluate(e=>e.scrollTop=0);
    await mapAction('fit').click();
    assert.equal(await workspace.evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`Overview overflow ${width}`);
    await page.screenshot({path:path.join(screenshotDir,`planning-map-${width}.png`)});
  }
  await pick(parameter.id);await edit();
  for(const [width,height] of [[1920,1080],[1280,860],[820,800],[640,800]]) {
    await page.setViewportSize({width,height});
    await root.locator('.plan-main').evaluate(e=>e.scrollTop=0);
    assert.equal(await workspace.evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`Workspace overflow ${width}`);
    assert.ok(await root.locator('input[type="checkbox"]').first().evaluate(e=>e.getBoundingClientRect().width<=20),'Oversized checkbox');
    await page.screenshot({path:path.join(screenshotDir,`planning-${width}.png`)});
  }
  await page.setViewportSize({width:1920,height:1080});await planTool(root,'focus');
  await root.locator('.plan-main').evaluate(e=>e.scrollTop=0);
  if(!await field('body').isVisible())await field('body').locator('xpath=ancestor::details/summary').click();
  const bodyWidth=await field('body').evaluate(e=>e.getBoundingClientRect().width);
  assert.ok(bodyWidth>1750,`Focused editor too narrow: ${bodyWidth}`);
  await page.screenshot({path:path.join(screenshotDir,'planning-focused-1920.png')});await planTool(root,'focus');
  // Config projections and unconverted historical objects never leak into the new view.
  const projectId=[...projects.keys()][0];objects.set('legacy-config',{id:'legacy-config',project_id:projectId,name:'OLD CONFIG MUST NOT SHOW',kind:'zone',revision:1,archived:false});
  await page.locator('[data-project-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('.plan-status')?.hidden===true);
  assert.equal(await root.getByText('OLD CONFIG MUST NOT SHOW').count(),0);
  await pick(shared.id);await action('new-work').click();
  assert.equal(await workspace.getAttribute('data-workspace-view'),'records');
  assert.equal(await page.locator('[data-record-title]').inputValue(),'Shared consumer');
  await page.locator('[data-record-action="save"]').click();await page.locator('.project-workspace-record-summary').waitFor();
  await page.getByText('Goal, scope, and sources',{exact:true}).click();
  assert.match(await page.locator('.project-workspace-record-summary').innerText(),new RegExp(shared.id));
  await page.setViewportSize({width:1280,height:860});
  console.log('planning fixture passed: system graph, independent layers, stable skeleton/positions, view persistence, read-only example, contextual creation, lock/edit/save/cancel, shared/local values, drafts, conflicts, restore, responsive layouts, no legacy config requests');
}
