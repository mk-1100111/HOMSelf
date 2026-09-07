const { DatabaseSync } = require('node:sqlite');
const { randomUUID, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const catalog = require('../config/catalog.example.json');
const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
function check(ok, message, status = 409) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
class Store {
  constructor(filename, activeCatalog = catalog) {
    this.catalog = activeCatalog;
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    check(this.db.prepare('PRAGMA user_version').get().user_version <= 2, '이 프로그램보다 새로운 DB입니다.');
    this.db.exec(schema);
    this.tx(() => {this.db.prepare("UPDATE settings SET value='1' WHERE key='paused'").run();this.quarantine('server_restart');});
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  event(id, type, actor, note = '') {
    this.db.prepare('INSERT INTO events(item_id,event_type,actor,note,created_at) VALUES(?,?,?,?,?)').run(id,type,actor,note,Date.now());
  }
  quarantine(reason) {
    for (const item of this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting')").all()) {
      this.db.prepare("UPDATE request_items SET status='needs_review',updated_at=? WHERE id=?").run(Date.now(),item.id);
      this.event(item.id,'needs_review','system',reason);
    }
  }
  paused() {return this.db.prepare("SELECT value FROM settings WHERE key='paused'").get().value === '1';}
  pause(value) {
    check(typeof value === 'boolean','paused는 boolean이어야 합니다.',400);
    return this.tx(() => {
      this.db.prepare("UPDATE settings SET value=? WHERE key='paused'").run(value ? '1' : '0');
      if(value) this.quarantine('operator_pause');
      this.event(null,value ? 'paused' : 'resumed','admin');return {paused:value};
    });
  }
  submit(body,key) {
    check(typeof key === 'string' && /^[a-zA-Z0-9-]{16,80}$/.test(key),'요청 고유번호가 필요합니다.',400);
    check(body && this.catalog.managers.includes(body.manager_name),'등록되지 않은 매니저입니다.',400);
    check(Array.isArray(body.items) && body.items.length > 0 && body.items.length <= this.catalog.materials.length,'자재를 선택하세요.',400);
    const seen=new Set();
    const items=body.items.map(item => {
      const material=this.catalog.materials.find(m => m.material_code === item.material_code);
      check(material && !seen.has(item.material_code),'자재코드가 잘못됐거나 중복됐습니다.',400);seen.add(item.material_code);
      check(Number.isSafeInteger(item.quantity) && item.quantity > 0 && item.quantity <= 100000 && item.quantity % material.material_unit === 0,
        '수량은 불출 단위의 배수이며 1~100000이어야 합니다.',400);
      return {material_code:material.material_code,material_name:material.material_name,quantity:item.quantity};
    }).sort((a,b)=>a.material_code.localeCompare(b.material_code));
    const hash=createHash('sha256').update(JSON.stringify([body.manager_name,items])).digest('hex');
    return this.tx(() => {
      const prior=this.db.prepare('SELECT id,payload_hash FROM requests WHERE idempotency_key=?').get(key);
      if(prior) {check(prior.payload_hash === hash,'같은 요청번호의 내용이 달라졌습니다.');return {request_id:prior.id,duplicate:true};}
      const id=randomUUID(), now=Date.now();
      this.db.prepare('INSERT INTO requests VALUES(?,?,?,?,?)').run(id,key,hash,body.manager_name,now);
      for(const item of items) {
        const itemId=randomUUID();
        this.db.prepare('INSERT INTO request_items(id,request_id,material_code,material_name,quantity,updated_at) VALUES(?,?,?,?,?,?)')
          .run(itemId,id,item.material_code,item.material_name,item.quantity,now);
        this.event(itemId,'pending','kiosk');
      }
      return {request_id:id,duplicate:false};
    });
  }
  items() {return this.db.prepare('SELECT i.*,r.manager_name,r.created_at FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.created_at DESC,i.id LIMIT 1000').all();}
  item(id) {
    const item=this.db.prepare('SELECT i.*,r.manager_name FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.id=?').get(id);
    check(item,'항목을 찾을 수 없습니다.',404);return item;
  }
  adminAction(id,action,note) {
    return this.tx(() => {
      const item=this.item(id);let status;
      if(action === 'approve') {check(item.status === 'pending','접수 상태만 승인할 수 있습니다.');status='approved';}
      else if(action === 'cancel') {check(['pending','approved'].includes(item.status),'처리 중인 항목은 취소할 수 없습니다.');status='cancelled';}
      else {
        check(item.status === 'needs_review','확인 필요 상태만 수동 판정할 수 있습니다.');
        check(this.paused(),'먼저 전체 일시정지하고 회사 PC 프로그램을 종료하세요.');
        check(typeof note === 'string' && note.trim().length >= 10 && note.length <= 1000,'HOMS 내역 확인 근거를 10자 이상 입력하세요.',400);
        check(['confirm_completed','confirm_not_submitted'].includes(action),'잘못된 작업입니다.',400);
        status=action === 'confirm_completed' ? 'completed' : 'pending';
      }
      this.db.prepare('UPDATE request_items SET status=?,attempt_id=NULL,updated_at=?,evidence=? WHERE id=?').run(status,Date.now(),note || '',id);
      this.event(id,action,'admin',note || '');return this.item(id);
    });
  }
  heartbeat(mode) {
    check(['check','live'].includes(mode),'잘못된 모드입니다.',400);
    this.db.prepare('INSERT INTO worker_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,mode=excluded.mode').run(Date.now(),mode);
    return {paused:this.paused(),schema_version:2,worker_protocol:2};
  }
  preview() {
    const blocked=this.db.prepare("SELECT id,status FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get();
    return {paused:this.paused(),worker_protocol:2,blocked:blocked || null,items:this.db.prepare("SELECT i.id,i.request_id,i.material_code,i.material_name,i.quantity,i.status,r.manager_name FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.status='approved' ORDER BY i.updated_at,i.id LIMIT 50").all()};
  }
  claim() {
    return this.tx(() => {
      check(!this.paused(),'자동 불출이 일시정지되어 있습니다.');
      check(!this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get(),'처리 중 또는 확인 필요 항목을 먼저 확인하세요.');
      const item=this.db.prepare("SELECT id FROM request_items WHERE status='approved' ORDER BY updated_at,id LIMIT 1").get();
      if(!item) return null;
      this.db.prepare("UPDATE request_items SET status='claimed',attempt_id=?,updated_at=? WHERE id=?").run(randomUUID(),Date.now(),item.id);
      this.event(item.id,'claimed','worker');return this.item(item.id);
    });
  }
  transition(id,attempt,action,note,proof) {
    return this.tx(() => {
      const item=this.item(id);
      check(typeof attempt === 'string' && item.attempt_id === attempt,'처리 권한이 만료됐습니다. 재불출하지 마세요.');
      if(action === 'begin') {
        check(!this.paused() && item.status === 'claimed','불출 시작이 허용되지 않습니다.');
        check(Date.now()-item.updated_at < 30*60*1000,'처리 준비 제한시간을 초과했습니다.');
        this.db.prepare("UPDATE request_items SET status='submitting',updated_at=? WHERE id=?").run(Date.now(),id);
      } else if(action === 'review') {
        check(['claimed','submitting','needs_review'].includes(item.status),'상태가 변경됐습니다.');
        this.db.prepare("UPDATE request_items SET status='needs_review',updated_at=?,evidence=? WHERE id=?").run(Date.now(),note || 'HOMS 결과 확인 필요',id);
      } else if(action === 'auto_complete') {
        check(proof && proof.source==='homs-history' && typeof proof.transaction_id==='string' && /^[A-Za-z0-9_-]{1,100}$/.test(proof.transaction_id), 'HOMS 거래번호가 필요합니다.',400);
        check(proof.material_code===item.material_code && proof.manager_name===item.manager_name && proof.quantity===item.quantity && proof.status==='completed' &&
          typeof proof.receiver_id==='string' && proof.receiver_id.length>0 && proof.receiver_id.length<=100,'HOMS 불출 결과가 요청과 일치하지 않습니다.',400);
        const evidence=JSON.stringify({source:proof.source,transaction_id:proof.transaction_id,receiver_id:proof.receiver_id,manager_name:proof.manager_name,material_code:proof.material_code,quantity:proof.quantity,status:proof.status});
        const prior=this.db.prepare('SELECT item_id,evidence FROM homs_receipts WHERE transaction_id=?').get(proof.transaction_id);
        if(prior) {check(prior.item_id===id && prior.evidence===evidence && item.status==='completed','이미 사용된 HOMS 거래번호입니다.');return item;}
        check(item.status==='submitting','자동 완료를 허용하지 않는 상태입니다.');
        this.db.prepare('INSERT INTO homs_receipts VALUES(?,?,?,?)').run(proof.transaction_id,id,evidence,Date.now());
        this.db.prepare("UPDATE request_items SET status='completed',updated_at=?,evidence=? WHERE id=?").run(Date.now(),evidence,id);
        note=evidence;
      } else if(action === 'complete') {
        check(typeof note === 'string' && note.trim().length >= 10 && note.length <= 1000,'불출 결과 확인 근거가 필요합니다.',400);
        if(item.status === 'completed') {check(item.evidence === note,'완료 근거가 달라졌습니다.');return item;}
        check(item.status === 'submitting','관리자 화면에서 수동 확인하세요.');
        this.db.prepare("UPDATE request_items SET status='completed',updated_at=?,evidence=? WHERE id=?").run(Date.now(),note,id);
      } else check(false,'잘못된 작업입니다.',400);
      this.event(id,action,'worker',note || '');return this.item(id);
    });
  }
  overview() {return {paused:this.paused(),counts:this.db.prepare('SELECT status,COUNT(*) AS count FROM request_items GROUP BY status').all(),
    worker:this.db.prepare('SELECT * FROM worker_status WHERE id=1').get() || null,schema_version:2,items:this.items()};}
  inspection() {return {schema,tables:['requests','request_items','events','settings','worker_status','homs_receipts'].map(name => ({name,
    count:this.db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n,rows:this.db.prepare(`SELECT * FROM ${name} LIMIT 100`).all()}))};}
  snapshot(destination) {this.db.prepare('VACUUM INTO ?').run(destination);}
  close() {this.db.close();}
}
function loadCatalog(filename) {
  check(filename && path.isAbsolute(filename),'CATALOG_PATH에 기준정보 파일의 절대 경로를 설정하세요.');
  const data=JSON.parse(fs.readFileSync(filename,'utf8'));
  check(Array.isArray(data.managers) && data.managers.length && data.managers.every(n=>typeof n==='string' && n.length>0 && n.length<80),'매니저 기준정보가 잘못됐습니다.');
  check(new Set(data.managers).size===data.managers.length,'매니저 이름 중복을 확인하세요.');
  check(Array.isArray(data.materials) && data.materials.length && data.materials.every(m=>typeof m.material_code==='string' && m.material_code.length>0 &&
    typeof m.material_name==='string' && m.material_name.length>0 && Number.isSafeInteger(m.material_unit) && m.material_unit>0),'자재 기준정보가 잘못됐습니다.');
  check(new Set(data.materials.map(m=>m.material_code)).size===data.materials.length,'자재코드 중복을 확인하세요.');
  return data;
}
module.exports={Store,check,catalog,schema,loadCatalog};
