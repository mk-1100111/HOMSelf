const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./app');
const {
  DATA_REPOSITORY,
  CATALOG_FILE,
  STOCK_SNAPSHOT_FILE,
  githubToken,
  readJsonFile
} = require('./github_data');

const STARTUP_CATALOG_FILE = path.join(os.tmpdir(), 'homself-catalog-github.json');
const STARTUP_STOCK_FILE = path.join(os.tmpdir(), 'homself-stock-github.json');

function validateCatalogShape(catalog) {
  if (!catalog || typeof catalog !== 'object') throw new Error('catalog JSON 객체가 아닙니다.');
  if (!Array.isArray(catalog.managers) || !catalog.managers.length) throw new Error('catalog managers가 비어 있습니다.');
  if (!Array.isArray(catalog.materials) || !catalog.materials.length) throw new Error('catalog materials가 비어 있습니다.');
  for (const item of catalog.materials) {
    if (!item || typeof item.material_code !== 'string' || !item.material_code.trim()) throw new Error('catalog 상품코드가 잘못됐습니다.');
    if (typeof item.material_name !== 'string' || !item.material_name.trim()) throw new Error('catalog 상품명이 잘못됐습니다.');
    if (!Number.isSafeInteger(item.material_unit) || item.material_unit < 1) throw new Error('catalog 불출단위가 잘못됐습니다.');
  }
}

function validateStockSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.version !== 1) throw new Error('재고 snapshot 버전이 잘못됐습니다.');
  if (!Array.isArray(snapshot.items)) throw new Error('재고 snapshot items가 잘못됐습니다.');
  for (const row of snapshot.items) {
    if (!row || typeof row.material_code !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(row.material_code)) throw new Error('재고 snapshot 상품코드가 잘못됐습니다.');
    if (typeof row.material_name !== 'string' || !row.material_name.trim()) throw new Error('재고 snapshot 상품명이 잘못됐습니다.');
    if (!Number.isSafeInteger(row.stock_quantity) || row.stock_quantity < 0) throw new Error('재고 snapshot 수량이 잘못됐습니다.');
    if (!Number.isSafeInteger(row.synced_at) || row.synced_at <= 0) throw new Error('재고 snapshot 동기화 시간이 잘못됐습니다.');
  }
}

function writeStartupFile(filePath, text) {
  const temporary = filePath + '.new';
  fs.writeFileSync(temporary, text.endsWith('\n') ? text : text + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

function configurePersistentDb(config) {
  const dir = String(config.HOMSELF_PERSISTENT_DATA_DIR || '').trim();
  if (!dir) {
    if (config.NODE_ENV === 'production' && String(config.DB_PATH || '').startsWith('/tmp/')) {
      console.warn('주의: DB_PATH가 /tmp 입니다. Render 재배포 시 불출요청이 사라질 수 있습니다. Persistent Disk를 /var/data 등에 연결하세요.');
    }
    return;
  }

  if (!path.isAbsolute(dir)) throw new Error('HOMSELF_PERSISTENT_DATA_DIR는 절대 경로여야 합니다.');
  fs.mkdirSync(dir, { recursive: true });
  config.DB_PATH = path.join(dir, 'homself.sqlite');
  console.log('영구 SQLite 경로 사용:', config.DB_PATH);
}

async function prepareStartupConfig(sourceConfig = process.env) {
  const config = { ...sourceConfig };
  configurePersistentDb(config);

  const token = githubToken(config);
  if (!token) {
    console.log('GitHub startup data 토큰 없음: 기존 CATALOG_PATH와 DB 재고를 사용합니다.');
    return config;
  }

  try {
    const result = await readJsonFile(config, CATALOG_FILE);
    validateCatalogShape(result.value);
    writeStartupFile(STARTUP_CATALOG_FILE, result.text);
    config.CATALOG_PATH = STARTUP_CATALOG_FILE;
    console.log('GitHub 최신 catalog로 서버 시작:', `${DATA_REPOSITORY}/${CATALOG_FILE}`, '부자재', result.value.materials.length, '건');
  } catch (error) {
    console.error('GitHub startup catalog 조회 실패 - 기존 CATALOG_PATH로 시작:', error.name || 'Error', error.message || String(error));
  }

  try {
    const result = await readJsonFile(config, STOCK_SNAPSHOT_FILE, { optional: true });
    if (result) {
      validateStockSnapshot(result.value);
      writeStartupFile(STARTUP_STOCK_FILE, result.text);
      config.STOCK_SNAPSHOT_PATH = STARTUP_STOCK_FILE;
      console.log('GitHub 마지막 재고 snapshot 준비:', result.value.items.length, '건');
    } else {
      console.log('GitHub 재고 snapshot 없음: Worker 최초 동기화를 기다립니다.');
    }
  } catch (error) {
    console.error('GitHub 재고 snapshot 조회 실패 - DB 저장 재고만 사용:', error.name || 'Error', error.message || String(error));
  }

  return config;
}

async function main() {
  const config = await prepareStartupConfig(process.env);
  const { app, store } = createApp(config);
  const server = app.listen(config.PORT || 3000, () => {
    console.log('HOMSelf 시작: 승인 시트의 항목은 일괄 불출 시작 전까지 대기합니다.');
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => server.close(() => {
      store.close();
      process.exit(0);
    }));
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('HOMSelf 시작 실패:', error.name || 'Error', error.message || String(error));
    process.exit(1);
  });
}

module.exports = { prepareStartupConfig, validateCatalogShape, validateStockSnapshot, configurePersistentDb };
