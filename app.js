const express = require('express');
const helmet = require('helmet');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, check, loadCatalog } = require('./model/store');

function createApp(config = process.env) {
  const adminPin=String(config.ADMIN_TOKEN || '');
  const kioskPin=String(config.KIOSK_TOKEN || '');
  const workerToken=String(config.WORKER_TOKEN || '');
  const pinOrLegacy=value => /^\d{4}$/.test(value) || value.length >= 32;
  check(pinOrLegacy(adminPin),'ADMIN_TOKEN은 숫자 4자리 PIN으로 설정하세요. 기존 32자 이상 키는 마이그레이션 동안만 호환됩니다.');
  check(pinOrLegacy(kioskPin),'KIOSK_TOKEN은 숫자 4자리 PIN으로 설정하세요. 기존 32자 이상 키는 마이그레이션 동안만 호환됩니다.');
  check(adminPin !== kioskPin,'ADMIN_TOKEN과 KIOSK_TOKEN은 서로 달라야 합니다.');
  check(workerToken.length >= 32,'WORKER_TOKEN은 32자 이상의 내부 통신키로 설정하세요.');
  check(config.DB_PATH && path.isAbsolute(config.DB_PATH), 'DB_PATH는 절대 경로여야 합니다.');
  if (config.NODE_ENV === 'production') {
    if (config.DB_PATH.startsWith('/tmp/')) {
      check(config.EPHEMERAL_STORAGE_CONFIRMED === 'yes', '무료 Render 임시 저장소 사용 확인 후 EPHEMERAL_STORAGE_CONFIRMED=yes를 설정하세요.');
    } else {
      check(config.PERSISTENT_STORAGE_CONFIRMED === 'yes', '영구 디스크 연결 확인 후 PERSISTENT_STORAGE_CONFIRMED=yes를 설정하세요.');
    }
  }
  const catalog=loadCatalog(config.CATALOG_PATH);
  if(config.NODE_ENV === 'production') check(catalog.demo !== true,'샘플 기준정보로 운영할 수 없습니다. 비공개 저장소의 실제 기준정보를 설정하세요.');
  const store = new Store(config.DB_PATH,catalog);

  store.db.exec(`
    CREATE TABLE IF NOT EXISTS material_stock (
      material_code TEXT PRIMARY KEY,
      material_name TEXT NOT NULL,
      specification TEXT NOT NULL DEFAULT '',
      stock_quantity INTEGER NOT NULL CHECK(stock_quantity >= 0),
      synced_at INTEGER NOT NULL
    ) STRICT;
  `);

  const mergeSyncedMaterials=() => {
    const known=new Set(catalog.materials.map(m=>m.material_code));
    for(const row of store.db.prepare('SELECT material_code,material_name FROM material_stock ORDER BY material_code').all()) {
      if(known.has(row.material_code)) continue;
      catalog.materials.push({material_code:row.material_code,material_name:row.material_name,material_unit:1});
      known.add(row.material_code);
    }
  };
  mergeSyncedMaterials();

  const inventoryState=() => ({
    status:store.setting('inventory_sync_status') || 'idle',
    request_id:store.setting('inventory_sync_request_id') || '',
    requested_at:Number(store.setting('inventory_sync_requested_at') || 0),
    completed_at:Number(store.setting('inventory_sync_completed_at') || 0),
    count:Number(store.setting('inventory_sync_count') || 0),
    error:store.setting('inventory_sync_error') || ''
  });

  const requestInventorySync=() => store.tx(() => {
    check(store.paused() && !store.batchActive(),'일괄 불출 중에는 재고 동기화를 시작할 수 없습니다.');
    check(!store.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting') LIMIT 1").get(),'처리 중인 항목이 있어 재고 동기화를 시작할 수 없습니다.');
    const state=inventoryState();
    check(state.status!=='requested','이미 재고 동기화를 요청했습니다.');
    const requestId=crypto.randomUUID();
    store.setSetting('inventory_sync_status','requested');
    store.setSetting('inventory_sync_request_id',requestId);
    store.setSetting('inventory_sync_requested_at',Date.now());
    store.setSetting('inventory_sync_error','');
    return inventoryState();
  });

  const failInventorySync=(requestId,errorText) => store.tx(() => {
    const state=inventoryState();
    check(state.status==='requested' && state.request_id===requestId,'재고 동기화 요청이 이미 변경됐습니다.');
    store.setSetting('inventory_sync_status','failed');
    store.setSetting('inventory_sync_error',String(errorText || '회사 PC 동기화 실패').slice(0,300));
    return inventoryState();
  });

  const applyInventorySync=(requestId,rows) => store.tx(() => {
    const state=inventoryState();
    check(state.status==='requested' && state.request_id===requestId,'재고 동기화 요청이 이미 변경됐습니다.');
    check(Array.isArray(rows) && rows.length>0 && rows.length<=500,'재고 동기화 데이터가 잘못됐습니다.',400);
    const now=Date.now();
    const seen=new Set();
    const upsert=store.db.prepare(`INSERT INTO material_stock(material_code,material_name,specification,stock_quantity,synced_at)
      VALUES(?,?,?,?,?) ON CONFLICT(material_code) DO UPDATE SET material_name=excluded.material_name,specification=excluded.specification,stock_quantity=excluded.stock_quantity,synced_at=excluded.synced_at`);
    for(const row of rows) {
      check(row && typeof row.material_code==='string' && /^[A-Za-z0-9_-]{1,80}$/.test(row.material_code),'상품코드가 잘못됐습니다.',400);
      check(!seen.has(row.material_code),'동일 상품코드가 중복됐습니다.',400);seen.add(row.material_code);
      check(typeof row.material_name==='string' && row.material_name.trim().length>0 && row.material_name.length<=200,'상품명이 잘못됐습니다.',400);
      check(typeof row.specification==='string' && row.specification.length<=500,'규격이 잘못됐습니다.',400);
      check(Number.isSafeInteger(row.stock_quantity) && row.stock_quantity>=0 && row.stock_quantity<=100000000,'현재재고가 잘못됐습니다.',400);
      upsert.run(row.material_code,row.material_name.trim(),row.specification.trim(),row.stock_quantity,now);
    }
    mergeSyncedMaterials();
    store.setSetting('inventory_sync_status','completed');
    store.setSetting('inventory_sync_completed_at',now);
    store.setSetting('inventory_sync_count',rows.length);
    store.setSetting('inventory_sync_error','');
    return inventoryState();
  });

  const kioskCatalog=() => {
    mergeSyncedMaterials();
    const stockRows=new Map(store.db.prepare('SELECT * FROM material_stock').all().map(row=>[row.material_code,row]));
    const activeReservations=store.db.prepare(`SELECT material_code,COALESCE(SUM(quantity),0) AS quantity
      FROM request_items WHERE status IN ('pending','approved','claimed','submitting','needs_review') GROUP BY material_code`).all();
    const activeMap=new Map(activeReservations.map(row=>[row.material_code,row.quantity]));
    const completedAfterSync=store.db.prepare(`SELECT i.material_code,COALESCE(SUM(i.quantity),0) AS quantity
      FROM request_items i JOIN material_stock s ON s.material_code=i.material_code
      WHERE i.status='completed' AND i.updated_at>s.synced_at
        AND i.evidence!='rejected_batch_completed'
        AND i.evidence NOT LIKE 'HOMS 조회 결과%'
      GROUP BY i.material_code`).all();
    const completedMap=new Map(completedAfterSync.map(row=>[row.material_code,row.quantity]));
    return {
      ...catalog,
      inventory_sync:inventoryState(),
      materials:catalog.materials.map(material => {
        const stock=stockRows.get(material.material_code);
        if(!stock) return {...material,available_stock:null,stock_quantity:null,specification:''};
        const reserved=(activeMap.get(material.material_code)||0)+(completedMap.get(material.material_code)||0);
        return {...material,specification:stock.specification,stock_quantity:stock.stock_quantity,
          available_stock:Math.max(0,stock.stock_quantity-reserved),stock_synced_at:stock.synced_at};
      })
    };
  };

  const app = express(); app.disable('x-powered-by');
  app.set('trust proxy',1);
  app.set('view engine','ejs'); app.set('views',path.join(__dirname,'views'));
  app.use(helmet({contentSecurityPolicy:{directives:{
    defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'",'https://ajax.googleapis.com','https://cdn.jsdelivr.net'],
    scriptSrcAttr:["'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'",'https://cdn.jsdelivr.net','https://fonts.googleapis.com'],
    fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameAncestors:["'none'"]
  }},crossOriginEmbedderPolicy:false}));
  app.use(express.json({limit:'256kb'}));
  app.use('/public',express.static(path.join(__dirname,'public')));
  app.get('/ping',(req,res) => res.send('pong'));
  app.get('/healthz',(req,res) => {store.db.prepare('SELECT 1').get();res.json({ok:true});});
  const authFailures=new Map();
  const auth = role => (req,res,next) => {
    const pinRole=role === 'ADMIN' || role === 'KIOSK';
    const key=pinRole ? role+':'+req.ip : null;
    const now=Date.now();
    if(key){
      const state=authFailures.get(key);
      if(state && state.blockedUntil>now) return res.status(429).json({error:'인증 시도가 너무 많습니다. 5분 후 다시 시도하세요.'});
      if(state && state.blockedUntil && state.blockedUntil<=now) authFailures.delete(key);
    }
    const supplied=String(req.get('authorization') || '').replace(/^Bearer /,'');
    const digest=s => crypto.createHash('sha256').update(s).digest();
    if(!crypto.timingSafeEqual(digest(supplied),digest(config[role+'_TOKEN']))) {
      if(key){
        const prior=authFailures.get(key) || {failures:0,blockedUntil:0};
        prior.failures+=1;
        if(prior.failures>=5){prior.failures=0;prior.blockedUntil=now+5*60*1000;authFailures.set(key,prior);return res.status(429).json({error:'인증 시도가 너무 많습니다. 5분 후 다시 시도하세요.'});}
        authFailures.set(key,prior);
      }
      return res.status(401).json({error:'인증키를 확인하세요.'});
    }
    if(key) authFailures.delete(key);
    next();
  };
  app.use('/api',(req,res,next) => {res.set('Cache-Control','no-store');next();});
  app.get('/api/catalog',auth('KIOSK'),(req,res) => res.json(kioskCatalog()));
  app.post('/api/requests',auth('KIOSK'),(req,res) => res.status(201).json(store.submit(req.body,req.get('Idempotency-Key'))));
  app.get('/api/admin/overview',auth('ADMIN'),(req,res) => res.json({...store.overview(),inventory_sync:inventoryState()}));
  app.get('/api/admin/database',auth('ADMIN'),(req,res) => res.json(store.inspection()));
  app.get('/api/admin/events/:id',auth('ADMIN'),(req,res) => res.json(store.db.prepare('SELECT * FROM events WHERE item_id=? ORDER BY id').all(req.params.id)));
  app.post('/api/admin/pause',auth('ADMIN'),(req,res) => res.json(store.pause(req.body.paused)));
  app.post('/api/admin/approve-all',auth('ADMIN'),(req,res) => res.json(store.approveAll()));
  app.post('/api/admin/batch/start',auth('ADMIN'),(req,res) => res.json(store.startBatch()));
  app.post('/api/admin/inventory-sync',auth('ADMIN'),(req,res) => res.json(requestInventorySync()));
  app.post('/api/admin/items/:id',auth('ADMIN'),(req,res) => res.json(store.adminAction(req.params.id,req.body.action,req.body.note)));
  let snapshotBusy=false;
  app.get('/api/admin/backup',auth('ADMIN'),(req,res,next) => {
    if(snapshotBusy) return res.status(409).json({error:'백업 생성 중입니다.'});
    snapshotBusy=true;
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'homself-backup-'));
    const file=path.join(directory,'homself.sqlite');
    const cleanup=() => {fs.rmSync(file,{force:true});fs.rmdirSync(directory);snapshotBusy=false;};
    try {store.snapshot(file);res.download(file,'homself.sqlite',error => {cleanup();if(error && !res.headersSent) next(error);});}
    catch(error) {cleanup();next(error);}
  });
  app.post('/api/worker/heartbeat',auth('WORKER'),(req,res) => res.json(store.heartbeat(req.body.mode)));
  app.get('/api/worker/preview',auth('WORKER'),(req,res) => res.json({...store.preview(),inventory_sync:inventoryState()}));
  app.post('/api/worker/claim',auth('WORKER'),(req,res) => res.json({item:store.claim()}));
  app.post('/api/worker/batch/finish',auth('WORKER'),(req,res) => res.json(store.finishBatch()));
  app.post('/api/worker/inventory-sync',auth('WORKER'),(req,res) => res.json(applyInventorySync(req.body.request_id,req.body.items)));
  app.post('/api/worker/inventory-sync/fail',auth('WORKER'),(req,res) => res.json(failInventorySync(req.body.request_id,req.body.error)));
  app.get('/api/worker/items/:id',auth('WORKER'),(req,res) => res.json(store.item(req.params.id)));
  app.post('/api/worker/items/:id/:action',auth('WORKER'),(req,res) => res.json(store.transition(req.params.id,req.body.attempt_id,req.params.action,req.body.note,req.body.proof)));
  app.get('/',(req,res) => res.redirect('/main'));
  app.get('/main',(req,res) => res.render('main',{managers:[]}));
  app.get('/material_list',(req,res) => res.render('material_list',{materials:[]}));
  app.get('/manager_list',(req,res) => res.redirect('/main'));
  app.get('/admin',(req,res) => res.render('admin'));
  app.use((req,res) => res.status(404).send('페이지를 찾을 수 없습니다.'));
  app.use((error,req,res,next) => {
    if(res.headersSent) return next(error);
    if(!error.status) console.error('HOMSelf request error:',error.code || error.name);
    res.status(error.status || 500).json({error:error.status ? error.message : '서버 처리 오류입니다. 같은 요청번호로 재확인하세요.'});
  });
  return {app,store};
}
if(require.main === module) {
  const {app,store}=createApp();
  const server=app.listen(process.env.PORT || 3000,() => console.log('HOMSelf 시작: 승인 시트의 항목은 일괄 불출 시작 전까지 대기합니다.'));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close(() => {store.close();process.exit(0);}));
}
module.exports={createApp};
