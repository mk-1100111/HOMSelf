"""One-shot HOMS catalog/image synchronizer for the company PC.

After HOMS login this tool uses the global search bar for each material_code already
present in HOMSelf-data. HOMS is treated as the source of truth for material names
and specifications. Existing name-based images are renamed only after the searched
HOMS result confirms the material name, preventing stale catalog mappings from
assigning an image to the wrong code.

No stock quantities are written to GitHub.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from urllib.parse import urlsplit

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parent
HOMSELF_ROOT = ROOT.parent
DEFAULT_DATA_ROOT = HOMSELF_ROOT.parent / "HOMSelf-data"
IMAGE_DIR = HOMSELF_ROOT / "public" / "static" / "img" / "material_list"

SEARCH_XPATH = '//*[@id="_searchBar"]'
IMAGE_XPATH = '//*[@id="spl_thum_0_0"]/img'
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
LOGIN_WAIT_SECONDS = 180
RESULT_WAIT_SECONDS = 1


def material_code_pattern(code: str) -> str:
    return r"(?<![A-Za-z0-9_-])" + re.escape(str(code)) + r"(?![A-Za-z0-9_-])"


def material_code_matches(text: str, code: str) -> bool:
    return re.search(material_code_pattern(code), str(text or "")) is not None


def run_git(repo: Path, *args: str, capture: bool = False) -> str:
    cmd = ["git", "-C", str(repo), *args]
    result = subprocess.run(
        cmd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
    )
    if result.returncode:
        detail = (result.stderr or result.stdout or "").strip() if capture else ""
        raise RuntimeError(
            "Git 명령 실패: " + " ".join(cmd) + (("\n" + detail) if detail else "")
        )
    return (result.stdout or "").strip() if capture else ""


def ensure_data_repo(path: Path) -> Path:
    if (path / ".git").exists():
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    print("HOMSelf-data 로컬 저장소가 없어 clone 합니다:", path, flush=True)
    result = subprocess.run(
        ["git", "clone", "https://github.com/mk-1100111/HOMSelf-data.git", str(path)],
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode:
        raise RuntimeError(
            "HOMSelf-data clone 실패. Windows Git 자격 증명에서 private 저장소 접근을 확인하세요."
        )
    return path


def require_clean_repo(repo: Path, allowed_prefixes: tuple[str, ...] = ()) -> None:
    status = run_git(
        repo,
        "-c",
        "core.quotepath=false",
        "status",
        "--porcelain",
        capture=True,
    )
    if not status:
        return

    unexpected: list[str] = []
    for line in status.splitlines():
        path = line[3:].replace("\\", "/") if len(line) > 3 else line
        candidates = [part.strip() for part in path.split(" -> ")]
        if not any(
            any(candidate.startswith(prefix) for prefix in allowed_prefixes)
            for candidate in candidates
        ):
            unexpected.append(line)

    if unexpected:
        raise RuntimeError(
            "커밋되지 않은 다른 변경사항이 있습니다. 먼저 정리하세요:\n"
            + "\n".join(unexpected)
        )


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def save_json(path: Path, value: dict) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def image_candidates(image_dir: Path, code: str) -> list[Path]:
    return [image_dir / f"{code}{ext}" for ext in IMAGE_EXTENSIONS]


def existing_code_image(image_dir: Path, code: str) -> Path | None:
    return next((path for path in image_candidates(image_dir, code) if path.exists()), None)


def existing_named_image(image_dir: Path, name: str) -> Path | None:
    name = str(name or "").strip()
    if not name:
        return None
    return next(
        (
            image_dir / f"{name}{ext}"
            for ext in IMAGE_EXTENSIONS
            if (image_dir / f"{name}{ext}").exists()
        ),
        None,
    )


def migrate_confirmed_name_image(
    image_dir: Path,
    code: str,
    confirmed_name: str | None,
    previous_name: str,
) -> Path | None:
    current = existing_code_image(image_dir, code)
    if current:
        return current

    names: list[str] = []
    for value in (confirmed_name, previous_name):
        value = str(value or "").strip()
        if value and value not in names:
            names.append(value)

    for name in names:
        source = existing_named_image(image_dir, name)
        if not source:
            continue
        target = image_dir / f"{code}{source.suffix.lower()}"
        source.replace(target)
        print("기존 이미지 코드화:", source.name, "->", target.name, flush=True)
        return target
    return None


def homs_home_url(selectors: dict) -> str:
    raw = str(selectors.get("stock_url") or "https://homs.biz/").strip()
    parsed = urlsplit(raw)
    if parsed.scheme != "https" or parsed.hostname != "homs.biz":
        return "https://homs.biz/"
    return f"{parsed.scheme}://{parsed.netloc}/"


def open_browser(selectors: dict, profile_dir: Path):
    options = Options()
    profile_dir.mkdir(parents=True, exist_ok=True)
    options.add_argument("--user-data-dir=" + str(profile_dir.resolve()))
    options.add_experimental_option("excludeSwitches", ["enable-automation", "enable-logging"])
    options.add_experimental_option("useAutomationExtension", False)
    driver = webdriver.Chrome(options=options)
    driver.maximize_window()
    driver.get(homs_home_url(selectors))
    return driver


def _visible_search(driver):
    nodes = driver.find_elements(By.XPATH, SEARCH_XPATH)
    if len(nodes) == 1 and nodes[0].is_displayed() and nodes[0].is_enabled():
        return nodes[0]
    return False


def wait_for_homs_search(driver) -> None:
    print("HOMS 로그인 후 상단 검색창이 나타날 때까지 기다립니다.", flush=True)
    try:
        WebDriverWait(driver, LOGIN_WAIT_SECONDS, poll_frequency=0.5).until(_visible_search)
    except TimeoutException as error:
        raise RuntimeError(
            f"HOMS 검색창을 {LOGIN_WAIT_SECONDS}초 동안 확인하지 못했습니다. "
            f"현재 URL: {driver.current_url} / XPath: {SEARCH_XPATH}"
        ) from error
    print("HOMS 로그인/검색창 확인 완료:", driver.current_url, flush=True)


def _result_snapshot(driver, code: str) -> dict | None:
    script = r"""
        const xp=arguments[0], code=String(arguments[1]);
        const img=document.evaluate(
          xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if(!img || !img.offsetParent) return null;

        const src=(img.currentSrc||img.src||'').trim();
        const nw=Number(img.naturalWidth||img.width||0);
        const nh=Number(img.naturalHeight||img.height||0);
        const escaped=code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        const exactCode=new RegExp('(^|[^A-Za-z0-9_-])'+escaped+'([^A-Za-z0-9_-]|$)');

        let node=img, best='', fallback='';
        for(let i=0;i<10 && node;i++,node=node.parentElement){
            const text=(node.innerText||'').replace(/\r/g,'').trim();
            if(text && (!fallback || text.length<fallback.length) && text.length<=1800)
                fallback=text;
            if(text && exactCode.test(text) && text.length<=1800 &&
               (!best || text.length<best.length))
                best=text;
        }
        return {src:src,width:nw,height:nh,text:best||fallback||''};
    """
    return driver.execute_script(script, IMAGE_XPATH, code)


def search_one(driver, code: str) -> tuple[object | None, str, str]:
    search = WebDriverWait(driver, 12).until(_visible_search)
    search.click()
    search.send_keys(Keys.CONTROL, "a")
    search.send_keys(Keys.BACKSPACE)
    search.send_keys(code)
    search.send_keys(Keys.ENTER)

    def settled(_):
        snap = _result_snapshot(driver, code)
        if not snap:
            return False

        src = str(snap.get("src") or "").strip()
        text = str(snap.get("text") or "").strip()
        width = int(snap.get("width") or 0)
        height = int(snap.get("height") or 0)

        if not src or width < 2 or height < 2:
            return False
        if not material_code_matches(text, code):
            return False

        lowered = src.lower()
        if any(word in lowered for word in ("noimage", "no_image", "blank.gif", "placeholder")):
            return snap

        return snap

    try:
        snap = WebDriverWait(
            driver,
            RESULT_WAIT_SECONDS,
            poll_frequency=0.2,
        ).until(settled)
    except TimeoutException:
        return None, "", ""

    nodes = driver.find_elements(By.XPATH, IMAGE_XPATH)
    image = nodes[0] if len(nodes) == 1 and nodes[0].is_displayed() else None
    return image, str(snap.get("src") or ""), str(snap.get("text") or "")


def clean_result_lines(text: str) -> list[str]:
    ignored = {
        "상세보기",
        "바로가기",
        "검색",
        "장바구니",
        "신청",
        "선택",
        "재고",
        "상품코드",
        "상품명",
        "규격",
    }
    out: list[str] = []
    for raw in str(text).replace("\r", "\n").split("\n"):
        line = re.sub(r"\s+", " ", raw).strip()
        line = re.sub(r"^(상품코드|상품명|규격)\s*[:：]?\s*", "", line).strip()
        if not line or line in ignored:
            continue
        if line not in out:
            out.append(line)
    return out


def parse_result_metadata(
    text: str,
    code: str,
    current_name: str,
) -> tuple[str | None, str | None]:
    if not material_code_matches(text, code):
        return None, None

    lines = clean_result_lines(text)
    normalized: list[str] = []
    pattern = material_code_pattern(code)
    for line in lines:
        if line == code:
            continue
        if material_code_matches(line, code):
            line = re.sub(pattern, "", line, count=1).strip(" -|/·:：")
            if not line:
                continue
        if re.fullmatch(r"[\d,]+(?:원|개|EA)?", line, re.I):
            continue
        normalized.append(line)

    if not normalized:
        return None, None

    name = next(
        (line for line in normalized if current_name and line == current_name),
        normalized[0],
    )
    rest = [line for line in normalized if line != name]
    specification = " / ".join(rest[:4]).strip() if rest else ""
    return name, specification


def update_one_catalog_item(
    item: dict,
    name: str | None,
    specification: str | None,
) -> bool:
    changed = False

    if name and item.get("material_name") != name:
        print(
            "상품명 수정:",
            item.get("material_code"),
            repr(item.get("material_name")),
            "->",
            repr(name),
            flush=True,
        )
        item["material_name"] = name
        changed = True

    if specification is not None:
        specification = specification.strip()
        if specification and item.get("specification", "") != specification:
            print(
                "규격 수정:",
                item.get("material_code"),
                "->",
                specification,
                flush=True,
            )
            item["specification"] = specification
            changed = True

    return changed


def sync_catalog_and_images(
    driver,
    catalog: dict,
    image_dir: Path,
    no_images: bool,
) -> tuple[int, int, int, int]:
    materials = [
        item
        for item in catalog.get("materials", [])
        if isinstance(item, dict) and str(item.get("material_code", "")).strip()
    ]

    metadata_updated = 0
    images_migrated = 0
    images_saved = 0
    skipped = 0
    print("검색 대상 부자재:", len(materials), "건", flush=True)

    for index, item in enumerate(materials, 1):
        code = str(item.get("material_code", "")).strip()
        previous_name = str(item.get("material_name", "")).strip()
        print(f"HOMS 검색 {index}/{len(materials)}:", code, previous_name, flush=True)

        try:
            image, src, text = search_one(driver, code)
            if not src and not text:
                skipped += 1
                print("검색 결과 없음 - 1초 확인 후 다음 자재로 이동:", code, flush=True)
                continue

            confirmed_name, specification = parse_result_metadata(
                text,
                code,
                previous_name,
            )

            if confirmed_name is None:
                print("이름/규격 자동 해석 보류 - 기존 정보 유지:", code, flush=True)
            elif update_one_catalog_item(item, confirmed_name, specification):
                metadata_updated += 1

            if no_images:
                continue

            before = existing_code_image(image_dir, code)
            if before is None:
                migrated = migrate_confirmed_name_image(
                    image_dir,
                    code,
                    confirmed_name,
                    previous_name,
                )
                if migrated is not None:
                    images_migrated += 1

            if existing_code_image(image_dir, code) is None:
                if image is None:
                    print("이미지 없음 - 건너뜀:", code, flush=True)
                else:
                    png = image.screenshot_as_png
                    if png:
                        target = image_dir / f"{code}.png"
                        target.write_bytes(png)
                        images_saved += 1
                        print("이미지 저장:", target.name, flush=True)
                    else:
                        print("이미지 캡처 실패 - 건너뜀:", code, flush=True)

        except Exception as error:
            skipped += 1
            print(
                "처리 실패 - 기존 정보 유지:",
                code,
                type(error).__name__,
                str(error),
                flush=True,
            )

        time.sleep(0.35)

    return metadata_updated, images_migrated, images_saved, skipped


def commit_if_changed(
    repo: Path,
    add_path: str,
    message: str,
    branch: str,
) -> bool:
    run_git(repo, "add", "-A", "--", add_path)
    changed = run_git(repo, "diff", "--cached", "--name-only", capture=True)
    if not changed:
        print("Git 변경 없음:", repo.name, flush=True)
        return False

    run_git(repo, "commit", "-m", message)
    run_git(repo, "push", "origin", branch)
    print("Git push 완료:", repo.name, branch, flush=True)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description="HOMS 검색 기반 기준정보/부자재 이미지 일괄 동기화"
    )
    parser.add_argument(
        "--data-repo",
        type=Path,
        default=DEFAULT_DATA_ROOT,
        help="HOMSelf-data 로컬 저장소 경로",
    )
    parser.add_argument(
        "--no-images",
        action="store_true",
        help="이미지 저장/이름변경은 건너뛰고 이름/규격만 갱신",
    )
    parser.add_argument(
        "--no-push",
        action="store_true",
        help="파일만 수정하고 git commit/push는 하지 않음",
    )
    args = parser.parse_args()

    data_root = ensure_data_repo(args.data_repo.resolve())
    catalog_path = data_root / "config" / "catalog.json"

    selectors_path = ROOT / "selectors.json"
    if not selectors_path.exists():
        selectors_path = ROOT / "selectors.auto.example.json"

    if not selectors_path.exists():
        raise RuntimeError("worker/selectors.json을 찾을 수 없습니다.")
    if not catalog_path.exists():
        raise RuntimeError("HOMSelf-data/config/catalog.json을 찾을 수 없습니다.")

    require_clean_repo(HOMSELF_ROOT, ("public/static/img/material_list/",))
    require_clean_repo(data_root, ("config/catalog.json",))

    if not args.no_push:
        run_git(HOMSELF_ROOT, "pull", "--ff-only", "origin", "master")
        run_git(data_root, "pull", "--ff-only", "origin", "main")

    selectors = load_json(selectors_path)
    catalog = load_json(catalog_path)

    print(
        "주의: 일반 Worker를 종료한 상태에서 실행해야 Chrome 프로필 충돌이 없습니다.",
        flush=True,
    )
    driver = open_browser(selectors, ROOT / "runtime" / "chrome_profile")
    try:
        wait_for_homs_search(driver)
        updated, migrated, saved, skipped = sync_catalog_and_images(
            driver,
            catalog,
            IMAGE_DIR,
            args.no_images,
        )
        save_json(catalog_path, catalog)
        print(
            "HOMS 검색 동기화 완료: 기준정보 수정",
            updated,
            "건 / 기존 이미지 코드화",
            migrated,
            "건 / HOMS 이미지 저장",
            saved,
            "건 / 검색 실패",
            skipped,
            "건",
            flush=True,
        )
    finally:
        driver.quit()

    if args.no_push:
        print("--no-push 지정: Git commit/push 생략", flush=True)
        return

    commit_if_changed(
        data_root,
        "config/catalog.json",
        "Sync HOMSelf material names and specifications from HOMS search",
        "main",
    )
    commit_if_changed(
        HOMSELF_ROOT,
        "public/static/img/material_list",
        "Sync HOMSelf material images by material code",
        "master",
    )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("사용자 중단", flush=True)
        sys.exit(130)
    except Exception as error:
        print("실패:", type(error).__name__, str(error), flush=True)
        sys.exit(1)
