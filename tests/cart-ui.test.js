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
  assert.match(css,/\.premium-cart-review/);
  assert.match(css,/linear-gradient\(135deg,#0d6efd,#2563eb\)/);
  assert.match(css,/body\.list-panel-open #material-lists\{margin-bottom:58dvh\}/);
});

test('kiosk header maximizes welcome text and uses text-only List action',()=>{
  assert.match(css,/\.navbar \.nav\{[^}]*container-type:inline-size/);
  assert.match(css,/\.navbar #welcome-ms\{[^}]*font-size:clamp\(16px,7cqi,36px\)/);
  assert.match(css,/\.kiosk-list-action>svg\{display:none!important\}/);
  assert.match(css,/\.kiosk-list-label\{[^}]*font-size:clamp\(1\.22rem,3\.5vw,1\.75rem\)/);
  assert.match(css,/\.kiosk-back-action svg\{[^}]*width:78%!important[^}]*height:78%!important/);
});

test('List badge scales proportionally and is optically centered',()=>{
  const badgeBlocks=[...css.matchAll(/\.kiosk-list-badge\{([^}]*)\}/g)].map(match=>match[1]);
  const badge=badgeBlocks.at(-1)||'';
  assert.match(badge,/--badge-size:clamp\(31px,4\.7vw,40px\)/);
  assert.match(badge,/padding:clamp\(1px,\.18vw,2px\) 0 0!important/);
  assert.match(badge,/font-size:clamp\(\.86rem,1\.9vw,1\.08rem\)/);
  assert.match(css,/\.kiosk-list-badge\{[^}]*display:grid[^}]*place-items:center/);
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
