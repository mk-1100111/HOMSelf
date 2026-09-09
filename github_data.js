const { Buffer } = require('node:buffer');

const DATA_REPOSITORY = 'mk-1100111/HOMSelf-data';
const DATA_BRANCH = 'main';
const APP_REPOSITORY = 'mk-1100111/HOMSelf';
const APP_BRANCH = 'master';
const CATALOG_FILE = 'config/catalog.json';
const STOCK_SNAPSHOT_FILE = 'runtime/stock_snapshot.json';
const RUNTIME_STATE_FILE = 'runtime/queue_state.json';
const MATERIAL_IMAGE_PREFIX = 'public/static/img/material_list';

function githubToken(config = process.env) {
  return String(
    config.HOMSELF_CATALOG_GITHUB_TOKEN ||
    config.HOMSELF_BACKUP_GITHUB_TOKEN ||
    ''
  ).trim();
}

function appGithubToken(config = process.env) {
  return String(config.HOMSELF_APP_GITHUB_TOKEN || githubToken(config) || '').trim();
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'HOMSelf-Render'
  };
}

function encodedPath(filePath) {
  return String(filePath).split('/').map(encodeURIComponent).join('/');
}

function repositoryContentsUrl(repository, filePath) {
  return `https://api.github.com/repos/${repository}/contents/${encodedPath(filePath)}`;
}

function contentsUrl(filePath) {
  return repositoryContentsUrl(DATA_REPOSITORY, filePath);
}

async function readJsonFile(config, filePath, { optional = false } = {}) {
  const token = githubToken(config);
  if (!token) {
    if (optional) return null;
    throw new Error('HOMSELF_CATALOG_GITHUB_TOKEN 또는 HOMSELF_BACKUP_GITHUB_TOKEN이 필요합니다.');
  }

  const response = await fetch(`${contentsUrl(filePath)}?ref=${encodeURIComponent(DATA_BRANCH)}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(10000)
  });

  if (optional && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${filePath} 읽기 실패: HTTP ${response.status}`);

  const payload = await response.json();
  if (payload.encoding !== 'base64' || typeof payload.content !== 'string' || !payload.content) {
    throw new Error(`GitHub ${filePath} 응답 형식이 잘못됐습니다.`);
  }

  const decoded = Buffer.from(payload.content.replace(/\n/g, ''), 'base64').toString('utf8');
  return {
    value: JSON.parse(decoded),
    text: decoded,
    sha: String(payload.sha || '')
  };
}

async function currentSha(config, filePath) {
  const result = await readJsonFile(config, filePath, { optional: true });
  return result ? result.sha : '';
}

async function repositoryFileSha(repository, branch, filePath, token) {
  const response = await fetch(`${repositoryContentsUrl(repository, filePath)}?ref=${encodeURIComponent(branch)}`, {
    headers: headers(token),
    signal: AbortSignal.timeout(10000)
  });
  if (response.status === 404) return '';
  if (!response.ok) throw new Error(`GitHub ${repository}/${filePath} 조회 실패: HTTP ${response.status}`);
  const payload = await response.json();
  return String(payload.sha || '');
}

async function writeRepositoryBase64(repository, branch, filePath, base64, message, token) {
  if (!token) throw new Error('HOMSelf 이미지 GitHub 저장 토큰이 설정되지 않았습니다.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = await repositoryFileSha(repository, branch, filePath, token);
    const body = { message, branch, content: base64 };
    if (sha) body.sha = sha;
    const response = await fetch(repositoryContentsUrl(repository, filePath), {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) {
      const payload = await response.json();
      return String(payload.commit && payload.commit.sha || '');
    }
    if ((response.status === 409 || response.status === 422) && attempt === 0) continue;
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub ${repository}/${filePath} 저장 실패: HTTP ${response.status}${detail ? ' ' + detail.slice(0, 240) : ''}`);
  }
  throw new Error(`GitHub ${repository}/${filePath} 저장 충돌을 해결하지 못했습니다.`);
}

async function deleteRepositoryFile(repository, branch, filePath, message, token) {
  if (!token) throw new Error('HOMSelf 이미지 GitHub 저장 토큰이 설정되지 않았습니다.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = await repositoryFileSha(repository, branch, filePath, token);
    if (!sha) return '';
    const response = await fetch(repositoryContentsUrl(repository, filePath), {
      method: 'DELETE',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, branch, sha }),
      signal: AbortSignal.timeout(20000)
    });
    if (response.ok) {
      const payload = await response.json();
      return String(payload.commit && payload.commit.sha || '');
    }
    if ((response.status === 409 || response.status === 422) && attempt === 0) continue;
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub ${repository}/${filePath} 삭제 실패: HTTP ${response.status}${detail ? ' ' + detail.slice(0, 240) : ''}`);
  }
  throw new Error(`GitHub ${repository}/${filePath} 삭제 충돌을 해결하지 못했습니다.`);
}

function materialImageFile(code) {
  return `${MATERIAL_IMAGE_PREFIX}/${code}.jpg`;
}

function materialImageUrl(code) {
  return `/public/static/img/material_list/${code}.jpg`;
}

async function persistCatalogMaterialImages(config, value) {
  if (!value || !Array.isArray(value.materials)) return value;

  const persisted = JSON.parse(JSON.stringify(value));
  const previous = await readJsonFile(config, CATALOG_FILE, { optional: true });
  const previousByCode = new Map(
    previous && previous.value && Array.isArray(previous.value.materials)
      ? previous.value.materials.map(item => [String(item.material_code || ''), item])
      : []
  );
  const token = appGithubToken(config);

  for (const material of persisted.materials) {
    const code = String(material && material.material_code || '').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(code)) continue;

    const image = typeof material.image_data === 'string' ? material.image_data : '';
    const staticUrl = materialImageUrl(code);
    const staticFile = materialImageFile(code);
    const previousItem = previousByCode.get(code) || {};
    const previousImage = typeof previousItem.image_data === 'string' ? previousItem.image_data : '';

    const jpeg = image.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/i);
    if (jpeg) {
      const bytes = Buffer.from(jpeg[1], 'base64');
      if (bytes.length === 0 || bytes.length > 800000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        throw new Error(`부자재 ${code} JPEG 이미지 데이터가 잘못됐습니다.`);
      }
      await writeRepositoryBase64(
        APP_REPOSITORY,
        APP_BRANCH,
        staticFile,
        jpeg[1],
        `Update HOMSelf material image ${code}`,
        token
      );
      material.image_data = staticUrl;
      continue;
    }

    if (!image && previousImage === staticUrl) {
      await deleteRepositoryFile(
        APP_REPOSITORY,
        APP_BRANCH,
        staticFile,
        `Remove HOMSelf material image ${code}`,
        token
      );
    }
  }

  return persisted;
}

async function writeJsonFile(config, filePath, value, message, {compact=false} = {}) {
  const token = githubToken(config);
  if (!token) throw new Error('GitHub 영구 저장 토큰이 설정되지 않았습니다.');

  const persistedValue = filePath === CATALOG_FILE
    ? await persistCatalogMaterialImages(config, value)
    : value;
  const text = (compact ? JSON.stringify(persistedValue) : JSON.stringify(persistedValue, null, 2)) + '\n';

  for (let attempt = 0; attempt < 2; attempt++) {
    const sha = await currentSha(config, filePath);
    const body = {
      message,
      branch: DATA_BRANCH,
      content: Buffer.from(text, 'utf8').toString('base64')
    };
    if (sha) body.sha = sha;

    const response = await fetch(contentsUrl(filePath), {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000)
    });

    if (response.ok) {
      const payload = await response.json();
      return String(payload.commit && payload.commit.sha || '');
    }

    if ((response.status === 409 || response.status === 422) && attempt === 0) continue;
    const detail = await response.text().catch(() => '');
    throw new Error(`GitHub ${filePath} 저장 실패: HTTP ${response.status}${detail ? ' ' + detail.slice(0, 240) : ''}`);
  }

  throw new Error(`GitHub ${filePath} 저장 충돌을 해결하지 못했습니다.`);
}

module.exports = {
  DATA_REPOSITORY,
  DATA_BRANCH,
  APP_REPOSITORY,
  APP_BRANCH,
  CATALOG_FILE,
  STOCK_SNAPSHOT_FILE,
  RUNTIME_STATE_FILE,
  githubToken,
  appGithubToken,
  readJsonFile,
  writeJsonFile
};
