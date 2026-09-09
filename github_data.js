const { Buffer } = require('node:buffer');

const DATA_REPOSITORY = 'mk-1100111/HOMSelf-data';
const DATA_BRANCH = 'main';
const CATALOG_FILE = 'config/catalog.json';
const STOCK_SNAPSHOT_FILE = 'runtime/stock_snapshot.json';
const RUNTIME_STATE_FILE = 'runtime/queue_state.json';

function githubToken(config = process.env) {
  return String(
    config.HOMSELF_CATALOG_GITHUB_TOKEN ||
    config.HOMSELF_BACKUP_GITHUB_TOKEN ||
    ''
  ).trim();
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'HOMSelf-Render'
  };
}

function contentsUrl(filePath) {
  return `https://api.github.com/repos/${DATA_REPOSITORY}/contents/${filePath}`;
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

async function writeJsonFile(config, filePath, value, message, {compact=false} = {}) {
  const token = githubToken(config);
  if (!token) throw new Error('GitHub 영구 저장 토큰이 설정되지 않았습니다.');

  const text = (compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)) + '\n';

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
  CATALOG_FILE,
  STOCK_SNAPSHOT_FILE,
  RUNTIME_STATE_FILE,
  githubToken,
  readJsonFile,
  writeJsonFile
};
