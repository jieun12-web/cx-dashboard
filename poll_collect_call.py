"""PC 폴링 스크립트 — 대시보드 콜 버튼 → 실제 콜 수집 연결.

흐름:
1) 대시보드 "📞 콜 신규 수집" 클릭 → GitHub `collect-call-request` 워크플로 dispatch.
2) PC 작업스케줄러가 이 스크립트를 1분마다 실행.
3) `collect-call-request` 최신 실행 시각이 마지막 처리분보다 새것이면
   collect_call.py 실행 → 끝나면 publish-dashboard 트리거.

PC만 회사 IP를 가졌기 때문에 GitHub Actions가 콜라비 API를 직접 못 친다.
이 스크립트는 그 다리 역할.
"""
import datetime
import json
import logging
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = "jieun12-web/cx-dashboard"
MARKER_WF = "collect-call-request.yml"
PUBLISH_WF = "publish-dashboard.yml"
STATE_FILE = Path(__file__).parent / "poll_state.json"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def _load_pat():
    """GitHub PAT — 환경변수 우선, 없으면 secrets_local.json."""
    pat = os.environ.get("CX_DASHBOARD_PAT")
    if pat:
        return pat
    f = Path(__file__).parent / "secrets_local.json"
    if f.exists():
        d = json.loads(f.read_text(encoding="utf-8"))
        return d.get("CX_DASHBOARD_PAT")
    return None


def _gh_get(url, pat=None):
    req = urllib.request.Request(url)
    if pat:
        req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Accept", "application/vnd.github+json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def _gh_post(url, body, pat):
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(body).encode())
    req.add_header("Authorization", f"Bearer {pat}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def latest_request_time(pat):
    """`collect-call-request` 최신 실행의 created_at(ISO) — 없으면 None."""
    url = (f"https://api.github.com/repos/{REPO}/actions/workflows/"
           f"{MARKER_WF}/runs?per_page=1")
    data = _gh_get(url, pat)
    runs = data.get("workflow_runs", [])
    if not runs:
        return None
    return runs[0]["created_at"]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    return {"last_processed": None, "bootstrap": False}


def save_state(state):
    STATE_FILE.write_text(
        json.dumps(state, ensure_ascii=False, indent=2),
        encoding="utf-8")


def run_collect_call():
    """collect_call.py 실행. 비PC 환경에서 실패하면 stderr 그대로 노출."""
    here = Path(__file__).parent
    py = sys.executable
    venv_py = here / ".venv" / "Scripts" / "python.exe"
    if venv_py.exists():
        py = str(venv_py)
    log.info("collect_call.py 실행 (%s)…", py)
    result = subprocess.run(
        [py, str(here / "collect_call.py")],
        capture_output=True, text=True, timeout=600)
    log.info("STDOUT:\n%s", result.stdout)
    if result.stderr:
        log.warning("STDERR:\n%s", result.stderr)
    return result.returncode == 0


def trigger_publish(pat):
    url = (f"https://api.github.com/repos/{REPO}/actions/workflows/"
           f"{PUBLISH_WF}/dispatches")
    status = _gh_post(url, {"ref": "main"}, pat)
    log.info("publish-dashboard 트리거 status=%s", status)


def main():
    pat = _load_pat()
    if not pat:
        log.error("CX_DASHBOARD_PAT 없음 — 환경변수 또는 secrets_local.json 필요. 종료.")
        sys.exit(1)

    try:
        latest = latest_request_time(pat)
    except urllib.error.URLError as e:
        log.error("GitHub API 호출 실패: %s", e)
        sys.exit(1)

    state = load_state()
    # 첫 실행: 현재 최신 요청을 '처리됨'으로 기록만 하고 종료(과거 요청 재실행 방지)
    if not state.get("bootstrap"):
        state["bootstrap"] = True
        state["last_processed"] = latest
        save_state(state)
        log.info("부트스트랩 — last_processed=%s 저장 후 종료", latest)
        return

    if latest is None:
        log.info("collect-call-request 실행 이력 없음 — 종료")
        return

    if latest == state.get("last_processed"):
        log.info("새 요청 없음 (last=%s)", latest)
        return

    log.info("새 콜 수집 요청 감지: %s → %s", state.get("last_processed"), latest)
    # 처리 시작 시점에 state 먼저 갱신해서 중복 실행 방지.
    state["last_processed"] = latest
    save_state(state)

    ok = run_collect_call()
    if ok:
        trigger_publish(pat)
    else:
        log.error("collect_call.py 실패 — publish 스킵")
        sys.exit(2)


if __name__ == "__main__":
    main()
