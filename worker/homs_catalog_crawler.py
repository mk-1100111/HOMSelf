"""One-shot HOMS catalog/image synchronizer for the company PC.

Run this with the normal HOMSelf Worker STOPPED because it reuses the same Chrome
profile. It performs four jobs:
  1) Read HOMS inventory metadata (code/name/specification).
  2) Update the local HOMSelf-data/config/catalog.json by material_code.
  3) Rename/copy existing HOMSelf material images from name-based filenames to
     code-based filenames, then crawl missing images from HOMS.
  4) Commit and push only the catalog and material-image changes with local git.

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

from selenium import webdriver
from selenium.common.exceptions import StaleElementReferenceException, TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import Select, WebDriverWait

ROOT = Path(__file__).resolve().parent
HOMSELF_ROOT = ROOT.parent
DEFAULT_DATA_ROOT = HOMSELF_ROOT.parent / 'HOMSelf-data'
IMAGE_DIR = HOMSELF_ROOT / 'public' / 'static' / 'img' / 'material_list'
SEARCH_XPATH = '//*[@id="_searchBar"]'
IMAGE_XPATH = '//*[@id="spl_thum_0_0"]/img'
DISPLAY_XPATH = '//*[@id="srcDisplayYn"]'
QUERY_XPATH = '//*[@id="frm"]/div[1]/table/tbody/tr[1]/td[4]/a[1]'
PAGE_SIZE_XPATH = '//*[@id="frm"]/div[2]/div[2]/select'
ROWS_XPATH = '//*[@id="wrap"]/div[3]/div[2]/table/tbody/tr'
HEADER_XPATH = '//*[@id="wrap"]/div[3]/div[2]/table/thead/tr/th[1]'
IMAGE_EXTENSIONS = ('.jpg', '.jpeg', '.png', '.webp')


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


def parse_material_cell(text: str) -> tuple[str, str, str]:
    lines = [line.strip() for line in str(text).splitlines() if line.strip()]
    if not lines:
        raise RuntimeError('상품코드/상품명/규격 셀이 비어 있습니다.')

    def clean(value: str) -> str:
        return re.sub(r'^(상품코드|상품명|규격)\s*[:：]?\s*', '', value).strip()

    lines = [clean(line) for line in lines if clean(line)]
    if len(lines) >= 2:
        code, name = lines[0], lines[1]
        specification = ' / '.join(lines[2:])
    else:
        match = re.search(r'([A-Za-z0-9_-]{4,80})', lines[0])
        if not match:
            raise RuntimeError('상품코드를 해석할 수 없습니다: ' + lines[0])
        code = match.group(1)
        name = (lines[0][:match.start()] + lines[0][match.end():]).strip(' /|-') or code
        specification = ''
    code_match = re.search(r'([A-Za-z0-9_-]{1,80})', code)
    if not code_match:
        raise RuntimeError('상품코드 형식이 잘못됐습니다: ' + code)
    return code_match.group(1), name.strip(), specification.strip()


def open_browser(selectors: dict, profile_dir: Path):
    options = Options()
    profile_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument('--user-data-dir=' + str(profile_dir.resolve()))
    options.add_experimental_option('excludeSwitches', ['enable-automation', 'enable-logging'])
    options.add_experimental_option('useAutomationExtension', False)
    driver = webdriver.Chrome(options=options)
    driver.maximize_window()
    driver.get(selectors['stock_url'])
    return driver


def select_all(driver) -> None:
    element = WebDriverWait(driver, 15).until(lambda d: d.find_element(By.XPATH, DISPLAY_XPATH))
    Select(element).select_by_visible_text('전체')


def select_90(driver) -> None:
    def apply(_):
        try:
            element = driver.find_element(By.XPATH, PAGE_SIZE_XPATH)
            select = Select(element)
            option = next((o for o in select.options if '90' in (o.text or '')), None)
            if not option:
                return False
            select.select_by_value(option.get_attribute('value'))
            return '90' in (Select(driver.find_element(By.XPATH, PAGE_SIZE_XPATH)).first_selected_option.text or '')
        except StaleElementReferenceException:
            return False
    WebDriverWait(driver, 15, poll_frequency=.35).until(apply)


def crawl_metadata(driver) -> list[dict]:
    select_all(driver)
    driver.find_element(By.XPATH, QUERY_XPATH).click()
    WebDriverWait(driver, 20).until(lambda d: d.find_element(By.XPATH, HEADER_XPATH))
    WebDriverWait(driver, 20).until(
        lambda d: d.execute_script(
            'return document.evaluate(arguments[0],document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null).snapshotLength;',
            ROWS_XPATH
        ) > 0
    )
    select_90(driver)
    time.sleep(1.0)
    raw_rows = driver.execute_script("""
        const xp=arguments[0];
        const snap=document.evaluate(xp,document,null,XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,null);
        const out=[];
        for(let i=0;i<snap.snapshotLength;i++){
          const row=snap.snapshotItem(i), cells=row.querySelectorAll('td');
          if(cells.length>=4) out.push((cells[3].innerText||'').trim());
        }
        return out;
    """, ROWS_XPATH)
    rows, seen = [], set()
    for text in raw_rows:
        code, name, specification = parse_material_cell(text)
        if code in seen:
            continue
        seen.add(code)
        rows.append({'material_code': code, 'material_name': name, 'specification': specification})
    if not rows:
        raise RuntimeError('HOMS 기준정보를 읽지 못했습니다.')
    print('HOMS 기준정보 조회:', len(rows), '건', flush=True)
    return rows


def update_catalog(catalog: dict, rows: list[dict]) -> tuple[int, int]:
    materials = catalog.setdefault('materials', [])
    by_code = {str(item.get('material_code')): item for item in materials if isinstance(item, dict)}
    updated = added = 0
    for row in rows:
        code = row['material_code']
        target = by_code.get(code)
        if target is None:
            target = {'material_code': code, 'material_name': row['material_name'], 'material_unit': 1, 'visible': True}
            materials.append(target)
            by_code[code] = target
            added += 1
        changed = False
        if target.get('material_name') != row['material_name']:
            target['material_name'] = row['material_name']
            changed = True
        specification = row.get('specification', '').strip()
        if specification:
            if target.get('specification') != specification:
                target['specification'] = specification
                changed = True
        elif 'specification' in target:
            target.pop('specification', None)
            changed = True
        if 'material_unit' not in target or not isinstance(target.get('material_unit'), int) or target['material_unit'] < 1:
            target['material_unit'] = 1
            changed = True
        if 'visible' not in target:
            target['visible'] = True
            changed = True
        if changed and target is not None:
            updated += 1
    return updated, added


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
        name, code = str(item.get('material_name', '')).strip(), str(item.get('material_code', '')).strip()
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


def ready_image(driver, old_element, old_src):
    nodes = driver.find_elements(By.XPATH, IMAGE_XPATH)
    if len(nodes) != 1:
        return False
    image = nodes[0]
    if not image.is_displayed():
        return False
    src = (image.get_attribute('src') or '').strip()
    if not src:
        return False
    lowered = src.lower()
    if any(word in lowered for word in ('noimage', 'no_image', 'blank.gif', 'placeholder')):
        return False
    try:
        if int(driver.execute_script('return arguments[0].naturalWidth||0;', image) or 0) < 2:
            return False
        if old_element is not None:
            try:
                if image.id == old_element.id and src == old_src:
                    return False
            except StaleElementReferenceException:
                pass
    except StaleElementReferenceException:
        return False
    return image


def crawl_one_image(driver, code: str) -> bytes | None:
    old_element = None
    old_src = ''
    old_nodes = driver.find_elements(By.XPATH, IMAGE_XPATH)
    if len(old_nodes) == 1:
        old_element = old_nodes[0]
        try:
            old_src = (old_element.get_attribute('src') or '').strip()
        except StaleElementReferenceException:
            old_element = None
    search = WebDriverWait(driver, 12).until(lambda d: d.find_element(By.XPATH, SEARCH_XPATH))
    search.click();search.send_keys(Keys.CONTROL, 'a');search.send_keys(Keys.BACKSPACE);search.send_keys(code);search.send_keys(Keys.ENTER)
    try:
        image = WebDriverWait(driver, 12, poll_frequency=.35).until(lambda _: ready_image(driver, old_element, old_src))
    except TimeoutException:
        # Some HOMS searches reuse the same img element/src. Give the settled result one last check.
        time.sleep(.8)
        nodes = driver.find_elements(By.XPATH, IMAGE_XPATH)
        if len(nodes) != 1 or not nodes[0].is_displayed():
            return None
        image = nodes[0]
        if not (image.get_attribute('src') or '').strip():
            return None
    time.sleep(.2)
    return image.screenshot_as_png or None


def crawl_missing_images(driver, catalog: dict, image_dir: Path) -> tuple[int, int]:
    saved = skipped = 0
    materials = [x for x in catalog.get('materials', []) if isinstance(x, dict)]
    targets = [x for x in materials if not existing_code_image(image_dir, str(x.get('material_code', '')))]
    print('이미지 없는 부자재:', len(targets), '건', flush=True)
    for index, item in enumerate(targets, 1):
        code = str(item.get('material_code', '')).strip()
        if not code:
            continue
        print(f'이미지 검색 {index}/{len(targets)}:', code, item.get('material_name', ''), flush=True)
        try:
            png = crawl_one_image(driver, code)
            if not png:
                skipped += 1
                print('이미지 없음 - 건너뜀:', code, flush=True)
                continue
            target = image_dir / f'{code}.png'
            target.write_bytes(png)
            saved += 1
            print('이미지 저장:', target.name, flush=True)
        except Exception as error:
            skipped += 1
            print('이미지 검색 실패:', code, type(error).__name__, str(error), flush=True)
        time.sleep(.35)
    return saved, skipped


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
    parser = argparse.ArgumentParser(description='HOMS 기준정보/부자재 이미지 일괄 동기화')
    parser.add_argument('--data-repo', type=Path, default=DEFAULT_DATA_ROOT, help='HOMSelf-data 로컬 저장소 경로')
    parser.add_argument('--no-images', action='store_true', help='이미지 크롤링은 건너뛰고 이름/규격만 갱신')
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
        rows = crawl_metadata(driver)
        updated, added = update_catalog(catalog, rows)
        save_json(catalog_path, catalog)
        print('catalog 갱신: 기존 수정', updated, '건 / 신규 추가', added, '건', flush=True)
        if not args.no_images:
            saved, skipped = crawl_missing_images(driver, catalog, IMAGE_DIR)
            print('이미지 크롤링: 저장', saved, '건 / 건너뜀', skipped, '건', flush=True)
    finally:
        driver.quit()

    if args.no_push:
        print('--no-push 지정: Git commit/push 생략', flush=True)
        return
    commit_if_changed(data_root, 'config/catalog.json', 'Sync HOMSelf material names and specifications from HOMS', 'main')
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
