const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('./app');

const CATALOG_REPOSITORY = 'mk-1100111/HOMSelf-data';
const CATALOG_BRANCH = 'main';
const CATALOG_FILE = 'config/catalog.json';
const STARTUP_CATALOG_FILE = path.join(os.tmpdir(), 'homself-catalog-github.json');
const GITHUB_API_URL = `https://api.github.com/repos/${CATALOG_REPOSITORY}/contents/${CATALOG_FILE}?ref=${CATALOG_BRANCH}`;

function catalogToken(config) {
  return String(
    config.HOMSELF_CATALOG_GITHUB_TOKEN ||
    config.HOMSELF_BACKUP_GITHUB_TOKEN ||
    ''
  ).trim();
}

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

async function prepareStartupConfig(sourceConfig = process.env) {
  const config = {...sourceConfig};
  const token = catalogToken(config);

  if (!token) {
    console.log('GitHub startup catalog 토큰 없음: 기존 CATALOG_PATH를 사용합니다.');
    return config;
  }

  try {
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'HOMSelf-Render'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.encoding !== 'base64' || typeof payload.content !== 'string' || !payload.content) {
      throw new Error('GitHub catalog 응답 형식이 잘못됐습니다.');
    }

    const decoded = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
    const catalog = JSON.parse(decoded);
    validateCatalogShape(catalog);

    const temporary = STARTUP_CATALOG_FILE + '.new';
    fs.writeFileSync(temporary, decoded.endsWith('\n') ? decoded : decoded + '\n', {encoding:'utf8', mode:0o600});
    fs.renameSync(temporary, STARTUP_CATALOG_FILE);
    config.CATALOG_PATH = STARTUP_CATALOG_FILE;

    console.log(
      'GitHub 최신 catalog로 서버 시작:',
      `${CATALOG_REPOSITORY}/${CATALOG_FILE}`,
      '부자재',
      catalog.materials.length,
      '건'
    );
  } catch (error) {
    console.error(
      'GitHub startup catalog 조회 실패 - 기존 CATALOG_PATH로 시작:',
      error.name || 'Error',
      error.message || String(error)
    );
  }

  return config;
}

async function main() {
  const config = await prepareStartupConfig(process.env);
  const {app,store} = createApp(config);
  const server = app.listen(config.PORT || 3000, () => {
    console.log('HOMSelf 시작: 승인 시트의 항목은 일괄 불출 시작 전까지 대기합니다.');
  });

  for (const signal of ['SIGINT','SIGTERM']) {
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

module.exports = {prepareStartupConfig, validateCatalogShape};
