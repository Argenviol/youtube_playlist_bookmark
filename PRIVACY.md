# 개인정보처리방침 (Privacy Policy)

**유튜브 재생목록 북마크 (YouTube Playlist Bookmark)** 크롬 확장 프로그램

최종 수정일: 2026-09-19

## 요약

이 확장 프로그램은 **개인정보를 수집하지 않습니다.** 서버가 없고, 개발자를 포함한
누구에게도 데이터를 보내지 않습니다. 모든 데이터는 사용자 본인의 브라우저 안에만
저장됩니다.

## 저장하는 정보와 위치

아래 정보는 전부 크롬의 로컬 저장소(`chrome.storage.local`)에만 저장되며, 사용자의
컴퓨터를 벗어나지 않습니다.

| 저장 항목 | 내용 | 용도 |
|---|---|---|
| 북마크 | 재생목록 ID, 북마크 이름, 기준 영상 ID | 북마크를 다시 불러오기 위해 |
| 재생목록 이름 | 북마크를 만든 재생목록의 제목 | 목록에서 이름으로 보여 주기 위해 |
| 화면 설정 | 패널 위치, 접힘 상태, 확장 켜기/끄기 | 다음에도 같은 상태로 열기 위해 |
| OAuth 클라이언트 ID·시크릿 | 사용자가 직접 입력한 값 | 구글 로그인 요청에 사용 |
| 액세스·갱신 토큰 | 구글이 발급한 로그인 토큰 | 로그인 상태 유지 |

브라우저 동기화(`chrome.storage.sync`)는 사용하지 않습니다. 확장을 삭제하면 위
데이터는 크롬이 함께 삭제합니다.

## 외부로 나가는 통신

확장이 네트워크 요청을 보내는 곳은 구글뿐이며, 그것도 사용자가 `↦북마크`(영상을
북마크 밑으로 이동) 기능을 직접 실행했을 때만입니다.

- `accounts.google.com`, `oauth2.googleapis.com` — 구글 로그인과 토큰 갱신
- `www.googleapis.com` (YouTube Data API v3) — 사용자 본인 재생목록의 항목 조회와
  순서 변경

구글에 전달되는 정보는 재생목록 ID, 영상 ID, 바꿀 위치값뿐입니다. 이 통신은 사용자
본인의 구글 계정 권한으로 이뤄지며, 구글의 개인정보처리방침이 적용됩니다.

분석 도구, 광고, 추적, 제3자 서버는 일절 사용하지 않습니다.

## 요청하는 권한

- `storage` — 위 표의 데이터를 로컬에 저장
- `identity` — 구글 로그인 창을 띄우기 위해
- `https://www.googleapis.com/auth/youtube` — 사용자 본인 재생목록의 순서 변경.
  영상 시청 기록, 구독 정보, 다른 계정 데이터는 읽지 않습니다.

## 권한 철회

[구글 계정 권한 관리](https://myaccount.google.com/permissions) 에서 이 앱의 접근
권한을 언제든 철회할 수 있습니다. 확장의 ⚙ 설정에서 로그아웃하면 저장된 토큰도
삭제됩니다.

## 소스 코드

이 확장은 오픈 소스이며, 위 내용은 코드에서 그대로 확인할 수 있습니다.

## 문의

https://github.com/Argenviol/youtube_playlist_bookmark/issues

---

# Privacy Policy (English)

**YouTube Playlist Bookmark** browser extension. Last updated: 2026-09-19.

This extension **collects no personal data**. It has no server and sends nothing to
the developer or any third party.

Bookmarks (playlist id, label, anchor video id), cached playlist titles, UI
preferences, the user-supplied OAuth client id and secret, and Google access and
refresh tokens are stored only in the browser's local extension storage
(`chrome.storage.local`). Browser sync storage is not used. Uninstalling the
extension removes this data.

The only network requests go to Google, and only when the user explicitly moves a
video: `accounts.google.com` and `oauth2.googleapis.com` for sign-in and token
refresh, and `www.googleapis.com` (YouTube Data API v3) to read and reorder items
in the user's own playlist. Only playlist ids, video ids and target positions are
sent. There is no analytics, advertising, tracking or third-party service.

Permissions requested: `storage`, `identity`, and the
`https://www.googleapis.com/auth/youtube` scope, used solely to reorder the signed-in
user's own playlists. Access can be revoked at any time at
https://myaccount.google.com/permissions.

Contact: https://github.com/Argenviol/youtube_playlist_bookmark/issues
