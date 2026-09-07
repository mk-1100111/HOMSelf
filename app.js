const express = require('express');
const helmet = require('helmet');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, check, loadCatalog } = require('./model/store');

function createApp(config = process.env) {
  const keys = ['ADMIN_TOKEN','KIOSK_TOKEN','WORKER_TOKEN'].map(k => config[k]);
  check(keys.every(k => typeof k === 'string' && k.length >= 32) && new Set(keys).size === 3,
    '서로 다른 ADMIN_TOKEN/KIOSK_TOKEN/WORKER_TOKEN(각 32자 이상)을 설정하세요.');
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
  const app = express(); app.disable('x-powered-by');
  app.set('view engine','ejs'); app.set('views',path.join(__dirname,'views'));
  // Existing EJS has inline handlers. Keep compatibility without permitting frames.
  app.use(helmet({contentSecurityPolicy:{directives:{
    defaultSrc:["'self'"],scriptSrc:["'self'","'unsafe-inline'",'https://ajax.googleapis.com','https://cdn.jsdelivr.net'],
    scriptSrcAttr:["'unsafe-inline'"],styleSrc:["'self'","'unsafe-inline'",'https://cdn.jsdelivr.net','https://fonts.googleapis.com'],
    fontSrc:["'self'",'https://fonts.gstatic.com'],imgSrc:["'self'",'data:'],connectSrc:["'self'"],frameAncestors:["'none'"]
  }},crossOriginEmbedderPolicy:false}));
  app.use(express.json({limit:'32kb'}));
  app.use('/public',express.static(path.join(__dirname,'public')));
  app.get('/ping',(req,res) => res.send('pong'));
  app.get('/healthz',(req,res) => {store.db.prepare('SELECT 1').get();res.json({ok:true});});
  const auth = role => (req,res,next) => {
    const supplied=String(req.get('authorization') || '').replace(/^Bearer /,'');
    const digest=s => crypto.createHash('sha256').update(s).digest();
    if(!crypto.timingSafeEqual(digest(supplied),digest(config[role+'_TOKEN']))) return res.status(401).json({error:'인증키를 확인하세요.'});
    next();
  };
  app.use('/api',(req,res,next) => {res.set('Cache-Control','no-store');next();});
  app.get('/api/catalog',auth('KIOSK'),(req,res) => res.json(catalog));
  app.post('/api/requests',auth('KIOSK'),(req,res) => res.status(201).json(store.submit(req.body,req.get('Idempotency-Key'))));
  app.get('/api/admin/overview',auth('ADMIN'),(req,res) => res.json(store.overview()));
  app.get('/api/admin/database',auth('ADMIN'),(req,res) => res.json(store.inspection()));
  app.get('/api/admin/events/:id',auth('ADMIN'),(req,res) => res.json(store.db.prepare('SELECT * FROM events WHERE item_id=? ORDER BY id').all(req.params.id)));
  app.post('/api/admin/pause',auth('ADMIN'),(req,res) => res.json(store.pause(req.body.paused)));
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
  app.get('/api/worker/preview',auth('WORKER'),(req,res) => res.json(store.preview()));
  app.post('/api/worker/claim',auth('WORKER'),(req,res) => res.json({item:store.claim()}));
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
  const server=app.listen(process.env.PORT || 3000,() => console.log('HOMSelf 시작: 자동 불출은 일시정지 상태입니다.'));
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,() => server.close(() => {store.close();process.exit(0);}));
}
module.exports={createApp};
