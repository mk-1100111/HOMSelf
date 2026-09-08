"""One-shot HOMS catalog/image synchronizer for the company PC.

This tool intentionally does NOT use the HOMS stock-inquiry page. After login it uses
HOMS's global search bar for each material_code already present in HOMSelf-data:
  1) search material_code in //*[@id="_searchBar"]
  2) read the first result card around //*[@id="spl_thum_0_0"]/img
  3) update the matching material_name/specification when they can be parsed safely
  4) save a missing image as public/static/img/material_list/<material_code>.png
  5) commit/push HOMSelf-data catalog and HOMSelf images with local git

Existing name-based image files are converted to code-based filenames first.
No stock quantities are written to GitHub.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException, TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent
HOMSELF_ROOT = ROOT.parent
DEFAULT_DATA_ROOT = HOMSELF_ROOT.parent / 'HOMSelf-data'
IMAGE_DIR = HOMSELF_ROOT / 'public' / 'static' / 'img' / 'material_list'
SEARCH_XPATH = '//*[@id="_searchBar"]'
IMAGE_XPATH = '//*[@id="spl_thum_0_0"]/img'
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp')
LOGIN_WAIT_SECONDS = 180
RESULT_WAIT_SECONDS = 15


def run_git(repo: Path, *args: str, capture: bool = False) -> str:
    cmd = ['git', '-C', str(repo), *args]
    result = subprocess.run(cmd, text=True, encoding='utf-8', errors='replace', capture_output=capture)
    if result.returncode:
        detail = (result.stderr or result.stdout or '').strip() if capture else ''
        raise RuntimeError('Git 명령 실패: ' + ' '.join(cmd) + (('\n' + detail) if detail else ''))
    return (result.stdout or '').strip() if capture else ''


def ensure_data_repo(path: Path) -> Path:
    if (path / '.git').exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print('HOMSelf-data 로컬 저장소가 없어 clone 합니다:', path, flush=True)
    result = subprocess.run(
        ['git', 'clone', 'https://github.com/mk-1100111/HOMSelf-data.git', str(path)],
        text=True, encoding='utf-8', errors='replace'
    )
    if result.returncode:
        raise RuntimeError('HOMSelf-data clone 실패. Windows Git 자격 증명에서 private 저장소 접근을 확인하세요.')
    return path


def require_clean_repo(repo: Path, allowed_prefixes: tuple[str, ...] = ()) -> None:
    status = run_git(repo, 'status', '--porcelain', capture=True)
    if not status:
        return
    unexpected = []
    for line in status.splitlines():
        path = line[3:].replace('\\', '/') if len(line) > 3 else line
        if not any(path.startswith(prefix) for prefix in allowed_prefixes):
            unexpected.append(line)
    if unexpected:
        raise RuntimeError('커밋되지 않은 다른 변경사항이 있습니다. 먼저 정리하세요:\n' + '\n'.join(unexpected))


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding='utf-8-sig'))


def save_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def image_candidates(image_dir: Path, code: str) -> list[Path]:
    return [image_dir / (code + ext) for ext in IMAGE_EXTENSIONS]


def existing_code_image(image_dir: Path, code: str) -> Path | None:
    return next((p for p in image_candidates(image_dir, code) if p.exists()), None)


def migrate_name_images(image_dir: Path, catalog_before: dict) -> tuple[int, int]:
    image_dir.mkdir(parents=True, exist_ok=True)
    by_name: dict[str, list[str]] = {}
    for item in catalog_before.get('materials', []):
        if not isinstance(item, dict):
            continue
        name = str(item.get('material_name', '')).strip()
        code = str(item.get('material_code', '')).strip()
        if name and code:
            by_name.setdefault(name, []).append(code)

    copied = removed = 0
    for source in list(image_dir.iterdir()):
        if not source.is_file() or source.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        if re.fullmatch(r'[A-Za-z0-9_-]{1,80}', source.stem):
            continue
        codes = by_name.get(source.stem, [])
        if not codes:
            print('기존 이미지 코드 매칭 실패 - 유지:', source.name, flush=True)
            continue
        for code in codes:
            target = image_dir / (code + source.suffix.lower())
            if not target.exists():
                shutil.copy2(source, target)
                copied += 1
                print('기존 이미지 코드화:', source.name, '->', target.name, flush=True)
        source.unlink()
        removed += 1
    return copied, removed


def homs_home_url(selectors: dict) -> str:
    raw = str(selectors.get('stock_url') or 'https://homs.biz/').strip()
    parsed = urlsplit(raw)
    if parsed.scheme != 'https' or parsed.hostname != 'homs.biz':
        return 'https://homs.biz/'
    return f'{parsed.scheme}://{parsed.netloc}/'


def open_browser(selectors: dict, profile_dir: Path):
    options = Options()
    profile_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument('--user-data-dir=' + str(profile_dir.resolve()))
    options.add_experimental_option('excludeSwitches', ['enable-automation', 'enable-logging'])
    options.add_experimental_option('useAutomationExtension', False)
    driver = webdriver.Chrome(options=options)
    driver.maximize_window()
    driver.get(homs_home_url(selectors))
    return driver


def wait_for_homs_search(driver) -> None:
    print('HOMS 로그인 후 상단 검색창이 나타날 때까지 기다립니다.', flush=True)
    try:
        WebDriverWait(driver, LOGIN_WAIT_SECONDS, poll_frequency=.5).until(
            lambda d: _visible_search(d)
        )
    except TimeoutException as error:
        raise RuntimeError(
            f'HOMS 검색창을 {LOGIN_WAIT_SECONDS}초 동안 확인하지 못했습니다. '
            f'현재 URL: {driver.current_url} / XPath: {SEARCH_XPATH}'
        ) from error
    print('HOMS 로그인/검색창 확인 완료:', driver.current_url, flush=True)


def _visible_search(driver):
    nodes = driver.find_elements(By.XPATH, SEARCH_XPATH)
    return nodes[0] if len(nodes) == 1 and nodes[0].is_displayed() and nodes[0].is_enabled() else False


def _result_snapshot(driver, code: str) -> dict | None:
    """Return the first search result image and the smallest nearby text block.

    HOMS markup can change. Instead of hardcoding a second fragile XPath for name/spec,
    walk upward from the known first-result thumbnail and choose the smallest ancestor
    that contains the searched product code. Metadata is updated only when parsing is
    confident; otherwise existing catalog values are preserved.
    """
    script = r"""
        const xp=arguments[0], code=String(arguments[1]);
        const img=document.evaluate(xp,document,null,XPathResult.FIRST_ORDERED_NODE_TYPE,null).singleNodeValue;
        if(!img || !img.offsetParent) return null;
        const src=(img.currentSrc||img.src||'').trim();
        const nw=Number(img.naturalWidth||img.width||0), nh=Number(img.naturalHeight||img.height||0);
        let node=img, best='', fallback='';
        for(let i=0;i<10 && node;i++,node=node.parentElement){
            const text=(node.innerText||'').replace(/\r/g,'').trim();
            if(text && (!fallback || text.length<fallback.length) && text.length<=1800) fallback=text;
            if(text && text.includes(code) && text.length<=1800 && (!best || text.length<best.length)) best=text;
        }
        return {src:src,width:nw,height:nh,text:best||fallback||''};
    """
    return driver.execute_script(script, IMAGE_XPATH, code)


def search_one(driver, code: str) -> tuple[object | None, str, str]:
    old_src = ''
    old = _result_snapshot(driver, code) or {}
    old_src = str(old.get('src') or '')

    search = WebDriverWait(driver, 12).until(lambda d: _visible_search(d))
    search.click()
    search.send_keys(Keys.CONTROL, 'a')
    search.send_keys(Keys.BACKSPACE)
    search.send_keys(code)
    search.send_keys(Keys.ENTER)

    def settled(_):
        snap = _result_snapshot(driver, code)
        if not snap:
            return False
        src = str(snap.get('src') or '').strip()
        text = str(snap.get('text') or '').strip()
        width = int(snap.get('width') or 0)
        height = int(snap.get('height') or 0)
        if not src or width < 2 or height < 2:
            return False
        lowered = src.lower()
        if any(word in lowered for word in ('noimage', 'no_image', 'blank.gif', 'placeholder')):
            # No-image result can still provide valid metadata.
            return snap if code in text else False
        if code in text or (old_src and src != old_src) or not old_src:
            return snap
        return False

    try:
        snap = WebDriverWait(driver, RESULT_WAIT_SECONDS, poll_frequency=.35).until(settled)
    except TimeoutException:
        return None, '', ''

    nodes = driver.find_elements(By.XPATH, IMAGE_XPATH)
    image = nodes[0] if len(nodes) == 1 and nodes[0].is_displayed() else None
    return image, str(snap.get('src') or ''), str(snap.get('text') or '')


def clean_result_lines(text: str) -> list[str]:
    ignored = {
        '상세보기', '바로가기', '검색', '장바구니', '신청', '선택', '재고', '상품코드', '상품명', '규격'
    }
    out: list[str] = []
    for raw in str(text).replace('\r', '\n').split('\n'):
        line = re.sub(r'\s+', ' ', raw).strip()
        line = re.sub(r'^(상품코드|상품명|규격)\s*[:：]?\s*', '', line).strip()
        if not line or line in ignored:
            continue
        if line not in out:
            out.append(line)
    return out


def parse_result_metadata(text: str, code: str, current_name: str) -> tuple[str | None, str | None]:
    """Conservative parser: never overwrite catalog data unless the searched code is visible."""
    if code not in str(text):
        return None, None
    lines = clean_result_lines(text)
    normalized: list[str] = []
    for line in lines:
        if line == code:
            continue
        if code in line:
            line = line.replace(code, '').strip(' -|/·:：')
            if not line:
                continue
        # Skip obvious UI/count/price-only strings.
        if re.fullmatch(r'[\d,]+(?:원|개|EA)?', line, re.I):
            continue
        normalized.append(line)

    if not normalized:
        return None, None

    # Prefer the existing name when HOMS still displays it; otherwise first meaningful line.
    name = next((line for line in normalized if current_name and line == current_name), normalized[0])
    rest = [line for line in normalized if line != name]
    specification = ' / '.join(rest[:4]).strip() if rest else ''
    return name, specification


def update_one_catalog_item(item: dict, name: str | None, specification: str | None) -> bool:
    changed = False
    if name and item.get('material_name') != name:
        print('상품명 수정:', item.get('material_code'), repr(item.get('material_name')), '->', repr(name), flush=True)
        item['material_name'] = name
        changed = True
    if specification is not None:
        specification = specification.strip()
        if specification and item.get('specification', '') != specification:
            print('규격 수정:', item.get('material_code'), '->', specification, flush=True)
            item['specification'] = specification
            changed = True
    return changed


def sync_catalog_and_images(driver, catalog: dict, image_dir: Path, no_images: bool) -> tuple[int, int, int]:
    materials = [x for x in catalog.get('materials', []) if isinstance(x, dict) and str(x.get('material_code', '')).strip()]
    metadata_updated = images_saved = skipped = 0
    print('검색 대상 부자재:', len(materials), '건', flush=True)

    for index, item in enumerate(materials, 1):
        code = str(item.get('material_code', '')).strip()
        current_name = str(item.get('material_name', '')).strip()
        has_image = existing_code_image(image_dir, code) is not None
        print(f'HOMS 검색 {index}/{len(materials)}:', code, current_name, flush=True)
        try:
            image, src, text = search_one(driver, code)
            if not src and not text:
                skipped += 1
                print('검색 결과 없음 - 기존 정보 유지:', code, flush=True)
                continue

            name, specification = parse_result_metadata(text, code, current_name)
            if name is None:
                print('이름/규격 자동 해석 보류 - 기존 정보 유지:', code, flush=True)
            elif update_one_catalog_item(item, name, specification):
                metadata_updated += 1

            if not no_images and not has_image:
                if image is None:
                    print('이미지 없음 - 건너뜀:', code, flush=True)
                else:
                    png = image.screenshot_as_png
                    if png:
                        target = image_dir / f'{code}.png'
                        target.write_bytes(png)
                        images_saved += 1
                        print('이미지 저장:', target.name, flush=True)
                    else:
                        print('이미지 캡처 실패 - 건너뜀:', code, flush=True)
        except Exception as error:
            skipped += 1
            print('처리 실패 - 기존 정보 유지:', code, type(error).__name__, str(error), flush=True)
        time.sleep(.35)

    return metadata_updated, images_saved, skipped


def commit_if_changed(repo: Path, add_path: str, message: str, branch: str) -> bool:
    run_git(repo, 'add', '-A', '--', add_path)
    changed = run_git(repo, 'diff', '--cached', '--name-only', capture=True)
    if not changed:
        print('Git 변경 없음:', repo.name, flush=True)
        return False
    run_git(repo, 'commit', '-m', message)
    run_git(repo, 'push', 'origin', branch)
    print('Git push 완료:', repo.name, branch, flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description='HOMS 검색 기반 기준정보/부자재 이미지 일괄 동기화')
    parser.add_argument('--data-repo', type=Path, default=DEFAULT_DATA_ROOT, help='HOMSelf-data 로컬 저장소 경로')
    parser.add_argument('--no-images', action='store_true', help='이미지 저장은 건너뛰고 이름/규격만 갱신')
    parser.add_argument('--no-push', action='store_true', help='파일만 수정하고 git commit/push는 하지 않음')
    args = parser.parse_args()

    data_root = ensure_data_repo(args.data_repo.resolve())
    catalog_path = data_root / 'config' / 'catalog.json'
    selectors_path = ROOT / 'selectors.json'
    if not selectors_path.exists():
        selectors_path = ROOT / 'selectors.auto.example.json'
    if not selectors_path.exists():
        raise RuntimeError('worker/selectors.json을 찾을 수 없습니다.')
    if not catalog_path.exists():
        raise RuntimeError('HOMSelf-data/config/catalog.json을 찾을 수 없습니다.')

    require_clean_repo(HOMSELF_ROOT, ('public/static/img/material_list/',))
    require_clean_repo(data_root, ('config/catalog.json',))
    if not args.no_push:
        run_git(HOMSELF_ROOT, 'pull', '--ff-only', 'origin', 'master')
        run_git(data_root, 'pull', '--ff-only', 'origin', 'main')

    selectors = load_json(selectors_path)
    catalog = load_json(catalog_path)
    catalog_before = json.loads(json.dumps(catalog, ensure_ascii=False))

    copied, removed = migrate_name_images(IMAGE_DIR, catalog_before)
    print('기존 이미지 코드화 완료: 생성', copied, '개 / 이름 파일 제거', removed, '개', flush=True)
    print('주의: 일반 Worker를 종료한 상태에서 실행해야 Chrome 프로필 충돌이 없습니다.', flush=True)

    driver = open_browser(selectors, ROOT / 'runtime' / 'chrome_profile')
    try:
        wait_for_homs_search(driver)
        updated, saved, skipped = sync_catalog_and_images(driver, catalog, IMAGE_DIR, args.no_images)
        save_json(catalog_path, catalog)
        print('HOMS 검색 동기화 완료: 기준정보 수정', updated, '건 / 이미지 저장', saved, '건 / 검색 실패', skipped, '건', flush=True)
    finally:
        driver.quit()

    if args.no_push:
        print('--no-push 지정: Git commit/push 생략', flush=True)
        return

    commit_if_changed(data_root, 'config/catalog.json', 'Sync HOMSelf material names and specifications from HOMS search', 'main')
    commit_if_changed(HOMSELF_ROOT, 'public/static/img/material_list', 'Sync HOMSelf material images by material code', 'master')


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('사용자 중단', flush=True)
        sys.exit(130)
    except Exception as error:
        print('실패:', type(error).__name__, str(error), flush=True)
        sys.exit(1)
