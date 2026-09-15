import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const stage=process.argv[2]||'snapshot'; assert(/^[a-z0-9-]+$/.test(stage));
const output=path.resolve(import.meta.dirname,'../artifacts/workbench-20260914/native-sync-20260914');
const [board,feedback]=await Promise.all(['board','feedback'].map(async name=>{const r=await fetch('http://127.0.0.1:47194/api/'+name);assert(r.ok);return r.json();}));
const fixture='sync-delivery-test-20260914';
const original=JSON.parse(fs.readFileSync(path.join(output,'production-before.json'),'utf8'));
const compared=[];
const identity=item=>item.id??item.object_id??item.item_id;
for(const key of ['nodes','edges','replies','messages']) for(const [index,item] of original[key].entries()) { assert.deepEqual(item.id?board[key].find(x=>x.id===item.id):board[key][index],item,key+':'+(item.id??index)); compared.push(key+':'+(item.id??index)); }
for(const key of ['objects','items','compositions']) {
  const before=original.canvas[key]; if(!before)continue;
  if(Array.isArray(before)) for(const item of before.filter(x=>identity(x)!==fixture)){const id=identity(item);assert(id,key+' missing identity');assert.deepEqual(board.canvas[key].find(x=>identity(x)===id),item,key+':'+id);compared.push(key+':'+id);}
  else for(const [id,item] of Object.entries(before)) if(id!==fixture){assert.deepEqual(board.canvas[key][id],item,key+':'+id);compared.push(key+':'+id);}
}
const receipts=feedback.deliveries.filter(r=>r.event.source_id==='community-tools-01a09e5a'&&r.event.seq>=57);
for(const key of ['topic','form','form_reason']) assert.deepEqual(board[key],original[key]);
original.canvas.proposals.forEach((proposal,index)=>assert.deepEqual(board.canvas.proposals[index],proposal,'proposals:'+index));
const result={stage,time:new Date().toISOString(),preserved:true,compared,object:board.canvas.objects.find(x=>x.id===fixture),placement:board.canvas.items.find(x=>identity(x)===fixture),newProposals:board.canvas.proposals.slice(original.canvas.proposals.length),receipts};
fs.writeFileSync(path.join(output,stage+'.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({stage,preserved:true,object:result.object,receipts:receipts.map(r=>({seq:r.event.seq,phase:r.phase,desktop:r.desktop,received:r.received_at_ms,responded:r.responded_at_ms,handled:r.handled_at_ms,objects:r.response_object_ids,error:r.error}))}));
