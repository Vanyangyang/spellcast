/** Isolated card/API-call contract: no server, native IPC, key, model or repository. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const require=createRequire(import.meta.url);
let playwright;
try {playwright=require("playwright");} catch {playwright=require(path.join(homedir(),".cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"));}
const methods=["approveCommand","automateSigil","controlSigil","decideCheck","decideHandover","deleteSigil","dispatchSigil","executeSigil","fetchSigilDiff","fetchSigilStep","freezeSigil","noteSigil","reopenStep","rerunChecks","revertAmendment","startSigil","unfreezeSigil"];
const mockedApi=`export async function fetchSigil(){window.__calls.push('read');return structuredClone(window.__view);}
export async function reviewSigil(id,revision){window.__calls.push('review:'+revision);const v=structuredClone(window.__view);v.review={...v.review,can_freeze:false,issues:[{level:'error',code:'repository_invalid',message:'Synthetic explicit review failed'}]};return v;}
${methods.map(name=>`export async function ${name}(){window.__calls.push('${name}');throw Error('Unexpected operation');}`).join("\n")}`;
const bundled=await build({stdin:{contents:`import {mountSigilCard} from './src/sigil-card';import {setLocale} from './src/i18n';setLocale('en');window.__card=mountSigilCard(document.querySelector('#mount'),{type:'sigil',sigil_id:'client-fixture'},()=>{});`,resolveDir:root,sourcefile:"client-card-contract.ts",loader:"ts"},bundle:true,format:"iife",write:false,outfile:path.join(root,"artifacts/client-card-contract/fixture.js"),
  plugins:[{name:"isolated-api",setup(builder){builder.onLoad({filter:/[/\\]sigil-api\.ts$/},()=>({contents:mockedApi,loader:"js"}));}}]});
const view={sigil:{id:"client-fixture",title:"Pure delegated draft",goal:"No automatic file reads",repository:"C:/synthetic/not-read",location:"in_place",worktree_path:"",base_ref:"",materials:[],open_questions:[],steps:[],state:"draft",revision:1,owner_source:"",created_at_ms:1,updated_at_ms:1,updated_by:{kind:"client",label:"CCGUI"}},
  review:{can_freeze:false,issues:[{level:"error",code:"native_review_required",message:"native placeholder"}],commands:[],location:"in_place",execution_directory:"C:/synthetic/not-read"},lights:{},next:null,card_id:"sigil-client-fixture",delivery:{available:false}};
let browser;
for (const channel of ["chrome","msedge",undefined]) {try {browser=await playwright.chromium.launch({channel,headless:true});break;} catch {}}
assert.ok(browser,"An installed browser is required");
let checks=0;
try {
  for (const native of [true,false]) {
    const context=await browser.newContext();
    await context.route("**/*",r=>r.request().url()==="http://client-card.test/"?r.fulfill({contentType:"text/html",body:'<main id="mount"></main>'}):r.abort());
    await context.addInitScript(({native,view})=>{
      window.__view=view;window.__calls=[];window.isTauri=native;
      if(native)window.__TAURI_INTERNALS__={invoke:async()=>1,transformCallback:()=>1};
    },{native,view});
    const page=await context.newPage(); const errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.goto("http://client-card.test/");await page.addScriptTag({content:bundled.outputFiles.find(f=>f.path.endsWith(".js")).text});
    await page.getByText("Pure delegated draft",{exact:true}).waitFor();
    await page.evaluate(()=>window.__card.refresh());
    await page.waitForFunction(()=>window.__calls.filter(x=>x==='read').length>=2);
    assert.deepEqual((await page.evaluate(()=>window.__calls)).filter(x=>x!=='read'),[]);
    assert.match(await page.locator('#mount').innerText(),/has not inspected the repository/);
    console.log(`ok ${++checks} - ${native?'native':'preview'} mount/refresh performs no review or write`);
    if(native) {
      await page.getByRole("button",{name:"Review in Spellcast…",exact:true}).click();
      await page.waitForFunction(()=>window.__calls.includes('review:1'));
      await page.getByText("Synthetic explicit review failed",{exact:true}).waitFor();
      assert.deepEqual((await page.evaluate(()=>window.__calls)).filter(x=>x!=='read'),['review:1']);
      console.log(`ok ${++checks} - explicit native click reviews once and failure never freezes or executes`);
    } else assert.equal(await page.getByRole("button",{name:"Review in Spellcast…",exact:true}).count(),0);
    assert.deepEqual(errors,[]);await page.evaluate(()=>window.__card.destroy());await context.close();
  }
  console.log(`Passed ${checks} synthetic client draft card checks. No real API/IPC/authorization.`);
} finally {await browser.close();}
