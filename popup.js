// popup.js — 확장 아이콘 팝업: 켜기/끄기 토글
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
