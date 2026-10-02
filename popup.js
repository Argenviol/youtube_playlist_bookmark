// popup.js — 확장 아이콘 팝업: 켜기/끄기 토글 + 구글 로그인 설정(⚙) 열기
// 상태는 chrome.storage.local 의 "ytpd:enabled" 에 저장(기본 켜짐).
// content.js 가 storage 변화를 듣고 실시간으로 켜고 끈다.
"use strict";

const toggle = document.getElementById("toggle");
const hint = document.getElementById("hint");

function paint(on) {
  toggle.checked = on;
  hint.textContent = on
    ? "켜져 있어요. 재생목록 페이지에서 동작합니다."
    : "꺼져 있어요. 페이지의 패널·북마크가 숨겨집니다.";
}

chrome.storage.local.get(["ytpd:enabled"], (res) => {
  paint(res["ytpd:enabled"] !== false); // 기본값: 켜짐
});

toggle.addEventListener("change", () => {
  const on = toggle.checked;
  chrome.storage.local.set({ "ytpd:enabled": on }, () => paint(on));
});

// ⚙ — 지금 보고 있는 유튜브 탭의 content.js 에 설정 모달을 열라고 알린다.
// 유튜브 탭이 아니면 받는 쪽이 없어 오류가 나므로 안내만 띄운다.
const setHint = document.getElementById("setHint");
document.getElementById("settings").addEventListener("click", () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const id = tabs && tabs[0] && tabs[0].id;
    const fail = () => {
      setHint.hidden = false;
      setHint.textContent = "유튜브 탭에서 눌러 주세요. 설정 창이 그 페이지에 열립니다.";
    };
    if (id == null) return fail();
    chrome.tabs.sendMessage(id, { type: "ytpd:openSettings" }, () => {
      if (chrome.runtime.lastError) return fail(); // 유튜브 탭이 아님 / 새로고침 전
      window.close();
    });
  });
});
