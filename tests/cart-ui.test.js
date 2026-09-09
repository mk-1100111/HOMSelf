const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','request-client.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','public','material_list.css'),'utf8');
const mainCss=fs.readFileSync(path.join(__dirname,'..','public','main.css'),'utf8');

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

test('kiosk header welcome always fits its real center column and List badge is optically centered',()=>{
  assert.match(css,/\.navbar \.nav\{[^}]*container-type:inline-size/);
  assert.match(css,/\.navbar #welcome-ms\{[^}]*font-size:clamp\(10px,5\.1cqi,30px\)[^}]*white-space:nowrap[^}]*overflow:visible[^}]*text-overflow:clip/);
  assert.match(css,/\.kiosk-nav-action\{[^}]*--nav-size:clamp\(48px,7\.2vw,58px\)/);
  assert.match(css,/\.kiosk-nav-action svg\{[^}]*width:clamp\(23px,3\.7vw,30px\)[^}]*height:clamp\(23px,3\.7vw,30px\)/);
  assert.match(css,/\.kiosk-list-badge\{[^}]*--badge-size:clamp\(32px,5vw,42px\)[^}]*display:grid[^}]*place-items:center[^}]*padding:0!important[^}]*line-height:1!important/);
  assert.match(css,/\.kiosk-list-badge\{[^}]*font-size:clamp\(\.82rem,2vw,1\.08rem\)/);
});

test('kiosk typography scales fluidly across devices without wrapping key labels',()=>{
  assert.match(css,/--fs-md:clamp\(/);
  assert.match(css,/body\{font-size:clamp\(18px,2\.7vw,24px\)\}/);
  assert.match(css,/\.cart-product-name\{[^}]*font-size:var\(--fs-lg\)[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(css,/\.cart-product-meta\{[^}]*font-size:var\(--fs-sm\)[^}]*white-space:nowrap/);
  assert.match(css,/\.premium-cart-review\{[^}]*font-size:var\(--fs-xl\)[^}]*white-space:nowrap/);
  assert.match(css,/\.premium-cart-review-count\{[^}]*font-size:clamp\(/);
  assert.match(mainCss,/font-size: clamp\(18px, 2\.7vw, 24px\)/);
  assert.match(mainCss,/#manager-lists \.card-title\{[^}]*font-size:clamp\(/);
});

test('List items omit specification option details',()=>{
  const productSection=source.slice(source.indexOf('function createCartProduct'),source.indexOf('function updateCartProduct'));
  const modalSection=source.slice(source.indexOf('function createModalCartProduct'),source.indexOf('function updateModalCartProduct'));
  assert.doesNotMatch(productSection,/specification/);
  assert.doesNotMatch(modalSection,/specification/);
  assert.match(productSection,/상품코드/);
  assert.match(productSection,/불출단위/);
});
