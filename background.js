// ============================================================================
// background.js — 서비스 워커
//
// content script는 chrome.identity나 googleapis 호출을 직접 할 수 없으므로,
// 로그인/토큰 관리와 "영상을 북마크 밑으로 옮기기"에 필요한 YouTube Data API v3
// 호출을 이 백그라운드에서 담당한다. content.js는 chrome.runtime.sendMessage 로
// 작업을 요청하고 결과를 받는다.
//
// 이 확장의 다른 기능(북마크 생성·점프·검색·이름변경·삭제·재배치)은 전부 로컬
// 저장만 쓰고 여기(로그인)와 무관하다. "영상 이동"만 실제 재생목록 순서를 바꾸는
// 쓰기 작업이라 구글 정책상 OAuth 로그인이 필수다(API 키만으로는 안 됨).
//
// 사용하는 quota (대략):
//   - playlistItems.update : 50유닛 / 호출 (영상 이동 = 순서 변경)
//   - 하루 기본 할당량 10,000유닛 ≒ 하루 약 200회
// ============================================================================

"use strict";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";

// ---------------------------------------------------------------------------
// 인증: 액세스 토큰 획득 (Edge/Chrome 공용 — launchWebAuthFlow)
//
// chrome.identity.getAuthToken 은 Chrome 전용이고, manifest 에 고정 client_id 를
// 요구해서(이 확장은 사용자별 client_id 라 안 맞음) Edge에서도 안 된다.
// 그래서 모든 브라우저에서 되는 launchWebAuthFlow 를 쓰는데, 두 가지 방식을
// 지원한다:
//
//   1) client_secret 을 안 넣은 경우(기본) — implicit flow (response_type=token).
//      토큰 교환 서버 호출이 아예 없어서 secret 이 절대 필요 없다. 대신 토큰이
//      1시간짜리이고 refresh_token 이 없어서, 만료되면 다시 발급받아야 한다
//      (대부분 조용히 됨, 가끔 로그인 창이 다시 뜰 수 있음).
//   2) client_secret 도 넣은 경우 — Authorization Code + PKCE (response_type=code).
//      refresh_token 을 같이 받아 저장해 두므로, 액세스 토큰이 만료돼도 팝업 없이
//      자동으로 갱신된다(PC를 꺼도 유지). 구글이 "웹 애플리케이션" 클라이언트의
//      토큰 교환에는 client_secret 을 요구해서 이 정보 없이는 이 경로를 쓸 수
//      없다 — PKCE 만으로는 면제되지 않는다(직접 겪은 오류: "client_secret is
//      missing"). secret 은 옵션이라, 입력 안 하면 1)로 계속 동작한다.
//
// ※ 이 방식은 OAuth 클라이언트 유형이 "웹 애플리케이션"이어야 하고,
//    승인된 리다이렉트 URI 에 chrome.identity.getRedirectURL() 값
//    (https://<확장ID>.chromiumapp.org/) 을 등록해 둬야 한다. (README 참고)
// ---------------------------------------------------------------------------

let tokenCache = null; // { token, expiresAt }

function storageGet(key) {
  return new Promise((r) => chrome.storage.local.get([key], (res) => r(res[key])));
}
function storageSet(key, value) {
  return new Promise((r) => chrome.storage.local.set({ [key]: value }, () => r()));
}
function storageRemove(key) {
  return new Promise((r) => chrome.storage.local.remove(key, () => r()));
}

const tokenIsFresh = (t) => !!(t && t.token && t.expiresAt - Date.now() > 60000);

// 요청 스코프: 재생목록 쓰기(영상 이동)만.
const SCOPES = "https://www.googleapis.com/auth/youtube";

/**
 * OAuth 클라이언트 ID(필수)·시크릿(선택)을 가져온다.
 * 값은 패널의 작은 설정 모달에서 사용자가 입력한 것만 쓴다.
 * → 배포 시 각 사용자가 본인 구글 클라우드 프로젝트를 쓴다(할당량도 각자).
 *
 * ※ manifest 의 oauth2 키는 쓰지 않는다. 그건 크롬 전용 getAuthToken 방식용이고,
 *   여기서는 엣지에서도 되는 launchWebAuthFlow 를 쓴다. (빈 값을 넣으면 확장 로드 실패)
 */
async function getOAuthConfig() {
  const clientId = ((await storageGet("ytpd:clientId")) || "").trim();
  if (!clientId) {
    throw new Error(
      "구글 API 설정이 없어요. 패널의 구글 로그인 옆 ⚙ 에서 OAuth 클라이언트 ID를 입력해 주세요."
    );
  }
  const clientSecret = ((await storageGet("ytpd:clientSecret")) || "").trim();
  return { clientId, clientSecret };
}

/** launchWebAuthFlow 래퍼 */
function launchWebAuthFlow(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirectUrl) => {
      if (chrome.runtime.lastError || !redirectUrl) {
        reject(new Error(chrome.runtime.lastError?.message || "로그인이 취소되었거나 실패했어요."));
        return;
      }
      resolve(redirectUrl);
    });
  });
}

/** 리다이렉트 URL 프래그먼트(#access_token=...)에서 토큰을 추출 (implicit flow) */
function parseRedirect(redirectUrl) {
  const get = (re) => {
    const m = redirectUrl.match(re);
    return m ? decodeURIComponent(m[1]) : null;
  };
  const token = get(/[#&]access_token=([^&]+)/);
  if (!token) {
    const err = get(/[#&]error=([^&]+)/);
    throw new Error("토큰을 받지 못했어요" + (err ? ` (${err})` : ""));
  }
  const expiresIn = parseInt(get(/[#&]expires_in=([^&]+)/) || "3600", 10);
  return { token, expiresAt: Date.now() + expiresIn * 1000 };
}

// ----- PKCE 헬퍼 (client_secret 을 넣은 경우에만 씀) -------------------------

function base64UrlEncode(buffer) {
  let str = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function generateCodeVerifier() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return base64UrlEncode(arr.buffer);
}
async function generateCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(digest);
}

/** 리다이렉트 URL 쿼리스트링(?code=...)에서 인증 코드를 추출 (code flow) */
function parseAuthCode(redirectUrl) {
  const url = new URL(redirectUrl);
  const code = url.searchParams.get("code");
  if (!code) {
    const err = url.searchParams.get("error");
    throw new Error("인증 코드를 받지 못했어요" + (err ? ` (${err})` : ""));
  }
  return code;
}

/** 토큰 엔드포인트 공용 POST 호출 */
async function postToken(params) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(json.error_description || json.error || "토큰 요청 실패");
  }
  return json;
}

/** 토큰 응답을 캐시(메모리·storage)에 반영. refresh_token 이 왔으면 같이 저장 */
async function storeTokenResponse(tok) {
  const parsed = {
    token: tok.access_token,
    expiresAt: Date.now() + (tok.expires_in || 3600) * 1000,
  };
  tokenCache = parsed;
  const writes = { oauthToken: parsed };
  if (tok.refresh_token) writes.oauthRefreshToken = tok.refresh_token;
  await new Promise((r) => chrome.storage.local.set(writes, r));
  return parsed.token;
}

/**
 * 액세스 토큰을 가져온다. 캐시(메모리·storage)가 유효하면 재사용하고,
 * 없거나 만료됐으면 새로 발급한다. client_secret 을 입력해 뒀으면 refresh_token
 * 방식(로그인 유지)을, 아니면 implicit flow(1시간, secret 불필요)를 쓴다.
 * @param {boolean} interactive  로그인 UI 허용 여부
 * @returns {Promise<string>} 액세스 토큰
 */
async function getToken(interactive) {
  if (tokenIsFresh(tokenCache)) return tokenCache.token;

  const stored = await storageGet("oauthToken");
  if (tokenIsFresh(stored)) {
    tokenCache = stored;
    return stored.token;
  }

  const { clientId, clientSecret } = await getOAuthConfig();
  const redirectUri = chrome.identity.getRedirectURL();

  if (clientSecret) {
    // ----- refresh_token 방식 (client_secret 필요, PC 재부팅해도 로그인 유지) -----
    const refreshToken = await storageGet("oauthRefreshToken");
    if (refreshToken) {
      try {
        const tok = await postToken({
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "refresh_token",
        });
        return await storeTokenResponse(tok);
      } catch (_) {
        // refresh_token 이 만료/취소됐으면 지우고 아래 로그인 절차로 넘어간다.
        await storageRemove("oauthRefreshToken");
      }
    }

    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    const authBase =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" + encodeURIComponent(clientId) +
      "&response_type=code" +
      "&redirect_uri=" + encodeURIComponent(redirectUri) +
      "&scope=" + encodeURIComponent(SCOPES) +
      "&access_type=offline" +
      "&code_challenge=" + encodeURIComponent(challenge) +
      "&code_challenge_method=S256";

    const exchangeCode = (code) =>
      postToken({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      });

    try {
      const redirectUrl = await launchWebAuthFlow(authBase + "&prompt=none", false);
      const code = parseAuthCode(redirectUrl);
      const tok = await exchangeCode(code);
      return await storeTokenResponse(tok);
    } catch (_) {
      if (!interactive) throw new Error("로그인이 필요해요");
    }

    // prompt=consent 로 매번 refresh_token 을 다시 받아, 다음부터 이 창이 안 뜨게 한다.
    const redirectUrl = await launchWebAuthFlow(authBase + "&prompt=consent", true);
    const code = parseAuthCode(redirectUrl);
    const tok = await exchangeCode(code);
    return await storeTokenResponse(tok);
  }

  // ----- implicit flow (secret 불필요, 기본값) ---------------------------------
  const baseUrl =
    "https://accounts.google.com/o/oauth2/v2/auth" +
    "?client_id=" + encodeURIComponent(clientId) +
    "&response_type=token" +
    "&redirect_uri=" + encodeURIComponent(redirectUri) +
    "&scope=" + encodeURIComponent(SCOPES);

  // 1) 먼저 "조용히" 시도한다. 구글에 이미 로그인돼 있고 동의도 마쳤으면
  //    팝업 없이 새 토큰을 받아온다 → 만료돼도 로그인 창이 안 뜬다.
  //    (prompt=none 은 상호작용이 필요하면 즉시 실패한다)
  try {
    const silentUrl = baseUrl + "&prompt=none";
    const redirectUrl = await launchWebAuthFlow(silentUrl, false);
    const parsed = parseRedirect(redirectUrl);
    tokenCache = parsed;
    await storageSet("oauthToken", parsed);
    return parsed.token;
  } catch (_) {
    // 조용한 갱신 실패(로그인 안 돼 있음/첫 동의 필요/계정 선택 필요)
    if (!interactive) throw new Error("로그인이 필요해요");
  }

  // 2) 조용히 안 되면 그때만 로그인 창을 띄운다 (첫 로그인 등)
  const redirectUrl = await launchWebAuthFlow(baseUrl, true);
  const parsed = parseRedirect(redirectUrl);
  tokenCache = parsed;
  await storageSet("oauthToken", parsed);
  return parsed.token;
}

/** 캐시된 토큰 제거 (만료/401 대응). refresh_token 은 남겨서 조용히 재발급 가능하게 유지 */
async function clearToken() {
  tokenCache = null;
  await storageRemove("oauthToken");
}

/**
 * googleapis 호출 헬퍼.
 * Authorization 헤더를 붙이고, 401이면 토큰을 갱신해 1회 재시도한다.
 * 403(quota/권한)은 사용자에게 보여줄 메시지로 변환해 throw 한다.
 *
 * @param {string} url
 * @param {object} options  fetch 옵션
 * @param {boolean} interactive  로그인 UI 허용 여부
 * @returns {Promise<any>} JSON 파싱 결과 (204면 null)
 */
async function apiFetch(url, options = {}, interactive = false) {
  let token = await getToken(interactive);

  const doFetch = async (tok) => {
    const headers = Object.assign({}, options.headers, {
      Authorization: "Bearer " + tok,
    });
    if (options.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(url, Object.assign({}, options, { headers }));
  };

  let res = await doFetch(token);

  // 401: 토큰 만료 가능성 → 캐시 제거 후 1회 재시도
  if (res.status === 401) {
    await clearToken();
    token = await getToken(interactive);
    res = await doFetch(token);
  }

  if (res.status === 403) {
    let reason = "";
    try {
      const body = await res.json();
      reason = body?.error?.errors?.[0]?.reason || body?.error?.message || "";
    } catch (_) {}
    if (/accessNotConfigured|SERVICE_DISABLED|has not been used/i.test(reason)) {
      throw new Error("YouTube Data API v3 가 사용 설정 안 됐어요. 구글 클라우드 콘솔에서 켜주세요(1~2분 뒤 반영).");
    }
    if (/quota|rateLimitExceeded|userRateLimitExceeded/i.test(reason)) {
      throw new Error("오늘 할당량을 다 썼어요(내일 리셋).");
    }
    throw new Error("권한이 없어요. 내 소유 재생목록만 수정할 수 있어요." + (reason ? ` (${reason})` : ""));
  }

  if (!res.ok) {
    let msg = `요청 실패 (HTTP ${res.status})`;
    try {
      const body = await res.json();
      if (body?.error?.message) msg = body.error.message;
    } catch (_) {}
    throw new Error(msg);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// API 동작들
// ---------------------------------------------------------------------------

/** 로그인 (토큰을 미리 받아둠). 쓰기 동작 직전 자동 로그인에 쓰인다. */
async function signIn() {
  await getToken(true);
  return { ok: true };
}

/** 로그아웃 (토큰 폐기) */
async function signOut() {
  const refreshToken = await storageGet("oauthRefreshToken");
  await clearToken();
  await storageRemove("oauthRefreshToken");
  if (refreshToken) {
    try {
      await fetch(REVOKE_ENDPOINT + "?token=" + encodeURIComponent(refreshToken), { method: "POST" });
    } catch (_) {
      // 서버 폐기 실패해도 로컬 토큰은 이미 지웠으니 로그아웃은 된 것으로 취급
    }
  }
  return { ok: true };
}

/** 로그인 상태 확인 (캐시만 확인 — 로그인 창을 띄우지 않는다) */
async function getAuthStatus() {
  if (tokenIsFresh(tokenCache)) return { signedIn: true };
  const stored = await storageGet("oauthToken");
  if (tokenIsFresh(stored)) {
    tokenCache = stored;
    return { signedIn: true };
  }
  // 액세스 토큰이 만료됐어도 refresh_token 이 남아 있으면 "로그인됨"으로 본다 —
  // 실제 호출 때 getToken() 이 그걸로 조용히 새 토큰을 받아오기 때문이다.
  const refreshToken = await storageGet("oauthRefreshToken");
  return { signedIn: !!refreshToken };
}

/**
 * 특정 영상(videoId)에 해당하는 항목만 골라 가져온다. (1유닛, 1회 호출)
 * 전체 목록을 페이지네이션할 필요 없이 playlistItemId·position 을 바로 얻어 빠르다.
 * 같은 영상이 여러 번 들어있으면 여러 개가 올 수 있다.
 */
async function findItems({ playlistId, videoId }) {
  const url =
    `${API_BASE}/playlistItems?part=snippet,contentDetails&maxResults=50` +
    `&playlistId=${encodeURIComponent(playlistId)}` +
    `&videoId=${encodeURIComponent(videoId)}`;
  const data = await apiFetch(url, {}, false);
  const items = (data.items || []).map((it) => ({
    playlistItemId: it.id,
    videoId: it.contentDetails?.videoId || it.snippet?.resourceId?.videoId || null,
    position: it.snippet?.position,
  }));
  return { items };
}

/**
 * 재생목록에 "이미 있는" 항목을 다른 position 으로 옮긴다. (playlistItems.update, 50유닛)
 * videoId 가 아니라 항목의 playlistItemId(id) 가 필요하고, snippet 에 playlistId·
 * resourceId 를 모두 다시 넣어줘야 한다.
 */
async function moveItem({ playlistItemId, playlistId, videoId, position }) {
  const snippet = {
    playlistId,
    resourceId: { kind: "youtube#video", videoId },
  };
  if (typeof position === "number" && position >= 0) {
    snippet.position = position;
  }
  const url = `${API_BASE}/playlistItems?part=snippet`;
  const data = await apiFetch(
    url,
    { method: "PUT", body: JSON.stringify({ id: playlistItemId, snippet }) },
    false
  );
  return { ok: true, item: data };
}

// ---------------------------------------------------------------------------
// 메시지 라우팅
// ---------------------------------------------------------------------------

const HANDLERS = {
  signIn,
  signOut,
  getAuthStatus,
  getRedirectUri: async () => ({ uri: chrome.identity.getRedirectURL() }),
  findItems,
  moveItem,
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const action = msg?.action;

  const handler = HANDLERS[action];
  if (!handler) {
    sendResponse({ ok: false, error: "알 수 없는 작업: " + action });
    return false;
  }

  Promise.resolve(handler(msg))
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true; // 비동기 응답
});
