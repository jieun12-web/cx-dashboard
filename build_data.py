"""대시보드용 JSON 빌더 — 시트 3탭 → docs/data.json.

채팅(chat_raw): 채팅 1건 1행 → 일자/스쿼드/상담사/VOC별 일집계
콜(call_team_daily): 일자별 팀 통계 (이미 일집계)
콜(call_daily): 일자×상담원 → 스쿼드별 일집계도 함께 산출

평균 지표는 같은 기간을 합산할 수 있도록 (sum, n) 쌍으로 출력 →
브라우저에서 sum/n으로 평균 계산. 단순 합산 metric은 그대로.
"""
import datetime
import json
import logging
import sys
from collections import defaultdict
from pathlib import Path

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

OUT = Path(__file__).parent / "docs" / "data.json"


def _read(sheet, tab):
    """탭 전체 [[...]] 반환. 1행 헤더 + 데이터 행. 없으면 [[]]."""
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


# ── 채팅 집계 ──────────────────────────────────────────────────
def aggregate_chat(rows):
    """chat_raw 데이터행 → 일자/스쿼드/상담사/VOC별 일집계."""
    h = rows[0]
    ci_date = _col(h, "생성일")
    ci_state = _col(h, "상태")
    ci_assignee = _col(h, "담당자")
    ci_squad = _col(h, "스쿼드")
    ci_reply_count = _col(h, "응답수")
    ci_first_wait = _col(h, "첫응대시간_초")
    ci_avg_reply = _col(h, "평균응답시간_초")
    ci_resolution = _col(h, "처리시간_초")
    ci_voc = _col(h, "VOC태그")

    def _empty():
        return {"인입": 0, "응대": 0,
                "첫응대_sum": 0, "첫응대_n": 0,
                "응답_sum": 0, "응답_n": 0,
                "처리_sum": 0, "처리_n": 0}

    by_date = defaultdict(_empty)
    by_squad = defaultdict(lambda: defaultdict(_empty))   # [date][squad]
    by_agent = defaultdict(lambda: defaultdict(_empty))   # [date][agent]
    agent_squad = {}                                       # agent→squad
    voc_by_date = defaultdict(lambda: defaultdict(int))   # [date][voc]

    def _accumulate(target, reply_count, fw, ar, res):
        target["인입"] += 1
        if reply_count > 0:
            target["응대"] += 1
        if fw is not None:
            target["첫응대_sum"] += fw
            target["첫응대_n"] += 1
        if ar is not None:
            target["응답_sum"] += ar
            target["응답_n"] += 1
        if res is not None:
            target["처리_sum"] += res
            target["처리_n"] += 1

    for r in rows[1:]:
        if len(r) <= ci_date:
            continue
        date = (r[ci_date] or "").strip()
        if not date:
            continue
        agent = (r[ci_assignee] or "").strip() if ci_assignee >= 0 and len(r) > ci_assignee else ""
        squad = (r[ci_squad] or "기타").strip() if ci_squad >= 0 and len(r) > ci_squad else "기타"
        reply_count = _int(r[ci_reply_count]) if ci_reply_count >= 0 and len(r) > ci_reply_count else 0
        fw = _int(r[ci_first_wait]) if ci_first_wait >= 0 and len(r) > ci_first_wait and r[ci_first_wait] else None
        ar = _int(r[ci_avg_reply]) if ci_avg_reply >= 0 and len(r) > ci_avg_reply and r[ci_avg_reply] else None
        res = _int(r[ci_resolution]) if ci_resolution >= 0 and len(r) > ci_resolution and r[ci_resolution] else None
        voc = (r[ci_voc] or "").strip() if ci_voc >= 0 and len(r) > ci_voc else ""

        _accumulate(by_date[date], reply_count, fw, ar, res)
        _accumulate(by_squad[date][squad], reply_count, fw, ar, res)
        if agent:
            _accumulate(by_agent[date][agent], reply_count, fw, ar, res)
            agent_squad[agent] = squad
        # VOC = '/' 포함 태그만 (날짜이름 태그 제외)
        for tag in (voc.split(";") if voc else []):
            tag = tag.strip()
            if tag and "/" in tag:
                voc_by_date[date][tag] += 1

    return {
        "by_date": [{"date": d, **m} for d, m in sorted(by_date.items())],
        "by_squad_date": [
            {"date": d, "squad": s, **m}
            for d, sq in sorted(by_squad.items())
            for s, m in sq.items()
        ],
        "by_agent_date": [
            {"date": d, "agent": a, "squad": agent_squad.get(a, "기타"), **m}
            for d, ag in sorted(by_agent.items())
            for a, m in ag.items()
        ],
        "voc_by_date": [
            {"date": d, "voc": v, "count": c}
            for d, vd in sorted(voc_by_date.items())
            for v, c in vd.items()
        ],
    }


# ── 콜 집계 ────────────────────────────────────────────────────
def aggregate_call_team(rows):
    """call_team_daily → 일자별 팀 통계 그대로."""
    h = rows[0]
    cols = {name: _col(h, name) for name in (
        "일자", "총인입", "연결시도", "연결성공", "연결포기", "연결실패",
        "성공률_퍼센트", "평균대기_초", "평균통화_초",
    )}
    out = []
    for r in rows[1:]:
        if len(r) <= cols["일자"]:
            continue
        date = (r[cols["일자"]] or "").strip()
        if not date:
            continue
        rec = {"date": date}
        for k in ("총인입", "연결시도", "연결성공", "연결포기", "연결실패"):
            rec[k] = _int(r[cols[k]]) if cols[k] >= 0 and len(r) > cols[k] else 0
        for k in ("성공률_퍼센트", "평균대기_초", "평균통화_초"):
            rec[k] = _float(r[cols[k]]) if cols[k] >= 0 and len(r) > cols[k] else None
        out.append(rec)
    return sorted(out, key=lambda x: x["date"])


def aggregate_call_agent(rows):
    """call_daily → 상담사·스쿼드별 일집계."""
    h = rows[0]
    cols = {name: _col(h, name) for name in (
        "일자", "상담원ID", "상담원", "스쿼드", "수신연결",
        "수신_평균통화_초", "수신_총통화_초", "발신시도", "발신연결",
    )}

    by_agent = []
    by_squad = defaultdict(lambda: defaultdict(lambda: {
        "수신연결": 0, "총통화_sum": 0, "발신시도": 0, "발신연결": 0,
    }))

    for r in rows[1:]:
        if len(r) <= cols["일자"]:
            continue
        date = (r[cols["일자"]] or "").strip()
        if not date:
            continue
        agent = (r[cols["상담원"]] or "").strip() if cols["상담원"] >= 0 and len(r) > cols["상담원"] else ""
        squad = (r[cols["스쿼드"]] or "기타").strip() if cols["스쿼드"] >= 0 and len(r) > cols["스쿼드"] else "기타"
        cnt = _int(r[cols["수신연결"]]) if cols["수신연결"] >= 0 and len(r) > cols["수신연결"] else 0
        avg_s = _int(r[cols["수신_평균통화_초"]]) if cols["수신_평균통화_초"] >= 0 and len(r) > cols["수신_평균통화_초"] and r[cols["수신_평균통화_초"]] else 0
        tot_s = _int(r[cols["수신_총통화_초"]]) if cols["수신_총통화_초"] >= 0 and len(r) > cols["수신_총통화_초"] and r[cols["수신_총통화_초"]] else 0
        out_try = _int(r[cols["발신시도"]]) if cols["발신시도"] >= 0 and len(r) > cols["발신시도"] else 0
        out_ans = _int(r[cols["발신연결"]]) if cols["발신연결"] >= 0 and len(r) > cols["발신연결"] else 0

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
        "by_date": [], "by_squad_date": [], "by_agent_date": [],
        "voc_by_date": [],
    }

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

    data = {
        "generated_at": datetime.datetime.now(KST).isoformat(),
        "squads": list(config.SQUADS.keys()) + ["기타"],
        "chat": chat_agg,
        "call": {
            "team_by_date": call_team,
            "agent_by_date": call_agent,
            "squad_by_date": call_squad,
        },
        "voc_민원": {"available": False, "note": "엑셀 링크 수령 후 추가"},
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    log.info("기록 → %s (%d bytes)", OUT, OUT.stat().st_size)


if __name__ == "__main__":
    main()
