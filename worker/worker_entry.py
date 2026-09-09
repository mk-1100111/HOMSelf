"""Worker entrypoint with safe Chrome profile recovery.

The normal persistent Worker Chrome profile is tried first. If ChromeDriver
reports a session-creation/profile-start failure, retry once with a fresh
Worker-only temporary profile so an old/locked profile cannot block startup.
"""
import shutil
import sys
import tempfile
from pathlib import Path

import homs_adapter
import worker


_ORIGINAL_ADAPTER = homs_adapter.HomsAdapter


def _error_text(error):
    parts = []
    seen = set()
    current = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parts.append(f'{type(current).__name__}: {current}')
        current = current.__cause__ or current.__context__
    return ' / '.join(parts)


def _recoverable_chrome_start_error(error):
    text = _error_text(error).lower()
    return any(marker in text for marker in (
        'session not created',
        'chrome instance exited',
        'user data directory is already in use',
        'devtoolsactiveport',
        'cannot create default profile directory',
        'failed to create a chrome process',
    ))


class RecoveringHomsAdapter(_ORIGINAL_ADAPTER):
    def __init__(self, profile, admin_url=None, profile_dir=None):
        self._recovery_profile_dir = None
        try:
            super().__init__(profile, admin_url=admin_url, profile_dir=profile_dir)
            return
        except Exception as first_error:
            if not _recoverable_chrome_start_error(first_error):
                raise

            base_dir = Path(profile_dir).resolve().parent if profile_dir else Path.cwd() / 'runtime'
            base_dir.mkdir(parents=True, exist_ok=True)
            recovery_dir = Path(tempfile.mkdtemp(prefix='chrome_profile_recovery_', dir=str(base_dir)))
            self._recovery_profile_dir = recovery_dir

            print('Chrome 기본 Worker 프로필 시작 실패:', type(first_error).__name__, flush=True)
            print('프로필 충돌 가능성 감지. 새 임시 Worker 프로필로 자동 재시도합니다.', flush=True)
            print('임시 Chrome 프로필:', recovery_dir, flush=True)
            print('새 창에서는 HOMS 로그인을 다시 진행해 주세요.', flush=True)

            try:
                super().__init__(profile, admin_url=admin_url, profile_dir=recovery_dir)
            except Exception as second_error:
                shutil.rmtree(recovery_dir, ignore_errors=True)
                self._recovery_profile_dir = None
                raise RuntimeError(
                    'Chrome 자동 복구 재시도도 실패했습니다. '
                    '기본 오류: ' + _error_text(first_error) +
                    ' / 재시도 오류: ' + _error_text(second_error)
                ) from second_error

    def close(self):
        recovery_dir = self._recovery_profile_dir
        try:
            super().close()
        finally:
            if recovery_dir:
                shutil.rmtree(recovery_dir, ignore_errors=True)


def main():
    # worker.main() imports HomsAdapter at runtime, so replacing the module
    # attribute here keeps all worker business logic unchanged.
    homs_adapter.HomsAdapter = RecoveringHomsAdapter
    try:
        worker.main()
    except (Exception, KeyboardInterrupt) as error:
        print('중단:', str(error) if not isinstance(error, KeyboardInterrupt) else '사용자 중단', flush=True)
        print('처리 중인 항목은 관리자 화면과 HOMS 내역을 대조하세요. journal.sqlite를 삭제하지 마세요.')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
