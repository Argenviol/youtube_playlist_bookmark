// settings-ui.js — 구글 로그인 설정 화면(공용)
// 확장 아이콘 팝업의 ⚙ → 설정 페이지(options.html, 아무 탭에서나 열림)와,
// 유튜브에서 "↦북마크"가 로그인에 실패했을 때 뜨는 모달이 같은 화면을 쓴다.
// content_scripts 로도, options.html 로도 불러오므로 전역 이름 세 개만 내놓는다:
//   ytpdBg(action, payload)       백그라운드(background.js)에 요청
//   ytpdToast(message)            아래쪽 알림 띄우기
//   ytpdBuildSettings(opts)       설정 화면 엘리먼트를 만들어 돌려준다
"use strict";

function ytpdBg(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(Object.assign({ action }, payload), (resp) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!resp) {
        reject(new Error("백그라운드 응답이 없어요"));
        return;
      }
      if (!resp.ok) {
        reject(new Error(resp.error || "오류가 발생했어요"));
        return;
      }
      resolve(resp.result);
    });
  });
}

let ytpdToastTimer = null;
function ytpdToast(message) {
  let el = document.getElementById("ytpd-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "ytpd-toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("ytpd-show");
  if (ytpdToastTimer) clearTimeout(ytpdToastTimer);
  ytpdToastTimer = setTimeout(() => el.classList.remove("ytpd-show"), 2600);
}

/**
 * 로그인/로그아웃 + 본인 구글 API 클라이언트 ID 설정 화면.
 * "↦북마크"(영상 이동)에만 필요하고, 다른 기능엔 필요 없다.
 * @param {{errorMessage?: string, onSignedIn?: (v:boolean)=>void, onClose?: ()=>void}} opts
 *   onClose 가 없으면(설정 페이지) 닫기 버튼을 두지 않는다.
 */
function ytpdBuildSettings(opts = {}) {
  let errorMessage = opts.errorMessage || "";
  let signedIn = false;
  const box = document.createElement("div");
  box.className = "ytpd-modal ytpd-modal-wide";
  box.innerHTML = `
      <div class="ytpd-modal-title">⚙ 구글 로그인 설정</div>
      <div class="ytpd-set-desc">
        "↦북마크"(영상을 북마크 밑으로 이동)에만 필요합니다. 북마크 추가·점프·검색 등
        다른 기능은 로그인 없이 그대로 됩니다.
      </div>

      <details class="ytpd-guide">
        <summary>📖 사용법 — 구글 로그인 준비 (처음 한 번만, 약 5분)</summary>
        <div class="ytpd-guide-body">
          <div class="ytpd-guide-why">
            유튜브 재생목록의 <b>순서를 바꾸는 것</b>은 구글이 로그인한 본인만 허용합니다.
            그래서 "내 구글 계정으로 이 확장을 쓰겠다"는 열쇠(OAuth 클라이언트 ID)를
            한 번 만들어야 합니다. 무료이고, 아래 순서대로 누르기만 하면 됩니다.
          </div>
          <ol class="ytpd-guide-steps">
            <li>
              <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">
                구글 클라우드 프로젝트 만들기 ↗</a>
              <div>이름은 아무거나 (예: <code>youtube-bookmark</code>) → <b>만들기</b>.
                이미 프로젝트가 있으면 건너뛰어도 됩니다.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/apis/library/youtube.googleapis.com" target="_blank" rel="noopener">
                YouTube Data API v3 켜기 ↗</a>
              <div>파란 <b>사용</b>(Enable) 버튼을 누릅니다. 위쪽에 1번에서 만든 프로젝트가
                선택돼 있는지 확인하세요.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">
                OAuth 동의 화면 만들기 ↗</a>
              <div>앱 이름·이메일만 채우고, 사용자 유형은 <b>외부</b>(External)로 저장합니다.</div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">
                내 구글 계정을 테스트 사용자로 추가 ↗</a>
              <div><b>테스트 사용자 → 추가</b> 에 본인 지메일 주소를 넣습니다.
                <b>이걸 빠뜨리면 로그인할 때 거부됩니다.</b></div>
            </li>
            <li>
              <a href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noopener">
                OAuth 클라이언트 ID 만들기 ↗</a>
              <div>유형은 반드시 <b>웹 애플리케이션</b>. 그리고
                <b>승인된 리디렉션 URI</b> 에 아래 "리디렉션 URI" 칸의 값을
                (<b>복사</b> 버튼) 그대로 붙여넣고 만들기를 누릅니다.</div>
            </li>
            <li>
              만들어지면 뜨는 <b>클라이언트 ID</b>
              (<code>...apps.googleusercontent.com</code>)를 복사해
              아래 칸에 붙여넣고 <b>저장</b> → <b>구글 로그인</b> 을 누르면 끝입니다.
              <div>나중에 다시 볼 때는
                <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">사용자 인증 정보 ↗</a>
                에서 확인합니다.</div>
            </li>
          </ol>
          <div class="ytpd-guide-note">
            로그인할 때 "확인되지 않은 앱" 경고가 나오면 <b>고급 → 이동</b> 을 누르세요.
            구글 심사를 받지 않은 본인 전용 앱이라 뜨는 정상 경고입니다.
            하루 사용량은 영상 이동 약 200회까지입니다.
          </div>
          <div class="ytpd-guide-note">
            <b>로그인을 계속 유지하려면</b> — 아래 "보안 비밀번호(secret)" 칸을 채우면
            갱신 토큰을 받아 PC를 껐다 켜도 로그인이 풀리지 않습니다. 다만 동의 화면이
            <b>테스트</b> 상태면 구글이 그 갱신 토큰을 <b>7일</b> 뒤 만료시켜서, 일주일에
            한 번쯤 로그인 창이 다시 뜹니다(그때도 자동으로 이어집니다).
            아예 안 뜨게 하려면
            <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">
              대상(게시 상태) ↗</a>
            에서 <b>앱 게시 → 프로덕션</b> 으로 바꾸세요. 심사 없이 게시해도 되고,
            "확인되지 않은 앱" 경고만 지금처럼 그대로 뜹니다.
          </div>
        </div>
      </details>
      <div class="ytpd-set-status" data-auth>확인 중…</div>
      <div class="ytpd-set-row">
        <button type="button" class="ytpd-set-btn" data-login>구글 로그인</button>
        <button type="button" class="ytpd-set-btn" data-logout>로그아웃</button>
      </div>
      <div class="ytpd-set-label">리디렉션 URI</div>
      <div class="ytpd-set-row">
        <input class="ytpd-modal-input" data-redirect readonly>
        <button type="button" class="ytpd-set-btn" data-copy>복사</button>
      </div>
      <div class="ytpd-set-label">OAuth 클라이언트 ID</div>
      <input class="ytpd-modal-input" data-clientid placeholder="000000-xxxx.apps.googleusercontent.com">
      <div class="ytpd-set-label">
        OAuth 클라이언트 보안 비밀번호(secret) — 선택. 넣으면 PC를 껐다 켜도
        로그인이 유지됩니다(refresh token). 비워두면 지금처럼 1시간마다 조용히
        갱신을 시도하고, 가끔 로그인 창이 다시 뜰 수 있어요.
        동의 화면이 "테스트" 상태면 넣어도 7일마다 한 번은 다시 떠요 —
        위 📖 사용법의 "로그인을 계속 유지하려면" 참고.
      </div>
      <input class="ytpd-modal-input" data-clientsecret type="password" placeholder="선택 — 비워두면 기존 방식 그대로">
      <div class="ytpd-set-row">
        <button type="button" class="ytpd-set-btn" data-savekey>저장</button>
      </div>
      <div class="ytpd-set-row ytpd-set-foot">
        <button type="button" class="ytpd-set-btn" data-close>닫기</button>
      </div>`;

  const $ = (sel) => box.querySelector(sel);
  const authEl = $("[data-auth]");
  const setSignedIn = (v) => {
    signedIn = v;
    if (opts.onSignedIn) opts.onSignedIn(v);
  };

  const paintAuth = () => {
    authEl.textContent = signedIn
      ? "✓ 로그인됨"
      : errorMessage
      ? "로그인 안 됨 — " + errorMessage
      : "로그인 안 됨";
    authEl.classList.toggle("ytpd-set-ok", signedIn);
  };

  ytpdBg("getAuthStatus")
    .then((res) => setSignedIn(!!res.signedIn))
    .catch(() => setSignedIn(false))
    .then(paintAuth);
  chrome.storage.local.get(["ytpd:clientId", "ytpd:clientSecret"], (res) => {
    $("[data-clientid]").value = res["ytpd:clientId"] || "";
    $("[data-clientsecret]").value = res["ytpd:clientSecret"] || "";
  });
  ytpdBg("getRedirectUri")
    .then((r) => ($("[data-redirect]").value = r.uri))
    .catch(() => ($("[data-redirect]").value = "(확인 실패)"));

  $("[data-login]").addEventListener("click", async () => {
    try {
      await ytpdBg("signIn");
      setSignedIn(true);
      errorMessage = "";
      paintAuth();
      ytpdToast("로그인했어요");
    } catch (e) {
      errorMessage = e.message;
      paintAuth();
      ytpdToast(e.message);
    }
  });

  $("[data-logout]").addEventListener("click", async () => {
    try {
      await ytpdBg("signOut");
      setSignedIn(false);
      paintAuth();
      ytpdToast("로그아웃했어요");
    } catch (e) {
      ytpdToast(e.message);
    }
  });

  $("[data-copy]").addEventListener("click", () => {
    const v = $("[data-redirect]").value;
    navigator.clipboard.writeText(v).then(
      () => ytpdToast("복사했어요"),
      () => ytpdToast("복사 실패 — 직접 선택해 복사해 주세요")
    );
  });

  $("[data-savekey]").addEventListener("click", async () => {
    const id = $("[data-clientid]").value.trim();
    const secret = $("[data-clientsecret]").value.trim();
    const prev = await new Promise((r) =>
      chrome.storage.local.get(["ytpd:clientId", "ytpd:clientSecret"], r)
    );
    const changed = prev["ytpd:clientId"] !== id || prev["ytpd:clientSecret"] !== secret;
    chrome.storage.local.set({ "ytpd:clientId": id, "ytpd:clientSecret": secret }, async () => {
      if (changed) {
        // 설정이 바뀌면 예전 방식으로 캐시된 토큰이 새 방식과 안 맞을 수 있어 정리한다.
        try {
          await ytpdBg("signOut");
        } catch (_) {}
        setSignedIn(false);
        paintAuth();
      }
      ytpdToast(id ? "저장했어요. 다시 로그인해 주세요" : "지웠어요");
    });
  });

  const closeBtn = $("[data-close]");
  if (opts.onClose) closeBtn.addEventListener("click", opts.onClose);
  else closeBtn.closest(".ytpd-set-foot").remove();

  return box;
}
