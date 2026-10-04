export const models=[
 {id:'meta-llama/llama-3.3-70b-instruct',name:'Llama 3.3 70B',author:'Meta',context:'128K',type:'General',private:true,price:.6,output:.9,description:'A general-purpose open-weight model for chat, synthesis and tool workflows.'},
 {id:'qwen/qwen3-32b',name:'Qwen3 32B',author:'Qwen',context:'128K',type:'Reasoning',private:true,price:.3,output:.6,description:'Explore a reasoning workload with a smaller model footprint.'},
 {id:'deepseek/deepseek-r1',name:'DeepSeek R1',author:'DeepSeek',context:'128K',type:'Reasoning',private:false,price:.7,output:1.1,description:'A reasoning-oriented example for complex, multi-step questions.'},
 {id:'mistralai/mistral-small',name:'Mistral Small',author:'Mistral',context:'32K',type:'General',private:false,price:.2,output:.4,description:'A compact example route for everyday extraction and classification.'}
];
export const providers=[{name:'North Compute',private:true,uptime:99.95,latency:410,bond:10000,quant:'bf16'},{name:'Vector Inference',private:true,uptime:99.9,latency:560,bond:12000,quant:'fp8'},{name:'East Cloud',private:false,uptime:99.8,latency:320,bond:10000,quant:'fp8'}];
export const initialWorkspace={version:1,balance:25,keys:[{id:'key_seed',name:'Research agent',token:'demo_anyr_research_0001',budget:10,spent:0,active:true}],sessions:[],receipts:[]};
export const storageKey='anyroute-preview-v1';
export function calculateCall(model,prompt){const input=Math.max(1,Math.ceil(prompt.trim().length/4));const output=64;const inference=(input*model.price+output*model.output)/1e6;const royalty=inference*.05;return {input,output,inference,royalty,cost:inference+royalty};}
export function routeCall({state,modelId,prompt,privateRoute,payWith,keyId,forceFailure=false,now=Date.now()}){
 const model=models.find(m=>m.id===modelId);if(!model)throw Error('Choose a model from the sample catalog.');
 if(!['USDG','NVDA','TSLA'].includes(payWith))throw Error('Choose USDG, NVDA or TSLA from the sample payment menu.');
 if(!prompt?.trim())throw Error('Enter a prompt before routing a call.');
 if(prompt.length>4000)throw Error('Keep the sample prompt under 4,000 characters.');
 if(privateRoute&&!model.private)throw Error('No sample attested provider serves this model. Select Llama or Qwen, or use the standard route.');
 if(forceFailure)throw Error('The sample provider timed out. No balance or budget was spent. Retry or choose another model.');
 const key=state.keys.find(k=>k.id===keyId&&k.active);if(!key)throw Error('Choose an active sample key. You can create one in API keys.');
 const usage=calculateCall(model,prompt);if(key.spent+usage.cost>key.budget)throw Error('This sample key has reached its budget. Increase its cap or choose another key.');
 const provider=providers.find(p=>!privateRoute||p.private);
 const day=new Date(now).toISOString().slice(0,10);
 let session,units=0;
 if(payWith!=='USDG'){
   session=state.sessions.find(s=>s.token===payWith&&s.active);
   if(!session)throw Error('Open an active '+payWith+' sample session in Payments before using this route.');
   units=usage.cost/(payWith==='NVDA'?100:200);
   const spent=session.day===day?session.spent:0;
   if(spent+units>session.cap)throw Error('The sample session daily cap would be exceeded. Increase its cap or pay with USDG.');
 }else if(state.balance<usage.cost)throw Error('Insufficient sample USDG. Add sample credits in Payments.');
 const receipt={id:'sample_'+now.toString(36)+'_'+Math.random().toString(36).slice(2,6),time:new Date(now).toISOString(),model:model.name,modelId:model.id,provider:provider.name,tokens:usage.input+usage.output,input:usage.input,output:usage.output,inference:usage.inference,royalty:usage.royalty,cost:usage.cost,latency:provider.latency,private:privateRoute,quant:provider.quant,paidWith:payWith,units,keyId:key.id,status:'Sample only',attestation:privateRoute?'fixture:tee-evidence-not-verified':null,signature:null,anchor:null};
 return {receipt,state:{...state,balance:payWith==='USDG'?state.balance-usage.cost:state.balance,keys:state.keys.map(k=>k.id===key.id?{...k,spent:k.spent+usage.cost}:k),sessions:state.sessions.map(s=>s.id===session?.id?{...s,day,spent:(s.day===day?s.spent:0)+units}:s),receipts:[receipt,...state.receipts].slice(0,500)}};
}
export function validWorkspace(x){
 const text=v=>typeof v==='string';const amount=v=>Number.isFinite(v)&&v>=0;
 return x?.version===1&&amount(x.balance)&&Array.isArray(x.keys)&&x.keys.length<=1000&&x.keys.every(k=>k&&text(k.id)&&text(k.name)&&text(k.token)&&typeof k.active==='boolean'&&amount(k.budget)&&amount(k.spent))
  &&Array.isArray(x.sessions)&&x.sessions.length<=2&&x.sessions.every(s=>s&&text(s.id)&&['NVDA','TSLA'].includes(s.token)&&typeof s.active==='boolean'&&text(s.day)&&amount(s.cap)&&s.cap>0&&amount(s.spent))
  &&Array.isArray(x.receipts)&&x.receipts.length<=500&&x.receipts.every(r=>r&&text(r.id)&&text(r.model)&&text(r.provider)&&text(r.time)&&Number.isFinite(Date.parse(r.time))&&['USDG','NVDA','TSLA'].includes(r.paidWith)&&typeof r.private==='boolean'&&[r.cost,r.tokens,r.input,r.output,r.inference,r.royalty,r.units].every(amount));
}
export function money(n,digits=4){return Number(n).toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits})}
export function downloadJSON(data,name){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
