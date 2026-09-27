import assert from 'node:assert/strict';
import path from 'node:path';
import {openView,planTool} from "./check-workspace-nav.mjs";

export async function runFlowChecks({page,objects,projects,mutate,screenshotDir}) {
  const root=page.locator('.project-planning'), workspace=page.locator('.project-workspace');
  const plan=name=>root.locator(`[data-plan-action="${name}"]`), action=name=>root.locator(`[data-flow-action="${name}"]`), field=name=>root.locator(`[data-flow-field="${name}"]`);
  await openView(page,'planning');await planTool(root,'flows');
  await field('flow-picker').selectOption('example-flow');const before=JSON.stringify([...objects.values()]);
  await field('initial-energy').fill('1');await action('start').click();
  assert.equal(await root.locator('[data-flow-choice="explore"]').isDisabled(),true);
  await action('reset-inputs').click();await field('initial-energy').fill('3');await action('start').click();
  await root.locator('[data-flow-choice="explore"]').click();await action('confirm-manual').waitFor();
  await field('manual-reward').fill('7');await action('confirm-manual').click();await root.locator('[data-flow-choice="reward"]').click();
  await page.waitForFunction(()=>document.querySelector('[data-flow-value="coins"] dd')?.textContent==='7');
  assert.match(await root.locator('[data-flow-trace]').innerText(),/手动/);
  assert.equal(JSON.stringify([...objects.values()]),before,'Example must not mutate canonical data');
  await action('chart').click();await root.locator('[data-flow-chart] canvas').waitFor();
  await page.screenshot({path:path.join(screenshotDir,'flow-example-run.png')});
  await page.reload({waitUntil:'commit'});await page.waitForFunction(()=>document.querySelector('#projects-open')?.textContent?.trim()==='Game development');
  await page.locator('#projects-open').evaluate(e=>e.click());await root.locator('[data-flow-value="coins"]').waitFor();
  assert.equal(await root.locator('[data-flow-value="coins"] dd').innerText(),'7');
  await action('rewind').click();assert.equal(await root.locator('[data-flow-value="coins"] dd').innerText(),'0');
  await action('new-flow').click();await root.locator('[data-plan-field="name"]').fill('Playable fixture');
  await action('add-step').click();await field('step-title').fill('Choose an action');
  await field('step-goal').fill('Understand the first choice');await field('step-action').fill('Spend energy to finish');await field('step-feedback').fill('Energy changes immediately');
  await action('add-step').click();await field('step-title').fill('Finish');await field('terminal').check();
  await action('variables').click();await action('add-variable').click();
  const cell=(row,key)=>root.locator(`.tabulator-row`).nth(row).locator(`[tabulator-field="${key}"]`);
  async function editCell(row,key,value){await cell(row,key).click();const input=cell(row,key).locator('input');await input.fill(value);await input.press('Enter');}
  await cell(0,'name').waitFor();await editCell(0,'name','Energy');await editCell(0,'initial','3');
  await action('add-variable').click();await cell(1,'name').waitFor();await editCell(1,'name','Reward');
  await cell(1,'parameter_id').click();await page.locator('.tabulator-edit-list-item').filter({hasText:'Fixture reward'}).click();
  await action('steps').click();await root.locator('[data-flow-step]').first().click();
  await action('add-choice').click();await field('choice-label-0').fill('Spend two energy');
  await action('add-condition').click();await field('0-condition-0-op').selectOption('gte');await field('0-condition-0-value').fill('2');
  await action('add-effect').click();await field('0-effect-0-op').selectOption('subtract');await field('0-effect-0-value').fill('2');
  for(const [width,height] of [[1920,1080],[1320,900],[880,800]]){
    await page.setViewportSize({width,height});await root.locator('.plan-main').evaluate(e=>e.scrollTop=0);
    assert.equal(await workspace.evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`Flow editor overflow ${width}`);
    assert.equal(await root.locator('.flow-graph').evaluate(e=>e.getBoundingClientRect().right>e.parentElement.getBoundingClientRect().right+2),false,`Graph exceeds editor column ${width}`);
    await page.screenshot({path:path.join(screenshotDir,`flow-editor-${width}.png`)});
  }
  await plan('save-flow').click();await field('flow-picker').waitFor();
  const saved=[...objects.values()].find(o=>o.name==='Playable fixture');assert.ok(saved?.planning?.flow);assert.equal(saved.planning.locked,true);
  const [energy,reward]=saved.planning.flow.variables;
  assert.equal(saved.planning.flow.steps.length,2);assert.equal(saved.planning.flow.steps[0].choices[0].effects[0].op,'subtract');
  assert.equal(reward.parameter_id,[...objects.values()].find(o=>o.name==='Fixture reward').id);
  await action('start').click();await root.locator('[data-flow-choice]').click();
  await page.waitForFunction(id=>document.querySelector(`[data-flow-value="${id}"] dd`)?.textContent==='1',energy.id);
  await action('chart').click();await root.locator('[data-flow-chart] canvas').waitFor();
  for(const [width,height] of [[1920,1080],[1320,900],[880,800]]){
    await page.setViewportSize({width,height});await root.locator('.plan-main').evaluate(e=>e.scrollTop=0);
    assert.equal(await workspace.evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`Flow run overflow ${width}`);
    assert.equal(await root.locator('.flow-graph').evaluate(e=>e.getBoundingClientRect().right>e.parentElement.getBoundingClientRect().right+2),false,`Graph overlaps run detail ${width}`);
    await page.screenshot({path:path.join(screenshotDir,`flow-run-${width}.png`)});
  }
  await action('rewind').click();
  const download=page.waitForEvent('download');await action('export-run').click();assert.match((await download).suggestedFilename(),/^flow-run-.*\.json$/);
  const parameter=objects.get(reward.parameter_id);
  mutate({op:'set_object_lock',project_id:parameter.project_id,id:parameter.id,expected_revision:parameter.revision,locked:false,request_id:'flow-unlock-param'});
  const unlocked=objects.get(parameter.id);mutate({op:'put_object',project_id:unlocked.project_id,id:unlocked.id,expected_revision:unlocked.revision,name:unlocked.name,kind:unlocked.kind,archived:false,planning:{...unlocked.planning,parameter:{...unlocked.planning.parameter,value:'11'}},request_id:'flow-change-param'});
  await root.locator('[data-flow-choice]').click();await root.getByText('来源已改变：当前显示上次版本的记录。继续试走前请重新开始。').waitFor();
  assert.equal(await root.locator(`[data-flow-value="${energy.id}"] dd`).innerText(),'3','Stale source must not advance');
  await action('save-record').click();
  assert.equal(await page.locator('[data-record-title]').inputValue(),'Playable fixture · 流程试走');
  await page.locator('[data-record-action="save"]').click();await page.locator('.project-workspace-record-summary').waitFor();
  assert.match(await page.locator('.project-workspace-record-summary').innerText(),/模型预演/);
  await page.setViewportSize({width:1280,height:860});
  console.log('flow UI passed: editable steps/variables/parameter binding/guards/effects, pure example, blocked choice, manual input, chart, local resume/rewind, stale dependency, reviewable record, responsive layouts');
}
