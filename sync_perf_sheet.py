"""창고 raw 탭 → 'CX 퍼포먼스(26.05~)' 시트의 Call Raw 두 탭에 전날치 적재.

매일 01시 KST (GitHub Actions cron). 본인 Google 계정 OAuth로 두 시트 모두 접근.
 - callraw_time → 'Call Raw(콜/상담시간)'  (일자·ID·이름·수신/직통/발신/호전달 건수·통화시간)
 - callraw_acw  → 'Call Raw(후처리)'       (기간·ID·이름·상담시간·후처리·대기·…·작업)

같은 (일자, 상담원ID) 행은 다시 안 쓴다(중복 방지). 헤더는 손대지 않는다.
"""
import datetime
import logging
import sys

import config
from google_credentials import build_credentials
from sheets import Sheet
from transform import KST

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)


def _read(sheet, tab):
    resp = sheet._api.values().get(
        spreadsheetId=sheet._id, range=f"'{tab}'!A:Z").execute()
    return resp.get("values", [])


def _existing_keys(perf, tab):
    """CX 탭의 기존 (col0|col1) 키 집합 — col0=일자/기간, col1=상담원ID."""
    try:
        rows = _read(perf, tab)
    except Exception as e:
        log.warning("'%s' 읽기 실패 — %s", tab, e)
        return None
    keys = set()
    for r in rows[1:]:           # 0행=헤더
        if len(r) >= 2 and r[0] and r[1]:
            keys.add(f"{r[0]}|{r[1]}")
    return keys


def _append(perf, tab, rows):
    perf._api.values().append(
        spreadsheetId=perf._id, range=f"'{tab}'!A1",
        valueInputOption="USER_ENTERED",
        insertDataOption="INSERT_ROWS",
        body={"values": rows}).execute()


def _sync(warehouse, perf, src_tab, dst_tab, date, slice_from):
    """warehouse src_tab에서 date행만 골라 dst_tab에 신규만 append.

    slice_from: 창고 행에서 CX 탭 컬럼이 시작하는 인덱스(=일자 컬럼). 2.
    창고 헤더: [키, 수집일시, 일자, 상담원ID, ...] → CX는 일자부터.
    """
    src = _read(warehouse, src_tab)
    if len(src) < 2:
        log.info("창고 '%s' 비어있음 — 건너뜀", src_tab)
        return
    out = []
    for r in src[1:]:
        if len(r) <= slice_from + 1:
            continue
        if (r[2] or "").strip() != date:   # 창고 col2 = 일자
            continue
        out.append([(c if c is not None else "") for c in r[slice_from:]])
    if not out:
        log.info("'%s' — %s 데이터 없음", src_tab, date)
        return
    existing = _existing_keys(perf, dst_tab)
    if existing is None:
        log.warning("'%s' 기존 키 조회 실패 — 안전을 위해 적재 생략", dst_tab)
        return
    fresh = [row for row in out if f"{row[0]}|{row[1]}" not in existing]
    if not fresh:
        log.info("'%s' — %s 이미 기록됨(중복 없음)", dst_tab, date)
        return
    _append(perf, dst_tab, fresh)
    log.info("'%s' ← %s: %d행 추가 (전체 %d행 중 신규)",
             dst_tab, src_tab, len(fresh), len(out))


def main():
    yesterday = (datetime.datetime.now(KST).date()
                 - datetime.timedelta(days=1)).isoformat()
    log.info("CX 퍼포먼스 시트 연동 — 대상일 %s", yesterday)
    creds = build_credentials()
    warehouse = Sheet(creds, config.SHEET_ID)
    perf = Sheet(creds, config.PERF_SHEET_ID)
    _sync(warehouse, perf, "callraw_time", config.PERF_TIME_TAB, yesterday, 2)
    _sync(warehouse, perf, "callraw_acw", config.PERF_ACW_TAB, yesterday, 2)
    log.info("연동 완료")


if __name__ == "__main__":
    main()
