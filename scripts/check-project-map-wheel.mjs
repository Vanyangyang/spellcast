import assert from 'node:assert/strict';

/** Production DOM in the intercepted workspace fixture; no live project writes. */
export async function runMapWheelChecks(page, root) {
  const stage=root.locator('.plan-map-stage'), world=root.locator('.plan-map-world');
  const action=name=>root.locator(`[data-map-action="${name}"]`);
  const rendered=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const camera=()=>world.evaluate(node=>{const matrix=new DOMMatrix(getComputedStyle(node).transform);return {x:matrix.e,y:matrix.f,z:matrix.a};});
  const bounds=await stage.boundingBox();assert.ok(bounds);
  const point={x:Math.round(bounds.x+bounds.width*.38),y:Math.round(bounds.y+bounds.height*.3)};
  const local={x:point.x-bounds.x,y:point.y-bounds.y};
  const anchored=(before,after)=>{assert.ok(Math.abs((local.x-before.x)/before.z-(local.x-after.x)/after.z)<.01,'pointer X anchor moved');assert.ok(Math.abs((local.y-before.y)/before.z-(local.y-after.y)/after.z)<.01,'pointer Y anchor moved');};
  const assertLabel=async()=>assert.equal(await root.locator('.plan-map-camera > span').innerText(),`${Math.round((await camera()).z*100)}%`);
  const originalPositions=await root.locator('[data-plan-graph-node]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.planGraphNode,x:n.style.left,y:n.style.top})));
  const before=await camera();await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,-120);await rendered();
  const enlarged=await camera();assert.ok(enlarged.z>before.z);anchored(before,enlarged);await assertLabel();
  await page.mouse.wheel(0,120);await rendered();const reduced=await camera();assert.ok(reduced.z<enlarged.z);anchored(enlarged,reduced);
  const fontBefore=await root.evaluate(node=>getComputedStyle(node).fontSize);
  await page.keyboard.down('Control');await page.mouse.wheel(0,-120);await page.keyboard.up('Control');await rendered();
  const ctrl=await camera();assert.ok(ctrl.z>reduced.z);anchored(reduced,ctrl);
  assert.equal(await root.evaluate(node=>getComputedStyle(node).fontSize),fontBefore);
  // A large device delta and a same-frame event burst must not multiply into a jump.
  await action('fit').click();const largeBefore=await camera();await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,-1200);await rendered();
  const largeAfter=await camera();assert.ok(largeAfter.z>largeBefore.z&&largeAfter.z<=largeBefore.z*1.25+.03);anchored(largeBefore,largeAfter);
  await stage.evaluate((node,point)=>{for(let i=0;i<8;i++)node.dispatchEvent(new WheelEvent('wheel',{deltaY:-120,deltaMode:1,clientX:point.x,clientY:point.y,bubbles:true,cancelable:true}));},point);await rendered();
  const burst=await camera();assert.ok(burst.z>largeAfter.z&&burst.z<=largeAfter.z*1.25+.03);anchored(largeAfter,burst);
  for(let i=0;i<12;i++)await action('zoom-out').click();const minimum=await camera();assert.equal(minimum.z,.25);
  await page.mouse.move(point.x,point.y);await page.mouse.wheel(0,120);await rendered();assert.deepEqual(await camera(),minimum);
  for(let i=0;i<13;i++)await action('zoom-in').click();const maximum=await camera();assert.equal(maximum.z,2);
  await page.mouse.wheel(0,-120);await rendered();assert.deepEqual(await camera(),maximum);await assertLabel();
  await action('fit').click();
  // The grip changes layout; blank-space dragging moves only the camera.
  const blank={x:bounds.x+30,y:bounds.y+bounds.height-32}, beforePan=await camera();
  await page.mouse.move(blank.x,blank.y);await page.mouse.down();await page.mouse.move(blank.x+28,blank.y-18,{steps:4});await page.mouse.up();
  const afterPan=await camera();assert.equal(afterPan.z,beforePan.z);assert.ok(Math.abs(afterPan.x-beforePan.x-28)<1);assert.ok(Math.abs(afterPan.y-beforePan.y+18)<1);
  assert.deepEqual(await root.locator('[data-plan-graph-node]').evaluateAll(nodes=>nodes.map(n=>({id:n.dataset.planGraphNode,x:n.style.left,y:n.style.top}))),originalPositions);
  await action('fit').click();await root.locator('[data-overlay-object="example-hook"]').click();
  const oldSize=page.viewportSize();await page.setViewportSize({width:1280,height:650});await rendered();
  const inspector=root.locator('.plan-map-inspector');assert.ok(await inspector.evaluate(n=>n.scrollHeight>n.clientHeight));
  await inspector.evaluate(n=>n.scrollTop=0);const inspectorBounds=await inspector.boundingBox(), cameraBeforeScroll=await camera();
  await page.mouse.move(inspectorBounds.x+inspectorBounds.width/2,inspectorBounds.y+inspectorBounds.height/2);await page.mouse.wheel(0,180);await rendered();
  assert.ok(await inspector.evaluate(n=>n.scrollTop>0),'details should scroll');assert.deepEqual(await camera(),cameraBeforeScroll,'details wheel must not zoom map');
  await action('close-inspector').click();await page.setViewportSize(oldSize);await action('fit').click();await rendered();
  console.log('map wheel passed: plain/Ctrl anchored zoom, bounded device delta/burst, live percentage, min/max, drag pan and independent detail scrolling');
}
