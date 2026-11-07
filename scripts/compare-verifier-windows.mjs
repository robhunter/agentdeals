import {readFileSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {verifyOfferAgainstPage,createVerifierClient,VERIFIER_MODEL} from './verify-freshness.js';
import {verifyOfferAgainstPage as oldVerifier} from './verify-freshness-old-window.js';

const output='verifier-window-comparison';
const sets=JSON.parse(readFileSync(`${output}/sets.json`));
const pages=JSON.parse(readFileSync(`${output}/pages.json`));
const results=JSON.parse(readFileSync(`${output}/seed-results.json`));
const hash=text=>createHash('sha256').update(text).digest('hex');
const tasks=[];
for(const [set,entries] of Object.entries(sets)){
 assert.equal(entries.length,43);
 for(const {offer} of entries){
  const page=pages[offer.url]; assert.ok(page.ok,offer.url); assert.equal(hash(page.text),page.sha256);
  for(const run of ['old-1','old-2','new']) if(!results.some(r=>r.set===set&&r.url===offer.url&&r.run===run)) tasks.push({set,offer,run});
 }
}
assert.equal(results.length,255);
assert.equal(tasks.length,3);
if(process.argv.includes('--preflight')){console.log('86 listings, 86 shared saved pages, 255 preserved results and 3 replacement requests');process.exit(0)}
let next=0;
await Promise.all(Array.from({length:4},async()=>{
 while(next<tasks.length){
  const {set,offer,run}=tasks[next++];
  const entry={set,vendor:offer.vendor,tier:offer.tier,url:offer.url,run,started_at:new Date().toISOString()};
  const client=createVerifierClient({fetchImpl:async(url,init)=>{
   const body=JSON.parse(init.body); assert.equal(body.model,VERIFIER_MODEL);assert.equal(body.max_tokens,400);assert.equal(body.temperature,0);assert.deepEqual(body.reasoning,{enabled:false});
   const prompt=body.messages[0].content;
   entry.request={model:body.model,max_tokens:body.max_tokens,temperature:body.temperature,reasoning:body.reasoning,prompt_sha256:hash(prompt),page_sha256:pages[offer.url].sha256};
   const response=await fetch(url,{...init,signal:AbortSignal.timeout(90000)});
   const raw=await response.text();
   if(!response.ok)return {ok:false,status:response.status,text:async()=>raw};
   const payload=JSON.parse(raw);
   entry.generation_id=payload.id;entry.usage=payload.usage;entry.raw_content=payload.choices?.[0]?.message?.content;entry.finish_reason=payload.choices?.[0]?.finish_reason;
   return {ok:true,json:async()=>payload};
  }});
  try{entry.verdict=await (run==='new'?verifyOfferAgainstPage:oldVerifier)(client,offer,pages[offer.url].text)}catch(error){entry.error=error.message}
  entry.finished_at=new Date().toISOString(); results.push(entry);
  writeFileSync(`${output}/results.json`,JSON.stringify(results,null,2));
  console.log(`${results.length}/${tasks.length} ${set} ${run} ${offer.vendor} (${offer.tier}): ${entry.verdict?.status??entry.error}`);
 }
}));
const counts={};
for(const set of Object.keys(sets))for(const run of ['old-1','old-2','new']){
 const rows=results.filter(r=>r.set===set&&r.run===run);
 counts[`${set}/${run}`]={total:rows.length,...Object.fromEntries(['confirmed','changed','unclear'].map(status=>[status,rows.filter(r=>r.verdict?.status===status).length])),errors:rows.filter(r=>r.error).length,input_tokens:rows.reduce((n,r)=>n+(r.usage?.prompt_tokens??0),0),response_reported_cost:rows.reduce((n,r)=>n+(r.usage?.cost??0),0)};
}
const old1=counts['control/old-1'].confirmed,old2=counts['control/old-2'].confirmed,candidate=counts['control/new'].confirmed;
const missingFigureLanguage=r=>/truncat|(?:does not|doesn.t|not|no|lack|missing|absen|cannot|can.t)[\s\S]{0,100}(?:figur|detail|limit|quota|allowance|number|amount)|(?:figur|detail|limit|quota|allowance|number|amount)[\s\S]{0,100}(?:not|lack|missing|absen)/i.test(r.raw_content??'');
const mentions={};
for(const run of ['old-1','old-2','new']) mentions[run]=results.filter(r=>r.set==='affected'&&r.run===run&&missingFigureLanguage(r)).map(r=>({vendor:r.vendor,tier:r.tier,verdict:r.verdict,raw_content:r.raw_content}));
const summary={model:VERIFIER_MODEL,counts,complete:results.every(r=>!r.error),control:{old1,old2,candidate,old_spread:Math.abs(old1-old2),difference_from_old1:Math.abs(candidate-old1),difference_from_old2:Math.abs(candidate-old2),within_both:Math.abs(candidate-old1)<=Math.abs(old1-old2)&&Math.abs(candidate-old2)<=Math.abs(old1-old2)},affected_missing_figure_language:mentions,cost_status:'Response reported, unreconciled against billing',total_response_reported_cost:results.reduce((n,r)=>n+(r.usage?.cost??0),0)};
writeFileSync(`${output}/summary.json`,JSON.stringify(summary,null,2));
console.log(JSON.stringify({counts,complete:summary.complete,control:summary.control,missing_language_counts:Object.fromEntries(Object.entries(mentions).map(([k,v])=>[k,v.length])),cost:summary.total_response_reported_cost},null,2));
if(!summary.complete)process.exitCode=1;
