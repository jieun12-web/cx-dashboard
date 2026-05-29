"""콜라비 표 → call_daily / call_team_daily 행 변환. 순수 함수."""
import datetime
import re

from transform import KST, squad_of  # 채팅과 공통 (스쿼드 매핑·KST)

# ── chat_raw처럼 헤더 = 시트 컬럼 순서 ─────────────────────────────
CALL_DAILY_HEADER = [
    "키", "수집일시", "일자", "상담원ID", "상담원", "스쿼드",
    "수신연결", "수신_평균통화_초", "수신_총통화_초",
    "발신시도", "발신연결",
]

CALL_TEAM_DAILY_HEADER = [
    "키", "수집일시", "일자",
    "총인입", "상담원수", "단순조회", "외부연결", "점심시간", "업무외시간",
    "연결시도", "연결성공", "연결포기", "연결실패",
    "성공률_퍼센트", "실패율_퍼센트", "평균대기_초", "평균통화_초",
    "총통화_초", "호전달",
]

# COUNSEL_STAT 표 (일자 컬럼 없음 — 외부에서 주입)
CALL_VOC_DAILY_HEADER = [
    "키", "수집일시", "일자",
    "가입자", "대분류", "중분류", "소분류",
    "수신건수", "발신건수", "합계", "상담비율_퍼센트",
]

# CX 퍼포먼스 시트 'Call Raw(콜/상담시간)' 탭과 동일 컬럼을 원본(HMS) 그대로 저장.
# 출처: CTI 통계 > 상담원별통계 > 일별 통계 (fetch_agent_daily 표 16열 verbatim).
CALLRAW_TIME_HEADER = [
    "키", "수집일시", "일자", "상담원ID", "상담원이름",
    "수신연결", "수신_평균통화", "수신_총통화",
    "직통연결", "직통_평균통화", "직통_총통화",
    "발신시도", "발신연결", "발신_평균통화", "발신_총통화",
    "호전달받음", "호전달_평균통화", "호전달_총통화",
]

# CX 퍼포먼스 시트 'Call Raw(후처리)' 탭과 동일.
# 출처: CTI 통계 > 상담원 상태 통계 (AGENT_STATE_STAT).
CALLRAW_ACW_HEADER = [
    "키", "수집일시", "일자", "상담원ID", "상담원이름",
    "상담시간", "후처리", "대기시간", "다른업무",
    "교육", "회의", "식사", "휴식", "자리비움", "작업",
]

_AGENT_ID = re.compile(r"^\d{2,}$")   # 상담원ID = 사번(숫자)

# ── 파서 ──────────────────────────────────────────────────────────
_HMS = re.compile(r"^(\d+):(\d{2}):(\d{2})$")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_DAY = re.compile(r"^(\d+)\s*일$")


def parse_hms_to_seconds(s):
    """'00:01:48' → 108. 빈값·'0'·미일치는 ''."""
    s = (s or "").strip()
    if not s or s == "0":
        return ""
    m = _HMS.match(s)
    if not m:
        return ""
    h, mi, sec = (int(x) for x in m.groups())
    return h * 3600 + mi * 60 + sec


def parse_int(s):
    s = (s or "").strip().replace(",", "")
    if not s:
        return 0
    try:
        return int(s)
    except ValueError:
        return 0


def parse_float(s):
    """'94.3' / '94.3%' / '94.3 ' → 94.3. 실패 시 ''."""
    s = (s or "").strip().rstrip("%").strip()
    if not s:
        return ""
    try:
        return float(s)
    except ValueError:
        return ""


# ── 행 변환 ───────────────────────────────────────────────────────
def agent_row(table_row, now=None):
    """상담원별 일별 표의 한 행 → call_daily 행. 소계/합계·헤더는 None.

    헤더: 일자·상담원ID·상담원이름·수신연결·평균통화시간·총통화시간·
    직통연결(3)·발신시도·발신연결·직통연결시간(3)·호전달받음(3)
    """
    if not table_row or len(table_row) < 11:
        return None
    first = (table_row[0] or "").strip()
    if not _DATE.match(first):
        return None
    now = now or datetime.datetime.now(KST)
    date, agent_id, name = first, table_row[1], table_row[2]
    return [
        f"{date}_{agent_id}",                          # 키
        now.strftime("%Y-%m-%d %H:%M:%S"),
        date, agent_id, name, squad_of(name),
        parse_int(table_row[3]),                       # 수신연결
        parse_hms_to_seconds(table_row[4]),            # 평균통화
        parse_hms_to_seconds(table_row[5]),            # 총통화
        parse_int(table_row[9]) if len(table_row) > 9 else 0,    # 발신시도
        parse_int(table_row[10]) if len(table_row) > 10 else 0,  # 발신연결
    ]


def callraw_time_row(table_row, now=None):
    """상담원별 일별 표(16열)를 원본 그대로 → callraw_time 행 (HMS·건수 verbatim).

    헤더/소계/합계는 None. 첫 칸이 'YYYY-MM-DD'인 데이터 행만 채택.
    """
    if not table_row or len(table_row) < 16:
        return None
    first = (table_row[0] or "").strip()
    if not _DATE.match(first):
        return None
    now = now or datetime.datetime.now(KST)
    agent_id = (table_row[1] or "").strip()
    vals = [(c or "").strip() for c in table_row[:16]]   # 일자~호전달총통화
    return [f"{first}_{agent_id}", now.strftime("%Y-%m-%d %H:%M:%S")] + vals


def agent_state_row(table_row, date, now=None):
    """상담원 상태 통계(AGENT_STATE_STAT) 한 행 → callraw_acw 행.

    스크랩 열: 가입자명·상담원ID·상담원이름·상담시간·후처리·대기시간·
              다른업무·교육·회의·식사·휴식·자리비움·작업 (13열).
    date: 'YYYY-MM-DD' (표에 일자 컬럼이 없어 외부 주입). 헤더/합계는 None.
    """
    if not table_row or len(table_row) < 13:
        return None
    agent_id = (table_row[1] or "").strip()
    if not _AGENT_ID.match(agent_id):     # 헤더('상담원 ID')·합계·소계 거름
        return None
    now = now or datetime.datetime.now(KST)
    vals = [(c or "").strip() for c in table_row[1:13]]  # 상담원ID~작업 (12)
    return [f"{date}_{agent_id}", now.strftime("%Y-%m-%d %H:%M:%S"), date] + vals


def call_voc_row(table_row, date, now=None):
    """COUNSEL_STAT 표 한 행 → call_voc_daily 행. 헤더/소계/합계는 None.

    date: 'YYYY-MM-DD' — 표에 일자 컬럼이 없어 외부 주입.
    헤더: 가입자·대분류·중분류·소분류·수신건수·발신건수·합계·상담비율(%)
    """
    if not table_row or len(table_row) < 8:
        return None
    # 데이터 행만 — 첫 컬럼이 '아이샵케어' (가입자) 같은 텍스트, 합계/소계는 다름
    tenant = (table_row[0] or "").strip()
    cat1 = (table_row[1] or "").strip()
    cat2 = (table_row[2] or "").strip()
    cat3 = (table_row[3] or "").strip()
    # 헤더 행 거름
    if tenant == "가입자" or cat1 == "대분류":
        return None
    # 합계/소계 행 거름 — 분류가 비어있거나 '합계/소계' 명시
    if not cat1 or cat1 in ("합계", "소계", "Total"):
        return None
    now = now or datetime.datetime.now(KST)
    recv = parse_int(table_row[4])
    sent = parse_int(table_row[5])
    total = parse_int(table_row[6])
    ratio = parse_float(table_row[7])
    cat3_key = cat3 if cat3 and cat3 != "-" else ""
    return [
        f"{date}|{cat1}|{cat2}|{cat3_key}",            # 키
        now.strftime("%Y-%m-%d %H:%M:%S"),
        date, tenant, cat1, cat2, cat3,
        recv, sent, total, ratio,
    ]


def team_row(table_row, year_month, now=None):
    """수신통계 일별 표의 한 행 → call_team_daily 행. 소계/합계·헤더는 None.

    year_month: 'YYYY-MM' — 표가 일(day-of-month)만 줘서 외부에서 주입.
    헤더: 분류·총인입·상담원수·단순조회·외부연결·점심시간·업무외시간·
    연결시도·연결성공·연결포기·연결실패·성공률·실패율·평균대기·
    평균통화시간·총통화시간·호전달  (총 17)
    """
    if not table_row or len(table_row) < 17:
        return None
    m = _DAY.match((table_row[0] or "").strip())
    if not m:
        return None
    day = int(m.group(1))
    date = f"{year_month}-{day:02d}"
    now = now or datetime.datetime.now(KST)
    c = table_row
    return [
        date,                                          # 키 = 일자
        now.strftime("%Y-%m-%d %H:%M:%S"),
        date,
        parse_int(c[1]),                               # 총인입
        parse_int(c[2]),                               # 상담원수
        parse_int(c[3]),                               # 단순조회
        parse_int(c[4]),                               # 외부연결
        parse_int(c[5]),                               # 점심시간
        parse_int(c[6]),                               # 업무외시간
        parse_int(c[7]),                               # 연결시도
        parse_int(c[8]),                               # 연결성공
        parse_int(c[9]),                               # 연결포기
        parse_int(c[10]),                              # 연결실패
        parse_float(c[11]),                            # 성공률 %
        parse_float(c[12]),                            # 실패율 %
        parse_float(c[13]),                            # 평균대기 (초, float)
        parse_hms_to_seconds(c[14]),                   # 평균통화 (초)
        parse_hms_to_seconds(c[15]),                   # 총통화 (초)
        parse_int(c[16]),                              # 호전달
    ]
