import { onLocale } from "./i18n";
import { gt } from "./i18n/game";
import { pt } from "./i18n/projects";
import { type Project,type WorkRecord } from "./project-record-api";
import { connectGame,fetchGameConnection,fetchGameView,fetchGameSource,submitGameAction,type GameConnection,type GameZoneSummary,type GameResponse,type GameLocation,type GameSource,type GameAction } from "./project-game-api";
import "./project-game.css";

const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text="")=>{const element=document.createElement(tag);element.textContent=text;return element;};
const btn=(label:string,action:()=>void)=>{const button=el("button",label);button.type="button";button.addEventListener("click",action);return button;};
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
const readLocal=<T>(key:string):T|undefined=>{try{return JSON.parse(localStorage.getItem(key)||"null")??undefined;}catch{return undefined;}};
const writeLocal=(key:string,value:unknown)=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{/* Server records remain canonical. */}};
type Draft={intent:"modify"|"verify";prompt:string;target:string;pending?:{id:string;fingerprint:string}};
const badge=(text:string,tone="")=>{const element=el("span",text);element.className=`game-badge ${tone}`;return element;};
function decoded(value:string){try{return decodeURI(value).replaceAll("\\","/");}catch{return value.replaceAll("\\","/");}}

export function createProjectGameView(options:{openRecord:(id:string)=>void;onChanged:()=>void}) {
  const element=el("section");element.className="project-game-panel";element.setAttribute("aria-label",gt("objects"));
  let project:Project|undefined,connection:GameConnection|null=null,zones:GameZoneSummary[]=[],data:GameResponse|undefined;
  let selected:string|null=null,zoneId="",busy=false,error="",notice="",allZones=false,epoch=0,draft:Draft|undefined,sending=false;
  const sourceDialog=document.createElement("dialog");sourceDialog.className="project-game-source-view";element.append(sourceDialog);
  const body=el("div");body.className="project-game-body";element.append(body);
  const key=(part:string)=>`spellcast.game.v1.${project?.id}.${part}`;
  const draftKey=()=>key(`draft.${zoneId}.${selected??"zone"}`);
  function saveDraft(){if(draft)writeLocal(draftKey(),draft);}
  function selection(){return selected?data?.view.locations.find(item=>item.id===selected):undefined;}
  function selectedSources():GameSource[]{
    if(!data)return [];const node=selection();if(!node)return data.view.sources;
    const paths=new Set([data.view.zone.path,node.path,...node.candidates.flatMap(item=>item.paths)]);
    return data.view.sources.filter(source=>paths.has(source.path));
  }
  function select(id:string|null){if(busy)return;selected=id;draft=undefined;writeLocal(key("selection"),{zoneId,selected});notice="";render();}
  function openDraft(intent:"modify"|"verify"){
    if(busy)return;
    const saved=readLocal<Draft>(draftKey());draft=saved?.intent===intent?saved:{intent,prompt:intent==="verify"?gt("verifyPrompt"):"",target:""};
    render();body.querySelector<HTMLTextAreaElement>("[data-game-prompt]")?.focus();
  }
  async function copy(text:string){try{await navigator.clipboard.writeText(text);notice=gt("copied");render();}catch(e){error=message(e);render();}}
  function objectContext(){
    if(!data||!project)return "";const node=selection();
    return JSON.stringify({project:project.name,project_id:project.id,project_root:connection?.root,zone_id:zoneId,location_id:node?.id??null,name:node?.name??data.view.zone.name,source_revision:data.view.source_revision,configuration_candidates_only:true,user_request:draft?.prompt||"",sources:selectedSources().map(source=>({path:source.path,hash:source.hash}))},null,2);
  }
  async function showSource(path:string){
    if(!project)return;
    sourceDialog.replaceChildren(el("p",gt("loading")));if(!sourceDialog.open)sourceDialog.showModal();
    try{
      const source=await fetchGameSource(project.id,path);sourceDialog.replaceChildren();
      const header=el("header");header.append(el("h3",path.split("/").at(-1)||path),btn(gt("close"),()=>sourceDialog.close()));
      const controls=el("div");controls.className="game-actions";
      controls.append(btn(gt("copyPath"),()=>void navigator.clipboard.writeText(`${connection?.root}/${path}`)),btn(gt("openSource"),()=>void openSource(path)));
      const saved=data?.view.sources.find(item=>item.path===path);if(saved&&saved.hash!==source.hash)controls.append(badge(gt("stale"),"warning"));
      const pre=el("pre",JSON.stringify(source.json,null,2));pre.dataset.gameSourceJson="true";
      sourceDialog.append(header,el("p",path),el("small",`SHA-256 ${source.hash}`),controls,pre);
    }catch(e){sourceDialog.replaceChildren(el("p",message(e)),btn(gt("close"),()=>sourceDialog.close()));}
  }
  async function openSource(path:string){
    try{const {invoke}=await import("@tauri-apps/api/core");await invoke("open_project_game_source",{projectId:project?.id,path});}
    catch(e){sourceDialog.append(el("p",message(e)));}
  }
  function renderGraph(container:HTMLElement){
    if(!data)return;const view=data.view;
    const distances=new Map<string,number>();const queue:string[]=[];
    if(view.locations.some(node=>node.id===view.entry)){distances.set(view.entry,0);queue.push(view.entry);}
    while(queue.length){const current=queue.shift()!;for(const edge of view.routes){const next=edge.from===current?edge.to:edge.to===current?edge.from:undefined;if(next&&!distances.has(next)){distances.set(next,distances.get(current)!+1);queue.push(next);}}}
    const last=Math.max(0,...distances.values());for(const node of view.locations)if(!distances.has(node.id))distances.set(node.id,last+1);
    const levels=new Map<number,GameLocation[]>();for(const node of view.locations){const depth=distances.get(node.id)!;const group=levels.get(depth)||[];group.push(node);levels.set(depth,group);}
    for(const group of levels.values())group.sort((a,b)=>a.y-b.y||a.id.localeCompare(b.id));
    const columns=Math.max(1,levels.size),rows=Math.max(1,...[...levels.values()].map(group=>group.length));
    const width=Math.max(550,columns*165),height=Math.max(300,rows*110+50);
    const scroll=el("div");scroll.className="game-graph-scroll";
    const stage=el("div");stage.className="game-graph";stage.style.width=`${width}px`;stage.style.height=`${height}px`;stage.dataset.gameGraph="true";
    const positions=new Map<string,{x:number;y:number}>();
    for(const [column,group]of levels)group.forEach((node,index)=>positions.set(node.id,{x:(column+.5)*width/columns,y:(index+.5)*height/group.length}));
    const svg=document.createElementNS("http://www.w3.org/2000/svg","svg");svg.setAttribute("viewBox",`0 0 ${width} ${height}`);svg.setAttribute("aria-hidden","true");
    for(const edge of view.routes){const from=positions.get(edge.from),to=positions.get(edge.to);if(!from||!to)continue;const line=document.createElementNS(svg.namespaceURI,"path");line.setAttribute("d",`M ${from.x} ${from.y} L ${to.x} ${to.y}`);if(selected===edge.from||selected===edge.to)line.classList.add("selected");svg.append(line);}
    stage.append(svg);
    for(const node of view.locations){const pos=positions.get(node.id)!;const button=btn("",()=>select(node.id));button.className="game-location";button.dataset.gameLocation=node.id;button.setAttribute("aria-pressed",String(selected===node.id));button.style.left=`${pos.x}px`;button.style.top=`${pos.y}px`;if(node.missing)button.classList.add("missing");button.append(el("strong",node.name),el("small",node.id===view.entry?gt("entry"):node.role==="gate"?gt("gate"):node.role==="shop"?gt("shop"):gt("location")));stage.append(button);}
    scroll.append(stage);container.append(scroll,el("small",gt("graphHelp")));
  }
  function sourceButtons(container:HTMLElement,paths:string[]){for(const path of [...new Set(paths)]){const button=btn(path.split("/").at(-1)||path,()=>void showSource(path));button.className="game-source-button";button.title=path;button.dataset.gameSource=path;container.append(button);}}
  function renderInspector(container:HTMLElement){
    if(!data)return;const view=data.view,node=selection();
    container.dataset.gameInspector="true";
    const heading=el("header");heading.append(el("h3",node?.name??view.zone.name),badge(node?gt("selected"):gt("wholeZone")));container.append(heading,el("code",node?.id??view.zone.id),el("p",node?.description??view.description));
    const actions=el("div");actions.className="game-actions";actions.append(btn(gt("modify"),()=>openDraft("modify")),btn(gt("verify"),()=>openDraft("verify")),btn(gt("copyContext"),()=>void copy(objectContext())));container.append(actions);
    if(node){
      const neighbors=view.routes.flatMap(edge=>edge.from===node.id?[edge.to]:edge.to===node.id?[edge.from]:[]);
      const box=el("section");box.append(el("h4",gt("neighbors")));const links=el("div");links.className="game-actions";
      for(const id of neighbors)links.append(btn(view.locations.find(item=>item.id===id)?.name||id,()=>select(id)));
      box.append(links);if(!neighbors.length)box.append(el("small",gt("noNeighbors")));container.append(box);
      container.append(el("h4",gt("candidates")));
      if(!node.candidates.length)container.append(el("p",gt("noCandidates")));
      for(const candidate of node.candidates){
        const card=el("article");card.className="game-candidate";card.dataset.gameCandidate=candidate.id;
        const title=el("header");title.append(el("strong",candidate.name),badge(candidate.kind));card.append(title,el("code",candidate.id));
        const tags=el("div");tags.className="game-actions";if(candidate.first_entry)tags.append(badge(gt("first")));if(candidate.gate)tags.append(badge(gt("gate")));if(candidate.weight!==null)tags.append(badge(`${gt("weight")} ${candidate.weight}`));if(candidate.missing)tags.append(badge(gt("missing"),"warning"));card.append(tags);
        if(candidate.description)card.append(el("p",candidate.description));
        if(candidate.associated_id){card.append(el("small",gt("associated")),el("strong",candidate.associated_name||candidate.associated_id),el("code",candidate.associated_id));}
        if(candidate.enemies.length)card.append(el("small",gt("enemies")),el("p",candidate.enemies.join("\n")));
        const sources=el("div");sources.className="game-source-links";sourceButtons(sources,candidate.paths);card.append(sources);container.append(card);
      }
      if(node.unlocks_zone)container.append(el("p",`${gt("gate")} → ${node.unlocks_zone}`));
    }
    const sources=el("section");sources.className="game-source-links";sources.append(el("h4",gt("source")));sourceButtons(sources,[view.zone.path,...(node?.path?[node.path]:[])]);container.append(sources);
    renderRecords(container);
  }
  function associatedRecords():WorkRecord[]{
    if(!data)return [];const id=selected?data.object_ids.find(item=>item.location_id===selected)?.object_id:data.zone_object_id;
    const paths=new Set(selectedSources().map(source=>source.path));
    const zoneObjects=new Set([data.zone_object_id,...data.object_ids.map(item=>item.object_id)]);
    return data.records.filter(record=>{
      if(record.object_id?.startsWith("game-vesperix-")) return selected
        ? record.object_id===id || record.object_id===data!.zone_object_id
        : zoneObjects.has(record.object_id);
      return record.object_id===id || (record.references||[]).some(reference=>[...paths].some(path=>decoded(reference.uri).endsWith(path)));
    });
  }
  function renderRecords(container:HTMLElement){
    const records=associatedRecords();const section=el("section");section.className="game-related-records";section.append(el("h4",gt("results")),el("small",gt("resultHint")));
    if(!records.length)section.append(el("p",gt("noResults")));
    for(const record of records){const card=el("article");card.className="game-result";card.append(el("strong",record.title),badge(pt(({planned:"statusPlanned",active:"statusActive",blocked:"statusBlocked",done:"statusDone",cancelled:"statusCancelled"} as const)[record.status||"planned"])));
      const known=(record.references||[]).flatMap(ref=>{const source=data?.view.sources.find(s=>decoded(ref.uri).endsWith(s.path));return source&&/^[a-f0-9]{64}$/i.test(ref.version)?[{matches:source.hash===ref.version}]:[];});
      card.append(el("small",known.some(v=>!v.matches)?gt("stale"):known.length?gt("versionMatches"):gt("unknownVersion")),el("p",record.result||gt("notExecuted")));
      if(record.boundaries)card.append(el("small",record.boundaries));card.append(btn(gt("openRecord"),()=>options.openRecord(record.id)));section.append(card);}
    container.append(section);
  }
  function renderDraft(container:HTMLElement){
    if(!draft||!data)return;const current=draft;const form=el("form");form.className="game-request";form.dataset.gameRequest="true";
    form.append(el("h4",`${gt("request")} · ${gt(current.intent)} · ${selection()?.name??data.view.zone.name}`));
    const label=el("label",gt("prompt")),input=el("textarea");input.value=current.prompt;input.disabled=sending;input.maxLength=1500;input.rows=5;input.dataset.gamePrompt="true";label.append(input);form.append(label);
    const targetLabel=el("label",gt("target")),select=el("select");select.disabled=sending;select.dataset.gameTarget="true";const none=el("option",gt("chooseTarget"));none.value="";select.append(none);
    for(const target of data.targets){const option=el("option",`${target.label} · ${target.thread_id.slice(0,8)}`);option.value=target.source_id;select.append(option);}select.value=current.target;targetLabel.append(select);form.append(targetLabel);
    const send=btn(gt("send"),()=>{});send.type="submit";send.className="primary";send.dataset.gameSend="true";
    const update=()=>{send.disabled=busy||sending||!current.prompt.trim()||!data?.targets.some(target=>target.source_id===current.target);};
    input.addEventListener("input",()=>{current.prompt=input.value;saveDraft();update();});select.addEventListener("change",()=>{current.target=select.value;saveDraft();update();});update();
    if(!data.targets.length)form.append(el("p",gt("noTargets")));
    const actions=el("div");actions.className="game-actions";actions.append(send,btn(gt("copyContext"),()=>void copy(objectContext())),btn(gt("cancel"),()=>{saveDraft();draft=undefined;render();}));form.append(actions,el("small",gt("savedDraft")),el("small",gt("sourceChanged")));
    form.addEventListener("submit",event=>{event.preventDefault();void sendRequest();});container.append(form);
  }
  async function sendRequest(){
    if(!project||!data||!draft||sending||busy)return;const target=data.targets.find(t=>t.source_id===draft!.target);if(!target)return;
    const projectId=project.id;const current=draft;const body={zone_id:zoneId,location_id:selected,expected_source_revision:data.view.source_revision,intent:current.intent,prompt:current.prompt.trim(),source_id:target.source_id,target_thread_id:target.thread_id};const fingerprint=JSON.stringify(body);
    if(current.pending?.fingerprint!==fingerprint)current.pending={id:crypto.randomUUID(),fingerprint};saveDraft();
    const request:GameAction={...body,request_id:current.pending.id};const storageKey=draftKey(),savedDraft=JSON.stringify(current);
    const stillCurrent=()=>project?.id===projectId&&zoneId===body.zone_id&&selected===body.location_id&&draft===current;
    sending=true;error="";notice=gt("sending");render();
    try{const result=await submitGameAction(projectId,request);try{if(JSON.stringify(readLocal<Draft>(storageKey))===savedDraft)localStorage.removeItem(storageKey);}catch{}options.onChanged();if(!stillCurrent())return;notice=gt("submitted");if(result.delivery?.error)notice+=` ${result.delivery.error}`;draft=undefined;await loadZone(zoneId,false);}
    catch(e){if(stillCurrent())error=message(e);}
    finally{sending=false;render();}
  }
  function render(){
    body.replaceChildren();element.setAttribute("aria-label",gt("objects"));
    if(!project){body.append(el("p",gt("noProject")));return;}
    const toolbar=el("header");toolbar.className="game-toolbar";toolbar.append(el("h3",gt("objects")));
    const refresh=btn(gt("refresh"),()=>void refreshView());refresh.disabled=busy||sending;refresh.dataset.gameRefresh="true";toolbar.append(refresh);body.append(toolbar);
    if(error){const alert=el("p",error);alert.className="game-error";alert.setAttribute("role","alert");body.append(alert);}if(notice){const status=el("p",notice);status.setAttribute("role","status");body.append(status);}
    if(busy)body.append(el("p",gt("loading")));
    if(!connection){
      const form=el("form");form.className="game-connect";const label=el("label",gt("root")),input=el("input");input.value=project.aliases[0]||"";input.dataset.gameRoot="true";label.append(input);const submit=btn(gt("connect"),()=>{});submit.type="submit";submit.disabled=busy;submit.dataset.gameConnect="true";form.append(el("p",gt("connectionHelp")),label,submit);form.addEventListener("submit",event=>{event.preventDefault();void connect(input.value);});body.append(form);return;
    }
    body.append(el("small",connection.root));
    if(!zones.length){if(!busy)body.append(el("p",gt("noZones")));return;}
    const picker=el("div");picker.className="game-zone-picker";const label=el("label",gt("zone")),select=el("select");select.disabled=busy||sending;select.dataset.gameZone="true";
    for(const zone of zones.filter(zone=>allZones||zone.routes>0||zone.id===zoneId)){const option=el("option",`${zone.name} · ${zone.locations}`);option.value=zone.id;select.append(option);}select.value=zoneId;select.addEventListener("change",()=>{saveDraft();draft=undefined;selected=null;void loadZone(select.value);});label.append(select);
    const toggle=el("label"),check=el("input");check.type="checkbox";check.checked=allZones;check.addEventListener("change",()=>{allZones=check.checked;render();});toggle.append(check,document.createTextNode(gt("allZones")));picker.append(label,toggle,btn(gt("wholeZone"),()=>selectWhole()));body.append(picker);
    if(!data)return;
    const status=el("div");status.className="game-view-status";status.append(badge(gt("configuration")),el("span",gt("runtime")));body.append(status);
    if(draft)renderDraft(body);
    const browser=el("div");browser.className="game-browser";const map=el("section");map.className="game-map";renderGraph(map);
    if(data.view.issues.length){const details=el("details");details.className="game-issues";details.append(el("summary",`${gt("issues")} · ${data.view.issues.length}`));for(const issue of data.view.issues){const line=el("p",issue.message);line.title=issue.path;details.append(line);}map.append(details);}
    map.append(el("small",gt("readonly")));const inspector=el("section");inspector.className="game-inspector";renderInspector(inspector);browser.append(map,inspector);body.append(browser);
  }
  function selectWhole(){select(null);}
  async function connect(root:string){
    if(!project||busy)return;busy=true;error="";render();try{connection=await connectGame(project.id,root,connection?.revision||0,crypto.randomUUID());await refreshView(false);}catch(e){error=message(e);}finally{busy=false;render();}
  }
  async function loadZone(id:string,clearNotice=true,refresh=false){
    if(!project)return;const version=++epoch,projectId=project.id;busy=true;error="";if(clearNotice)notice="";render();
    try{
      if(!connection){const connected=await fetchGameConnection(projectId);if(version!==epoch||project?.id!==projectId)return;connection=connected.connection;if(!connection){zones=[];data=undefined;return;}}
      const next=await fetchGameView(projectId,id,refresh);if(version!==epoch||project?.id!==projectId)return;
      if(next.view===null){saveDraft();draft=undefined;selected=null;zoneId=next.selected_zone_id||"";data=undefined;error=next.view_error||"";}
      else{
        if(zoneId!==next.view.zone.id||(selected&&!next.view.locations.some(item=>item.id===selected))){saveDraft();draft=undefined;selected=null;}
        data=next;zoneId=next.view.zone.id;
      }
      zones=next.zones;connection=next.connection;writeLocal(key("selection"),{zoneId,selected});
    }
    catch(e){if(version===epoch)error=message(e);}
    finally{if(version===epoch){busy=false;render();}}
  }
  async function refreshView(refresh=true){
    await loadZone(zoneId,false,refresh);
  }
  window.addEventListener("focus",()=>{if(!element.hidden&&element.closest("dialog")?.open&&connection&&!draft&&!busy&&!sourceDialog.open)void refreshView(false);});
  onLocale(render);render();
  return {element,refresh:()=>refreshView(false),async setProject(next:Project|undefined){
    if(project?.id===next?.id){project=next;return !!connection;}saveDraft();project=next;connection=null;zones=[];data=undefined;draft=undefined;selected=null;zoneId="";error="";notice="";++epoch;
    const saved=readLocal<{zoneId:string;selected:string|null}>(key("selection"));if(saved){zoneId=saved.zoneId;selected=saved.selected;}render();
    if(project){await refreshView(false);return !!connection;}return false;
  }};
}
