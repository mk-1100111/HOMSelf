const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');
test('browser response loss retains same key and exact payload until acknowledged',async()=>{
  const saved=new Map(),sent=[];let fail=true;
  const storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const context={localStorage:storage,sessionStorage:{...storage,getItem:()=> 'k'.repeat(40)},window:{},
    document:{getElementById:()=>null},alert:()=>{},confirm:()=>true,prompt:()=>null,
    location:{search:'?managerName=TEST',assign:()=>{}},URLSearchParams,
    crypto:{randomUUID:()=> '12345678-1234-1234'},cartQuantities:{Test:2},material_list:[{material_name:'Test',material_code:'1',material_unit:10}],
    fetch:async(url,options)=>{sent.push(options);if(fail)throw Error('response lost');return {ok:true,json:async()=>({request_id:'ack'})};}};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/request-client.js','utf8'),context);
  await context.window.sendCart();assert.ok(storage.getItem('homself.pending.v1'));
  context.cartQuantities.Test=9;fail=false;await context.window.sendCart();
  assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].headers['Idempotency-Key'],sent[1].headers['Idempotency-Key']);
  assert.equal(JSON.parse(sent[1].body).items[0].quantity,20);assert.equal(storage.getItem('homself.pending.v1'),null);
});
