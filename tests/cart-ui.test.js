const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','request-client.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','public','material_list.css'),'utf8');

test('premium kiosk cart client parses and keeps request safety flow',()=>{
  assert.doesNotThrow(()=>new vm.Script(source,{filename:'public/request-client.js'}));
  assert.match(source,/function ensurePremiumCartShell\(\)/);
  assert.match(source,/function createCartProduct\(code,material,count\)/);
  assert.match(source,/function createModalCartProduct\(material,count\)/);
  assert.match(source,/cart-stepper/);
  assert.match(source,/premium-cart-review/);
  assert.match(source,/Idempotency-Key/);
  assert.match(source,/window\.sendCart=async function/);
});

test('premium kiosk cart is tablet first with desktop floating fallback',()=>{
  assert.match(css,/#offcanvasBottom\.premium-cart-drawer/);
  assert.match(css,/height:min\(72dvh,760px\)/);
  assert.match(css,/\.cart-product-main/);
  assert.match(css,/\.cart-product-thumb/);
  assert.match(css,/\.cart-stepper/);
  assert.match(css,/\.premium-cart-footer/);
  assert.match(css,/@media\(min-width:992px\)/);
  assert.match(css,/width:460px/);
});
