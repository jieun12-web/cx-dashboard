"""콜라비 관리자 자동화 — Playwright 로그인 + 두 페이지 HTML 테이블 추출.

콜라비 엑셀변환은 AES-256 DRM으로 암호화돼 파싱 불가 → 페이지에 그대로
표시되는 HTML <table>을 직접 읽는다. 페이지 SPA(라우팅 JS) 구조라 직접
URL `goto`는 빈 페이지가 반환됨 → 메뉴를 순서대로 클릭해 진입한다.
클릭은 화면 밖 위치를 잡는 경우가 있어 normal → force → JS dispatch
3단계 폴백.
"""
import logging

from playwright.sync_api import sync_playwright

log = logging.getLogger(__name__)


class Colabee:
    """콜라비 세션. with 구문으로 사용."""

    def __init__(self, base_url, username, password, headless=True):
        self.base = base_url.rstrip("/")
        self.user = username
        self.pw = password
        self.headless = headless
        self._pw = self._browser = self._ctx = self._page = None
        self._on_stat_page = False    # COUNSEL_STAT 1회 진입 후 재사용
        self._on_state_page = False   # AGENT_STATE_STAT 1회 진입 후 재사용

    def __enter__(self):
        self._pw = sync_playwright().start()
        self._browser = self._pw.chromium.launch(headless=self.headless)
        self._ctx = self._browser.new_context(
            ignore_https_errors=True,
            viewport={"width": 1920, "height": 1200},
        )
        self._page = self._ctx.new_page()
        self._login()
        return self

    def __exit__(self, *_):
        for closer in (
            lambda: self._browser.close(),
            lambda: self._pw.stop(),
        ):
            try:
                closer()
            except Exception:
                pass

    def _login(self):
        p = self._page
        p.goto(self.base + "/", wait_until="domcontentloaded", timeout=30000)
        p.locator('input[name="account_id"]').fill(self.user)
        p.locator('input[name="account_pw"]').fill(self.pw)
        # exosphere-loading/notice 모달이 가릴 수 있어 JS dispatch click
        p.evaluate("document.querySelector('input[type=\"submit\"]').click()")
        try:
            p.wait_for_load_state("networkidle", timeout=20000)
        except Exception:
            pass
        p.wait_for_timeout(2000)
        if "/cti/" not in p.url:
            raise RuntimeError(f"콜라비 로그인 실패 — URL={p.url}")
        log.info("콜라비 로그인 완료 → %s", p.url)

    def _click(self, label, settle_ms=1500):
        """라벨 텍스트의 <a> 또는 텍스트 노드 클릭. normal→force→JS 폴백."""
        p = self._page
        for sel in (f'a:text-is("{label}")', f'text="{label}"'):
            loc = p.locator(sel)
            if loc.count() == 0:
                continue
            try:
                loc.first.scroll_into_view_if_needed(timeout=2000)
            except Exception:
                pass
            for attempt in ("normal", "force", "js"):
                try:
                    if attempt == "normal":
                        loc.first.click(timeout=3000)
                    elif attempt == "force":
                        loc.first.click(force=True, timeout=3000)
                    else:
                        h = loc.first.element_handle(timeout=2000)
                        if h:
                            p.evaluate("(el) => el.click()", h)
                    p.wait_for_timeout(settle_ms)
                    return True
                except Exception:
                    continue
        raise RuntimeError(f"클릭 실패: {label}")

    def _extract_first_table(self):
        """현재 페이지의 첫 <table>을 [[cell, ...], ...] 로 반환."""
        rows = []
        for tr in self._page.locator("table tr").all():
            cells = []
            for c in tr.locator("th, td").all():
                cells.append((c.text_content() or "").strip())
            rows.append(cells)
        return rows

    def fetch_agent_daily(self):
        """CTI 통계 > 상담원별통계 > 일별 통계 표 (오늘 분).

        반환: [헤더행, 데이터행…, 소계·합계행]. 소계·합계는 호출측이 거른다.
        """
        self._click("CTI 통계")
        self._click("상담원별통계", settle_ms=2500)
        self._click("일별 통계", settle_ms=2500)
        return self._extract_first_table()

    def fetch_recv_daily(self):
        """IPPBX 통계 > 수신통계 > 일별 분류 표 (당월 전체).

        반환: [헤더행, '1 일'…'31 일' 행, 소계·합계].
        당월 데이터만 → 월말 누락 방지 위해 매일 수집.
        """
        self._click("IPPBX 통계")
        self._click("수신통계", settle_ms=2500)
        self._click("일별 분류", settle_ms=2500)
        return self._extract_first_table()

    def fetch_counsel_stat(self, date):
        """상담 관리 > 상담통계 (id=COUNSEL_STAT) — 단일 날짜 분류별 집계.

        date: 'YYYY-MM-DD'. dateFrom/dateTo 둘 다 같은 날로 설정 → #reload.

        반환: [헤더, 데이터…] — 헤더 = 가입자·대분류·중분류·소분류·
        수신건수·발신건수·합계·상담비율. 데이터 없는 날도 빈 표 반환.
        flatpickr 인스턴스가 있으면 API로, 없으면 input value 직접.
        """
        if not self._on_stat_page:
            self._page.evaluate(
                "document.getElementById('COUNSEL_STAT').click()")
            self._page.wait_for_timeout(3000)
            if "COUNSEL_STAT" not in self._page.url:
                raise RuntimeError(f"COUNSEL_STAT 진입 실패 — URL={self._page.url}")
            self._on_stat_page = True

        self._page.evaluate("""(d) => {
            for (const id of ['dateFrom', 'dateTo']) {
                const el = document.getElementById(id);
                if (!el) continue;
                if (el._flatpickr) {
                    el._flatpickr.setDate(d, true);
                } else {
                    el.value = d;
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        }""", date)
        self._page.wait_for_timeout(500)
        self._page.evaluate("document.getElementById('reload').click()")
        self._page.wait_for_timeout(3500)
        return self._extract_first_table()

    def fetch_agent_state_stat(self, date):
        """CTI 통계 > 상담원 상태 통계 (id=AGENT_STATE_STAT) — 단일 날짜.

        date: 'YYYY-MM-DD'. COUNSEL_STAT과 동일 UI 가정(dateFrom/dateTo + #reload).
        반환: [헤더, 데이터…] — 가입자명·상담원ID·상담원이름·상담시간·후처리·
        대기시간·다른업무·교육·회의·식사·휴식·자리비움·작업.
        """
        if not self._on_state_page:
            self._page.evaluate(
                "document.getElementById('AGENT_STATE_STAT').click()")
            self._page.wait_for_timeout(3000)
            if "AGENT_STATE_STAT" not in self._page.url:
                raise RuntimeError(
                    f"AGENT_STATE_STAT 진입 실패 — URL={self._page.url}")
            self._on_state_page = True

        self._page.evaluate("""(d) => {
            for (const id of ['dateFrom', 'dateTo']) {
                const el = document.getElementById(id);
                if (!el) continue;
                if (el._flatpickr) {
                    el._flatpickr.setDate(d, true);
                } else {
                    el.value = d;
                    el.dispatchEvent(new Event('change', {bubbles: true}));
                }
            }
        }""", date)
        self._page.wait_for_timeout(500)
        self._page.evaluate("document.getElementById('reload').click()")
        self._page.wait_for_timeout(3500)
        return self._extract_first_table()
