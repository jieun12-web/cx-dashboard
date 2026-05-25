"""대시보드용 JSON 빌더 — 시트 3탭 → docs/data.json.

채팅(chat_raw):
 - 팀 일집계: 생성일 기준 (시스템 인입 시점).
 - VOC: 생성일 기준.
 - 상담사 귀속: **상담사태그(날짜+이름)의 날짜 기준** — 전일 채팅을 당일
   응대했어도 상담사 당일 실적으로 잡힘(채널톡 상담별 통계와 일치).
   per-chat 값을 평탄화 리스트로 출력 → 브라우저에서 중앙값 계산.

콜(call_team_daily): 일자별 팀 통계 그대로.
콜(call_daily): 일자×상담원 → 스쿼드별 일집계도 함께 산출.
"""
import datetime
import json
import logging
import re
import sys
from collections import defaultdict
from pathlib import Path

import config
from google_credentials import build_credentials
from sheets import Sheet
from transform import KST, squad_of

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger(__name__)

OUT = Path(__file__).parent / "docs" / "data.json"


def _read(sheet, tab):
    resp = sheet._api.values().get(
        spreadsheetId=config.SHEET_ID,
        range=f"'{tab}'!A:Z").execute()
    return resp.get("values", [])


def _col(header, name):
    return header.index(name) if name in header else -1


def _int(v):
    if v in (None, "", "-"):
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    s = str(v).strip().replace(",", "").rstrip("%")
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return 0


def _float(v):
    if v in (None, "", "-"):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace(",", "").rstrip("%")
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


# ── 상담사태그 파싱 ────────────────────────────────────────────
_TAG_FRONT = re.compile(r'^(\d{4})([가-힣]+)$')   # '0522지은'
_TAG_BACK = re.compile(r'^([가-힣]+)(\d{4})$')    # '소현0522'


def parse_agent_tag(tag, default_year):
    """날짜+이름 태그 → (전체이름, 'YYYY-MM-DD'). 모르는 이름·잘못된 형식은 None."""
    tag = (tag or "").strip()
    if not tag:
        return None
    m = _TAG_FRONT.match(tag)
    if m:
        mmdd, short = m.group(1), m.group(2)
    else:
        m = _TAG_BACK.match(tag)
        if not m:
            return None
        short, mmdd = m.group(1), m.group(2)
    full = config.TAG_NAME_MAP.get(short)
    if not full:
        return None
    mm, dd = mmdd[:2], mmdd[2:]
    try:
        date_str = f"{default_year}-{mm}-{dd}"
        datetime.date.fromisoformat(date_str)
        return full, date_str
    except ValueError:
        return None


# ── 채팅 집계 ──────────────────────────────────────────────────
def aggregate_chat(rows):
    """팀 일집계(생성일) + VOC(생성일) + 상담사 귀속(태그 날짜) 평탄화."""
    h = rows[0]
    ci_created = _col(h, "생성일")
    ci_reply_count = _col(h, "응답수")
    ci_fw = _col(h, "첫응대시간_초")
    ci_ar = _col(h, "평균응답시간_초")
    ci_res = _col(h, "처리시간_초")
    ci_voc = _col(h, "VOC태그")
    ci_agent_tag = _col(h, "상담사태그")

    def _team_zero():
        return {"인입": 0, "응대": 0,
                "첫응대_sum": 0, "첫응대_n": 0,
                "응답_sum": 0, "응답_n": 0,
                "처리_sum": 0, "처리_n": 0}

    by_date = defaultdict(_team_zero)
    voc_by_date = defaultdict(lambda: defaultdict(int))
    agent_chats = []   # (chat × agent 태그) 평탄화

    def _cell_int_or_none(r, i):
        if i < 0 or i >= len(r):
            return None
        v = r[i]
        if v in (None, "", "-"):
            return None
        return _int(v)

    for r in rows[1:]:
        if len(r) <= ci_created:
            continue
        created = (r[ci_created] or "").strip()
        if not created:
            continue
        reply_count = _int(r[ci_reply_count]) if 0 <= ci_reply_count < len(r) else 0
        fw = _cell_int_or_none(r, ci_fw)
        ar = _cell_int_or_none(r, ci_ar)
        res = _cell_int_or_none(r, ci_res)
        voc = (r[ci_voc] or "").strip() if 0 <= ci_voc < len(r) else ""
        agent_tag_str = (r[ci_agent_tag] or "").strip() if 0 <= ci_agent_tag < len(r) else ""

        # 팀 (생성일 기준)
        b = by_date[created]
        b["인입"] += 1
        if reply_count > 0:
            b["응대"] += 1
        if fw is not None:
            b["첫응대_sum"] += fw; b["첫응대_n"] += 1
        if ar is not None:
            b["응답_sum"] += ar; b["응답_n"] += 1
        if res is not None:
            b["처리_sum"] += res; b["처리_n"] += 1

        # VOC (생성일 기준)
        for tag in (voc.split(";") if voc else []):
            tag = tag.strip()
            if tag and "/" in tag:
                voc_by_date[created][tag] += 1

        # 상담사 귀속 (태그 날짜 기준 — 핵심)
        if agent_tag_str:
            year = created[:4]
            for tag in agent_tag_str.split(";"):
                parsed = parse_agent_tag(tag, year)
                if not parsed:
                    continue
                full, tag_date = parsed
                agent_chats.append({
                    "date": tag_date,
                    "agent": full,
                    "squad": squad_of(full),
                    "fw": fw, "ar": ar, "res": res,
                })

    return {
        "by_date": [{"date": d, **m} for d, m in sorted(by_date.items())],
        "voc_by_date": [{"date": d, "voc": v, "count": c}
                         for d, vd in sorted(voc_by_date.items())
                         for v, c in vd.items()],
        "agent_chats": agent_chats,
    }


# ── 콜 집계 ────────────────────────────────────────────────────
def aggregate_call_team(rows):
    h = rows[0]
    cols = {n: _col(h, n) for n in (
        "일자", "총인입", "연결시도", "연결성공", "연결포기", "연결실패",
        "성공률_퍼센트", "평균대기_초", "평균통화_초")}
    out = []
    for r in rows[1:]:
        if len(r) <= cols["일자"]:
            continue
        date = (r[cols["일자"]] or "").strip()
        if not date:
            continue
        rec = {"date": date}
        for k in ("총인입", "연결시도", "연결성공", "연결포기", "연결실패"):
            rec[k] = _int(r[cols[k]]) if 0 <= cols[k] < len(r) else 0
        for k in ("성공률_퍼센트", "평균대기_초", "평균통화_초"):
            rec[k] = _float(r[cols[k]]) if 0 <= cols[k] < len(r) else None
        out.append(rec)
    return sorted(out, key=lambda x: x["date"])


def aggregate_chat_voc(rows):
    """chat_raw → [{date, cat1, cat2, count}] — VOC태그 '/'로 대>중 파싱.

    한 채팅에 세미콜론 구분 다중 태그 가능. '대 / 중' 형식만 채택.
    """
    h = rows[0]
    ci_created = _col(h, "생성일")
    ci_voc = _col(h, "VOC태그")
    out = defaultdict(int)
    for r in rows[1:]:
        if len(r) <= ci_created:
            continue
        date = (r[ci_created] or "").strip()
        if not date:
            continue
        voc = (r[ci_voc] or "").strip() if 0 <= ci_voc < len(r) else ""
        for tag in voc.split(";"):
            tag = tag.strip()
            if not tag or "/" not in tag:
                continue
            parts = [p.strip() for p in tag.split("/", 1)]
            if len(parts) < 2 or not parts[0] or not parts[1]:
                continue
            out[(date, parts[0], parts[1])] += 1
    return [{"date": d, "cat1": c1, "cat2": c2, "count": cnt}
            for (d, c1, c2), cnt in sorted(out.items())]


def aggregate_call_voc(rows):
    """call_voc_daily → [{date, cat1, cat2, count}] — 소분류는 합산.

    합계 컬럼(수신+발신) 사용 — 콜 응대 발생 기준 VOC.
    """
    h = rows[0]
    ci_date = _col(h, "일자")
    ci_c1 = _col(h, "대분류")
    ci_c2 = _col(h, "중분류")
    ci_total = _col(h, "합계")
    out = defaultdict(int)
    for r in rows[1:]:
        if len(r) <= ci_date:
            continue
        date = (r[ci_date] or "").strip()
        if not date:
            continue
        c1 = (r[ci_c1] or "").strip() if 0 <= ci_c1 < len(r) else ""
        c2 = (r[ci_c2] or "").strip() if 0 <= ci_c2 < len(r) else ""
        if not c1 or not c2 or c2 == "-":
            continue
        total = _int(r[ci_total]) if 0 <= ci_total < len(r) else 0
        if total <= 0:
            continue
        out[(date, c1, c2)] += total
    return [{"date": d, "cat1": c1, "cat2": c2, "count": cnt}
            for (d, c1, c2), cnt in sorted(out.items())]


_WEEK_RANGE = re.compile(r"^(\d{4}-\d{2}-\d{2})~(\d{4}-\d{2}-\d{2})$")

# '2026년 민원데이터' 시트의 두 분류 블록 — 카테고리 셋으로 블록 종류 판별
_COMPLAINT_CATS_TYPE = {
    "상담관련", "반품·교환", "배송·설치", "이벤트·프로모션", "계약·약정",
    "장비·기술", "프로그램·기능", "제신고·가맹", "정산·수수료", "CMS·환불",
    "전산누락",
}
_COMPLAINT_CATS_REWARD = {
    "반품·교환유연화", "제신고비용면제", "배송·퀵", "이벤트예외제공",
    "금전적보상", "하드웨어보상", "CMS조정·감면", "위약금조정", "용지제공",
    "현장지원", "보상없음", "유프무상", "유프무상(중고)", "유프CMS감면",
}


def aggregate_complaint(sheet):
    """소스 시트 '2026년 민원데이터' 직접 읽기 → 주차별 카테고리 카운트.

    피벗 구조: 컬럼 J~M(인덱스 9~12)에 주차 헤더(예 '2026-05-15~2026-05-21')
    가 행 단위로 반복. 각 헤더 행 아래 N개 카테고리 행(I열=카테고리명,
    J~M=4주 카운트). '주차별 총건수'로 블록 종료.

    반환: [{주차_시작, 주차_종료, 분류종류('type'|'reward'), 카테고리, 카운트}]
    """
    resp = sheet._api.values().get(
        spreadsheetId=config.COMPLAINT_SHEET_ID,
        range=f"'{config.COMPLAINT_TAB}'!A1:AZ500").execute()
    rows = resp.get("values", [])
    out = []
    i = 0
    while i < len(rows):
        r = rows[i]
        # 컬럼 10~13(K~N)에 주차 라벨 4개가 있는 행을 헤더로 식별
        if len(r) >= 14 and all(_WEEK_RANGE.match(str(r[j] or "").strip()) for j in (10, 11, 12, 13)):
            weeks = [(_WEEK_RANGE.match(str(r[j]).strip()).group(1),
                      _WEEK_RANGE.match(str(r[j]).strip()).group(2))
                     for j in (10, 11, 12, 13)]
            i += 1
            # 이 헤더 아래 블록 읽기 — 카테고리행이 연속, '주차별 총건수' 만나면 종료
            block_kind = None
            while i < len(rows):
                rr = rows[i]
                cat = (rr[9] if len(rr) > 9 else "").strip()
                if not cat:
                    i += 1
                    if cat == "" and (not rr or len(rr) <= 10):
                        break  # 공백행
                    continue
                if cat == "주차별 총건수":
                    i += 1
                    break
                # 블록 종류 판별
                if block_kind is None:
                    if cat in _COMPLAINT_CATS_TYPE:
                        block_kind = "type"
                    elif cat in _COMPLAINT_CATS_REWARD:
                        block_kind = "reward"
                    else:
                        # 알 수 없는 카테고리 — 새 헤더 행일 가능성
                        break
                for k, (ws, we) in enumerate(weeks):
                    cnt = _int(rr[10 + k]) if len(rr) > 10 + k else 0
                    if cnt > 0:
                        out.append({
                            "week_start": ws, "week_end": we,
                            "kind": block_kind, "category": cat, "count": cnt,
                        })
                i += 1
        else:
            i += 1
    return out


def aggregate_call_agent(rows):
    h = rows[0]
    cols = {n: _col(h, n) for n in (
        "일자", "상담원ID", "상담원", "스쿼드", "수신연결",
        "수신_평균통화_초", "수신_총통화_초", "발신시도", "발신연결")}
    by_agent = []
    by_squad = defaultdict(lambda: defaultdict(lambda: {
        "수신연결": 0, "총통화_sum": 0, "발신시도": 0, "발신연결": 0}))

    for r in rows[1:]:
        if len(r) <= cols["일자"]:
            continue
        date = (r[cols["일자"]] or "").strip()
        if not date:
            continue
        agent = (r[cols["상담원"]] or "").strip() if 0 <= cols["상담원"] < len(r) else ""
        squad = (r[cols["스쿼드"]] or "기타").strip() if 0 <= cols["스쿼드"] < len(r) else "기타"
        cnt = _int(r[cols["수신연결"]]) if 0 <= cols["수신연결"] < len(r) else 0
        avg_s = _int(r[cols["수신_평균통화_초"]]) if 0 <= cols["수신_평균통화_초"] < len(r) and r[cols["수신_평균통화_초"]] else 0
        tot_s = _int(r[cols["수신_총통화_초"]]) if 0 <= cols["수신_총통화_초"] < len(r) and r[cols["수신_총통화_초"]] else 0
        out_try = _int(r[cols["발신시도"]]) if 0 <= cols["발신시도"] < len(r) else 0
        out_ans = _int(r[cols["발신연결"]]) if 0 <= cols["발신연결"] < len(r) else 0

        by_agent.append({
            "date": date, "agent": agent, "squad": squad,
            "수신연결": cnt, "평균통화_초": avg_s, "총통화_초": tot_s,
            "발신시도": out_try, "발신연결": out_ans,
        })

        s = by_squad[date][squad]
        s["수신연결"] += cnt
        s["총통화_sum"] += tot_s
        s["발신시도"] += out_try
        s["발신연결"] += out_ans

    by_squad_out = []
    for date, sd in sorted(by_squad.items()):
        for squad, m in sd.items():
            avg = round(m["총통화_sum"] / m["수신연결"]) if m["수신연결"] > 0 else None
            by_squad_out.append({
                "date": date, "squad": squad,
                "수신연결": m["수신연결"],
                "총통화_초": m["총통화_sum"],
                "평균통화_초": avg,
                "발신시도": m["발신시도"], "발신연결": m["발신연결"],
            })

    return by_agent, by_squad_out


def main():
    log.info("대시보드 JSON 빌드 시작")
    sheet = Sheet(build_credentials(), config.SHEET_ID)

    chat_rows = _read(sheet, "chat_raw")
    log.info("chat_raw %d행", max(0, len(chat_rows) - 1))
    chat_agg = aggregate_chat(chat_rows) if len(chat_rows) > 1 else {
        "by_date": [], "voc_by_date": [], "agent_chats": []}
    log.info("  agent_chats(태그 귀속) %d행", len(chat_agg["agent_chats"]))

    call_team_rows = _read(sheet, "call_team_daily")
    log.info("call_team_daily %d행", max(0, len(call_team_rows) - 1))
    call_team = (aggregate_call_team(call_team_rows)
                 if len(call_team_rows) > 1 else [])

    call_agent_rows = _read(sheet, "call_daily")
    log.info("call_daily %d행", max(0, len(call_agent_rows) - 1))
    if len(call_agent_rows) > 1:
        call_agent, call_squad = aggregate_call_agent(call_agent_rows)
    else:
        call_agent, call_squad = [], []

    # VOC — 채팅(VOC태그 '/' 파싱) + 콜(call_voc_daily 대>중 집계)
    chat_voc = aggregate_chat_voc(chat_rows) if len(chat_rows) > 1 else []
    try:
        call_voc_rows = _read(sheet, "call_voc_daily")
        log.info("call_voc_daily %d행", max(0, len(call_voc_rows) - 1))
        call_voc = aggregate_call_voc(call_voc_rows) if len(call_voc_rows) > 1 else []
    except Exception as e:
        log.warning("call_voc_daily 읽기 실패(아직 미수집 가능) — %s", e)
        call_voc = []

    # 민원 — 별도 소스 시트 직접 읽기 (cx-민원공유(슬랙) > 2026년 민원데이터)
    try:
        complaint = aggregate_complaint(sheet)
        log.info("complaint %d행 (주차별 카테고리 카운트)", len(complaint))
    except Exception as e:
        log.warning("민원 시트 읽기 실패 — %s", e)
        complaint = []

    # 상담사 명단 (config.SQUADS 기반 + agent_chats·call에 등장한 이름 합집합)
    all_agents = set()
    for squad_agents in config.SQUADS.values():
        all_agents.update(squad_agents)
    for r in chat_agg["agent_chats"]:
        if r["agent"]:
            all_agents.add(r["agent"])
    for r in call_agent:
        if r["agent"]:
            all_agents.add(r["agent"])

    data = {
        "generated_at": datetime.datetime.now(KST).isoformat(),
        "squads": list(config.SQUADS.keys()) + ["기타"],
        "agents": sorted(all_agents),
        "chat": chat_agg,
        "call": {
            "team_by_date": call_team,
            "agent_by_date": call_agent,
            "squad_by_date": call_squad,
        },
        "voc": {
            "chat": chat_voc,   # 채팅 VOC 태그 (대>중)
            "call": call_voc,   # 콜라비 COUNSEL_STAT (대>중, 소분류 합산)
        },
        "complaint": complaint,   # 주차별 카테고리 카운트 (kind=type|reward)
    }
    log.info("voc: chat %d행 / call %d행 / complaint %d행",
             len(chat_voc), len(call_voc), len(complaint))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    log.info("기록 → %s (%d bytes)", OUT, OUT.stat().st_size)


if __name__ == "__main__":
    main()
