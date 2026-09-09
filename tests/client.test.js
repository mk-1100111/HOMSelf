const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const vm=require('node:vm');

function browserContext({cartQuantities,material_list,failInitially=false}){
  const saved=new Map(),sent=[];let fail=failInitially;
  const storage={getItem:k=>saved.get(k)||null,setItem:(k,v)=>saved.set(k,v),removeItem:k=>saved.delete(k)};
  const context={localStorage:storage,sessionStorage:{...storage,getItem:()=> 'k'.repeat(40)},window:{},
    document:{getElementById:()=>null},alert:()=>{},confirm:()=>true,prompt:()=>null,
    location:{search:'?managerName=TEST',assign:()=>{}},URLSearchParams,
    crypto:{randomUUID:()=> '12345678-1234-1234'},cartQuantities,material_list,
    fetch:async(url,options)=>{sent.push(options);if(fail)throw Error('response lost');return {ok:true,json:async()=>({request_id:'ack'})};}};
  context.setFail=value=>{fail=value;};
  vm.createContext(context);vm.runInContext(fs.readFileSync('public/request-client.js','utf8'),context);
  return {context,storage,sent};
}

test('browser response loss retains same key and exact payload until acknowledged',async()=>{
  const {context,storage,sent}=browserContext({
    failInitially:true,
    cartQuantities:{'1':2},
    material_list:[{material_name:'Test',material_code:'1',material_unit:10}]
  });
  await context.window.sendCart();assert.ok(storage.getItem('homself.pending.v1'));
  context.cartQuantities['1']=9;context.setFail(false);await context.window.sendCart();
  assert.equal(sent[0].body,sent[1].body);assert.equal(sent[0].headers['Idempotency-Key'],sent[1].headers['Idempotency-Key']);
  assert.equal(JSON.parse(sent[1].body).items[0].quantity,20);assert.equal(storage.getItem('homself.pending.v1'),null);
});

test('same HOMS material name keeps separate material codes in kiosk cart payload',async()=>{
  const {context,sent}=browserContext({
    cartQuantities:{'10000060837':1,'10000060838':2},
    material_list:[
      {material_code:'10000060836',material_name:'FTTx 인식표',material_unit:100,display_name:'FTTx 인식표'},
      {material_code:'10000060837',material_name:'FTTx 인식표',material_unit:1,display_name:'FTTx 인식표 (주황)'},
      {material_code:'10000060838',material_name:'FTTx 인식표',material_unit:1,display_name:'FTTx 인식표 (보라)'}
    ]
  });
  await context.window.sendCart();
  const body=JSON.parse(sent[0].body);
  assert.deepEqual(body.items,[
    {material_code:'10000060837',quantity:1},
    {material_code:'10000060838',quantity:2}
  ]);
});
