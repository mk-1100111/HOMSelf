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

test('tablet List is smaller, minimizable and keeps primary CTA visible',()=>{
  assert.match(source,/function setListMinimized\(minimized\)/);
  assert.match(source,/class=\"list-minimize-btn\"/);
  assert.match(source,/List 내리기/);
  assert.match(css,/height:min\(52dvh,520px\)/);
  assert.match(css,/\.premium-cart-drawer\.is-minimized\{height:148px/);
  assert.match(css,/\.is-minimized \.premium-cart-scroll\{display:none\}/);
  assert.match(css,/\.is-minimized \.premium-cart-footer-summary\{display:none\}/);
  assert.match(css,/\.premium-cart-review/);
  assert.match(css,/linear-gradient\(135deg,#0d6efd,#2563eb\)/);
  assert.match(css,/body\.list-panel-open #material-lists\{margin-bottom:58dvh\}/);
});

test('kiosk header typography and List badges are restored for tablet readability',()=>{
  assert.match(css,/\.navbar #welcome-ms\{[^}]*font-size:120%/);
  assert.match(css,/\.kiosk-list-label\{[^}]*font-size:1em/);
  assert.match(css,/\.kiosk-list-badge\{[^}]*min-width:34px[^}]*height:34px[^}]*font-size:\.9rem/);
  assert.match(css,/\.premium-cart-head-summary\{[^}]*font-size:\.96rem/);
  assert.match(css,/\.premium-cart-review-count\{[^}]*font-size:\.95rem/);
});

test('List items omit specification option details',()=>{
  const productSection=source.slice(source.indexOf('function createCartProduct'),source.indexOf('function updateCartProduct'));
  const modalSection=source.slice(source.indexOf('function createModalCartProduct'),source.indexOf('function updateModalCartProduct'));
  assert.doesNotMatch(productSection,/specification/);
  assert.doesNotMatch(modalSection,/specification/);
  assert.match(productSection,/상품코드/);
  assert.match(productSection,/불출단위/);
});
