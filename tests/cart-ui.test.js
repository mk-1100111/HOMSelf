const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'..','public','request-client.js'),'utf8');
const css=fs.readFileSync(path.join(__dirname,'..','public','material_list.css'),'utf8');
const navCss=fs.readFileSync(path.join(__dirname,'..','public','kiosk_nav_tuning.css'),'utf8');
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
  assert.match(css,/\.premium-cart-review/);
  assert.match(css,/linear-gradient\(135deg,#0d6efd,#2563eb\)/);
  assert.match(css,/body\.list-panel-open #material-lists\{margin-bottom:58dvh\}/);
});

test('kiosk header maximizes welcome text and uses equal nav controls',()=>{
  assert.match(navCss,/--kiosk-nav-control:clamp\(58px,9vw,72px\)/);
  assert.match(navCss,/\.kiosk-nav-action\{[^}]*width:var\(--kiosk-nav-control\)!important[^}]*height:var\(--kiosk-nav-control\)!important/);
  assert.match(navCss,/\.kiosk-list-action svg\{display:none!important\}/);
  assert.match(navCss,/\.kiosk-back-action svg\{[^}]*width:72%!important[^}]*height:72%!important/);
  assert.match(navCss,/\.navbar #welcome-ms\{[^}]*font-size:clamp\(15px,8\.2cqi,36px\)!important/);
});

test('List badge scales proportionally and centers native text',()=>{
  assert.match(navCss,/\.kiosk-list-badge\{[^}]*--badge-size:clamp\(30px,4\.8vw,40px\)!important/);
  assert.match(navCss,/\.kiosk-list-badge\{[^}]*display:grid!important[^}]*place-items:center!important/);
  assert.match(navCss,/padding:\.08em 0 0!important/);
  assert.match(navCss,/line-height:1!important/);
  assert.match(navCss,/\.kiosk-list-badge::before,\.kiosk-list-badge::after\{content:none!important/);
});

test('material selector keeps three cards per row including tablet',()=>{
  assert.match(css,/#material-lists\.row\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
  const mobile=css.slice(css.lastIndexOf('@media(max-width:480px)'));
  assert.match(mobile,/#material-lists\.row\{grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('List hides kind-unit summaries and aligns unit with total quantity',()=>{
  assert.match(css,/\.premium-cart-head-summary,\.premium-cart-footer-summary\{display:none!important\}/);
  assert.match(css,/\.cart-product-info\{display:grid;grid-template-columns:minmax\(0,1fr\) auto/);
  assert.match(css,/\.cart-product-meta span:first-child\{display:none!important\}/);
  assert.match(css,/\.cart-product-total\{grid-column:2;grid-row:2/);
  assert.match(source,/불출단위/);
});

test('kiosk typography scales fluidly across devices without wrapping key labels',()=>{
  assert.match(css,/--fs-md:clamp\(/);
  assert.match(css,/body\{font-size:clamp\(18px,2\.7vw,24px\)\}/);
  assert.match(css,/\.cart-product-name\{[^}]*font-size:var\(--fs-lg\)[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/);
  assert.match(css,/\.premium-cart-review\{[^}]*font-size:var\(--fs-xl\)[^}]*white-space:nowrap/);
  assert.match(mainCss,/font-size: clamp\(18px, 2\.7vw, 24px\)/);
  assert.match(mainCss,/#manager-lists \.card-title\{[^}]*font-size:clamp\(/);
});

test('List items omit specification option details',()=>{
  const productSection=source.slice(source.indexOf('function createCartProduct'),source.indexOf('function updateCartProduct'));
  const modalSection=source.slice(source.indexOf('function createModalCartProduct'),source.indexOf('function updateModalCartProduct'));
  assert.doesNotMatch(productSection,/specification/);
  assert.doesNotMatch(modalSection,/specification/);
});
