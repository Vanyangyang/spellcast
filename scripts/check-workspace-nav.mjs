/** Navigation shared by browser checks: workspace views and manual planning tools live in menus. */
export async function openView(page, view) {
  const tools = page.locator('[data-project-tools]');
  if (!(await tools.evaluate(element => element.open))) await tools.locator('summary').click();
  await page.locator(`[data-project-tools] [data-project-view="${view}"]`).click();
  await page.waitForFunction(name => document.querySelector('.project-workspace')?.dataset.workspaceView === name, view);
}

export async function planTool(root, name) {
  const menu = root.locator('[data-plan-tools]');
  if (!(await menu.evaluate(element => element.open))) await root.locator('[data-plan-tools-toggle]').click();
  await root.locator(`.plan-tools-menu [data-plan-action="${name}"]`).click();
}
