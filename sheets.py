"""구글 시트 API v4 래퍼 — 탭 보장·컬럼 읽기·채팅ID 기준 upsert."""
import logging

log = logging.getLogger(__name__)


def _col_letter(index: int) -> str:
    """0-인덱스 → A1 표기 열문자 (0→A, 15→P)."""
    s, n = "", index + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


class Sheet:
    """단일 스프레드시트 래퍼. 자격증명은 google_credentials.build_credentials()."""

    def __init__(self, credentials, spreadsheet_id):
        self._creds = credentials
        self._id = spreadsheet_id
        self._svc = None

    @property
    def _api(self):
        if self._svc is None:
            from googleapiclient.discovery import build
            self._svc = build("sheets", "v4", credentials=self._creds,
                              cache_discovery=False)
        return self._svc.spreadsheets()

    def ensure_tab(self, title, header):
        """탭 존재 보장 + 1행 헤더 보장.

        없으면 항상 새 탭 추가. (단일 탭 자동 rename 안 함 — 다른 데이터를
        덮어쓰는 사고가 있어 폐기. CSV 임포트로 생긴 기본 탭은 사용자가
        수동 정리 또는 그대로 둔다.)
        """
        meta = self._api.get(spreadsheetId=self._id,
                             fields="sheets.properties").execute()
        sheets = meta.get("sheets", [])
        titles = [s["properties"]["title"] for s in sheets]
        if title not in titles:
            self._api.batchUpdate(spreadsheetId=self._id, body={
                "requests": [{"addSheet": {"properties": {"title": title}}}],
            }).execute()
            log.info("탭 '%s' 생성", title)
        # 헤더 보장
        got = self._api.values().get(
            spreadsheetId=self._id, range=f"'{title}'!1:1").execute()
        if (got.get("values") or [[]])[0] != header:
            self._api.values().update(
                spreadsheetId=self._id, range=f"'{title}'!A1",
                valueInputOption="USER_ENTERED",
                body={"values": [header]}).execute()
            log.info("헤더 기록")

    def _read_column(self, title, col_index):
        """한 컬럼 전체값(헤더 포함) 리스트."""
        letter = _col_letter(col_index)
        resp = self._api.values().get(
            spreadsheetId=self._id,
            range=f"'{title}'!{letter}:{letter}").execute()
        return [(r[0] if r else "") for r in resp.get("values", [])]

    def upsert(self, title, header, rows, key_col_index):
        """rows를 key_col_index 컬럼값 기준 upsert. (갱신수, 신규수) 반환.

        기존 시트의 key 컬럼을 읽어 행번호를 매핑 → 있으면 해당 행 update,
        없으면 모아서 append.
        """
        existing = self._read_column(title, key_col_index)
        key_to_row = {}
        for i, k in enumerate(existing):
            if i == 0 or not k:      # 0=헤더
                continue
            key_to_row[k] = i + 1    # 1-인덱스 시트 행번호

        last_col = _col_letter(len(header) - 1)
        updates, appends = [], []
        for row in rows:
            key = row[key_col_index]
            rn = key_to_row.get(key)
            if rn:
                updates.append({
                    "range": f"'{title}'!A{rn}:{last_col}{rn}",
                    "values": [row]})
            else:
                appends.append(row)

        for i in range(0, len(updates), 200):
            self._api.values().batchUpdate(
                spreadsheetId=self._id,
                body={"valueInputOption": "USER_ENTERED",
                      "data": updates[i:i + 200]}).execute()
        if appends:
            self._api.values().append(
                spreadsheetId=self._id, range=f"'{title}'!A1",
                valueInputOption="USER_ENTERED",
                insertDataOption="INSERT_ROWS",
                body={"values": appends}).execute()
        return len(updates), len(appends)
