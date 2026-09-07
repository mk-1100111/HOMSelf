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
  check(/^\d{4}$/.test(adminPin),'ADMIN_TOKEN은 숫자 4자리 PIN으로 설정하세요.');
  check(/^\d{4}$/.test(kioskPin),'KIOSK_TOKEN은 숫자 4자리 PIN으로 설정하세요.');
  check(adminPin !== kioskPin,'ADMIN_TOKEN과 KIOSK_TOKEN은 서로 다른 4자리 PIN이어야 합니다.');
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
  const app = express(); app.disable('x-powered-by');
  app.set('trust proxy',1);
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
