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
    this.tx(() => {
      this.setSetting('paused','1');
      this.setSetting('batch_active','0');
      this.setSetting('batch_items','[]');
      this.quarantine('server_restart');
      this.pruneItems();
    });
  }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting(key) {return this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value;}
  setSetting(key,value) {this.db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value));}
  event(id, type, actor, note = '') {
    this.db.prepare('INSERT INTO events(item_id,event_type,actor,note,created_at) VALUES(?,?,?,?,?)').run(id,type,actor,note,Date.now());
  }
  quarantine(reason) {
    for (const item of this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting')").all()) {
      this.db.prepare("UPDATE request_items SET status='needs_review',updated_at=? WHERE id=?").run(Date.now(),item.id);
      this.event(item.id,'needs_review','system',reason);
    }
  }
  paused() {return this.setting('paused') === '1';}
  batchActive() {return this.setting('batch_active') === '1';}
  batchItems() {
    try {
      const value=JSON.parse(this.setting('batch_items') || '[]');
      return Array.isArray(value) ? value.filter(id=>typeof id==='string') : [];
    } catch {return [];}
  }
  batchRemaining() {
    const ids=this.batchItems();
    if(!ids.length) return 0;
    let n=0;
    for(const id of ids) if(this.db.prepare("SELECT 1 FROM request_items WHERE id=? AND status IN ('approved','claimed','submitting')").get(id)) n++;
    return n;
  }
  pruneItems(limit=1000) {
    let total=this.db.prepare('SELECT COUNT(*) AS n FROM request_items').get().n;
    if(total<=limit) return 0;
    const batchIds=new Set(this.batchItems());
    let removed=0;
    while(total>limit) {
      const candidates=this.db.prepare("SELECT i.id,i.request_id FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.status IN ('completed','cancelled') ORDER BY r.created_at ASC,i.updated_at ASC,i.id ASC LIMIT 50").all();
      const victim=candidates.find(row=>!batchIds.has(row.id));
      if(!victim) break;
      this.db.prepare('DELETE FROM events WHERE item_id=?').run(victim.id);
      this.db.prepare('DELETE FROM homs_receipts WHERE item_id=?').run(victim.id);
      this.db.prepare('DELETE FROM request_items WHERE id=?').run(victim.id);
      if(!this.db.prepare('SELECT 1 FROM request_items WHERE request_id=? LIMIT 1').get(victim.request_id)) {
        this.db.prepare('DELETE FROM requests WHERE id=?').run(victim.request_id);
      }
      total--;removed++;
    }
    return removed;
  }
  pause(value) {
    check(typeof value === 'boolean','paused는 boolean이어야 합니다.',400);
    if(!value) return this.startBatch();
    return this.tx(() => {
      this.setSetting('paused','1');
      this.setSetting('batch_active','0');
      this.setSetting('batch_items','[]');
      this.quarantine('operator_pause');
      this.event(null,'paused','admin');
      return {paused:true,batch_active:false};
    });
  }
  startBatch() {
    return this.tx(() => {
      check(this.paused() && !this.batchActive(),'이미 일괄 불출이 진행 중입니다.');
      check(!this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get(),'처리 중 또는 확인 필요 항목을 먼저 확인하세요.');
      const rows=this.db.prepare("SELECT id FROM request_items WHERE status='approved' ORDER BY updated_at,id").all();
      check(rows.length>0,'승인 시트에 불출할 요청이 없습니다.');
      const ids=rows.map(r=>r.id);
      this.setSetting('batch_items',JSON.stringify(ids));
      this.setSetting('batch_active','1');
      this.setSetting('paused','0');
      this.event(null,'batch_started','admin',JSON.stringify({count:ids.length}));
      return {paused:false,batch_active:true,count:ids.length};
    });
  }
  finishBatch() {
    return this.tx(() => {
      check(this.batchActive(),'진행 중인 일괄 불출이 없습니다.');
      check(!this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get(),'처리 중 또는 확인 필요 항목이 있습니다.');
      check(this.batchRemaining()===0,'현재 배치에 아직 불출할 항목이 남아 있습니다.');
      this.setSetting('paused','1');
      this.setSetting('batch_active','0');
      this.setSetting('batch_items','[]');
      this.event(null,'batch_completed','worker');
      this.pruneItems();
      return {paused:true,batch_active:false};
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
      this.pruneItems();
      return {request_id:id,duplicate:false};
    });
  }
  items() {return this.db.prepare('SELECT i.*,r.manager_name,r.created_at FROM request_items i JOIN requests r ON r.id=i.request_id ORDER BY r.created_at DESC,i.id LIMIT 1000').all();}
  item(id) {
    const item=this.db.prepare('SELECT i.*,r.manager_name,r.created_at FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.id=?').get(id);
    check(item,'항목을 찾을 수 없습니다.',404);return item;
  }
  approvalSheet() {
    const batchIds=new Set(this.batchItems());
    return this.db.prepare("SELECT i.*,r.manager_name,r.created_at FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.status IN ('approved','claimed','submitting') ORDER BY i.updated_at,i.id LIMIT 1000").all()
      .map(item=>({...item,current_batch:this.batchActive() && batchIds.has(item.id)}));
  }
  approveAll() {
    return this.tx(() => {
      const rows=this.db.prepare("SELECT id FROM request_items WHERE status='pending' ORDER BY updated_at,id").all();
      const now=Date.now();
      for(const row of rows) {
        this.db.prepare("UPDATE request_items SET status='approved',attempt_id=NULL,updated_at=?,evidence='' WHERE id=?").run(now,row.id);
        this.event(row.id,'approved','admin','bulk');
      }
      return {count:rows.length};
    });
  }
  adminAction(id,action,note) {
    return this.tx(() => {
      const item=this.item(id);let status,eventType=action;
      const batchLocked=this.batchActive() && this.batchItems().includes(id);
      if(action === 'toggle_approve') {
        check(['pending','approved','cancelled'].includes(item.status),'현재 상태에서는 승인 선택을 바꿀 수 없습니다.');
        check(!batchLocked,'현재 일괄 불출에 포함된 항목은 선택을 바꿀 수 없습니다.');
        status=item.status === 'approved' ? 'pending' : 'approved';
        eventType=status === 'approved' ? 'approved' : 'approval_removed';
      } else if(action === 'toggle_reject') {
        check(['pending','approved','cancelled'].includes(item.status),'현재 상태에서는 반려 선택을 바꿀 수 없습니다.');
        check(!batchLocked,'현재 일괄 불출에 포함된 항목은 선택을 바꿀 수 없습니다.');
        status=item.status === 'cancelled' ? 'pending' : 'cancelled';
        eventType=status === 'cancelled' ? 'rejected' : 'rejection_removed';
      } else if(action === 'approve') {
        check(item.status === 'pending','접수 상태만 승인할 수 있습니다.');status='approved';eventType='approved';
      } else if(action === 'cancel') {
        check(['pending','approved'].includes(item.status),'처리 중인 항목은 변경할 수 없습니다.');status='cancelled';eventType='rejected';
      } else {
        check(item.status === 'needs_review','확인 필요 상태만 수동 판정할 수 있습니다.');
        check(this.paused(),'먼저 불출을 중지하고 회사 PC 프로그램을 종료하세요.');
        check(typeof note === 'string' && note.trim().length >= 10 && note.length <= 1000,'HOMS 내역 확인 근거를 10자 이상 입력하세요.',400);
        check(['confirm_completed','confirm_not_submitted'].includes(action),'잘못된 작업입니다.',400);
        status=action === 'confirm_completed' ? 'completed' : 'pending';
      }
      this.db.prepare('UPDATE request_items SET status=?,attempt_id=NULL,updated_at=?,evidence=? WHERE id=?').run(status,Date.now(),note || '',id);
      this.event(id,eventType,'admin',note || '');
      this.pruneItems();
      return this.item(id);
    });
  }
  heartbeat(mode) {
    check(['check','live'].includes(mode),'잘못된 모드입니다.',400);
    this.db.prepare('INSERT INTO worker_status VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,mode=excluded.mode').run(Date.now(),mode);
    return {paused:this.paused(),batch_active:this.batchActive(),schema_version:2,worker_protocol:3};
  }
  preview() {
    const blocked=this.db.prepare("SELECT id,status FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get();
    const allowed=new Set(this.batchActive() ? this.batchItems() : []);
    const all=this.db.prepare("SELECT i.id,i.request_id,i.material_code,i.material_name,i.quantity,i.status,r.manager_name FROM request_items i JOIN requests r ON r.id=i.request_id WHERE i.status='approved' ORDER BY i.updated_at,i.id LIMIT 1000").all();
    const items=this.batchActive() ? all.filter(item=>allowed.has(item.id)).slice(0,50) : [];
    return {paused:this.paused(),batch_active:this.batchActive(),batch_remaining:this.batchRemaining(),worker_protocol:3,blocked:blocked || null,items};
  }
  claim() {
    return this.tx(() => {
      check(!this.paused() && this.batchActive(),'일괄 불출이 시작되지 않았습니다.');
      check(!this.db.prepare("SELECT id FROM request_items WHERE status IN ('claimed','submitting','needs_review') LIMIT 1").get(),'처리 중 또는 확인 필요 항목을 먼저 확인하세요.');
      let next=null;
      for(const id of this.batchItems()) {
        if(this.db.prepare("SELECT id FROM request_items WHERE id=? AND status='approved'").get(id)){next=id;break;}
      }
      if(!next) return null;
      this.db.prepare("UPDATE request_items SET status='claimed',attempt_id=?,updated_at=? WHERE id=?").run(randomUUID(),Date.now(),next);
      this.event(next,'claimed','worker');return this.item(next);
    });
  }
  transition(id,attempt,action,note,proof) {
    return this.tx(() => {
      const item=this.item(id);
      check(typeof attempt === 'string' && item.attempt_id === attempt,'처리 권한이 만료됐습니다. 재불출하지 마세요.');
      if(action === 'begin') {
        check(!this.paused() && this.batchActive() && item.status === 'claimed','불출 시작이 허용되지 않습니다.');
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
      this.event(id,action,'worker',note || '');
      this.pruneItems();
      return this.item(id);
    });
  }
  overview() {
    const approved=this.db.prepare("SELECT COUNT(*) AS n FROM request_items WHERE status='approved'").get().n;
    const pending=this.db.prepare("SELECT COUNT(*) AS n FROM request_items WHERE status='pending'").get().n;
    const batchIds=new Set(this.batchItems());
    let batchApproved=0;
    if(this.batchActive()) for(const row of this.db.prepare("SELECT id FROM request_items WHERE status='approved'").all()) if(batchIds.has(row.id)) batchApproved++;
    return {paused:this.paused(),batch_active:this.batchActive(),batch_remaining:this.batchRemaining(),approved_waiting:this.batchActive()?approved-batchApproved:approved,
      pending_waiting:pending,approval_sheet:this.approvalSheet(),counts:this.db.prepare('SELECT status,COUNT(*) AS count FROM request_items GROUP BY status').all(),
      worker:this.db.prepare('SELECT * FROM worker_status WHERE id=1').get() || null,schema_version:2,items:this.items()};
  }
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