const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','request-client.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','public','material_list.css'),'utf8');

test('kiosk List client parses and keeps request safety flow',()=>{
  assert.doesNotThrow(()=>new vm.Script(source,{filename:'public/request-client.js'}));
  assert.match(source,/function ensurePremiumCartShell\(\)/);
  assert.match(source,/function createCartProduct\(code,material,count\)/);
  assert.match(source,/function createModalCartProduct\(material,count\)/);
  assert.match(source,/cart-stepper/);
  assert.match(source,/premium-cart-review/);
  assert.match(source,/Idempotency-Key/);
  assert.match(source,/window\.sendCart=async function/);
  assert.doesNotMatch(source,/장바구니/);
});

test('quantity changes reuse List rows instead of rebuilding thumbnails',()=>{
  assert.match(source,/function reconcileListRows\(container,entries,modal=false\)/);
  assert.match(source,/function updateCartProduct\(article,material,count\)/);
  assert.match(source,/function adjustListQuantity\(code,delta\)/);
  assert.doesNotMatch(source,/cartItemsElement\.replaceChildren\(\)/);
});

test('newly selected material is focused in List without quantity-step scrolling',()=>{
  assert.match(source,/function focusListItem\(code,highlight=true\)/);
  assert.match(source,/scrollIntoView\(\{behavior:'smooth',block:'nearest'\}\)/);
  assert.match(source,/updateCart\(\{focusCode:key,highlight:true\}\)/);
  assert.match(source,/updateCart\(\{focusCode:'',highlight:false\}\)/);
});

test('List is tablet first, keeps bottom items clear and has visible primary CTA',()=>{
  assert.match(css,/#offcanvasBottom\.premium-cart-drawer/);
  assert.match(css,/height:min\(76dvh,790px\)/);
  assert.match(css,/scroll-padding-bottom:128px/);
  assert.match(css,/\.cart-product-main/);
  assert.match(css,/\.cart-product-thumb/);
  assert.match(css,/\.cart-stepper/);
  assert.match(css,/\.premium-cart-review/);
  assert.match(css,/linear-gradient\(135deg,#0d6efd,#2563eb\)/);
  assert.match(css,/\.kiosk-list-action/);
  assert.match(css,/@media\(min-width:992px\)/);
  assert.match(css,/width:470px/);
});
