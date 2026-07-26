// js/badge-info.js
// Модалка "что означает галочка" — открывается кнопкой "?" на экране
// профиля и по тапу на памятку в админ-панели.

import { BADGES, getBadge } from "./badges.js";

const modal = document.getElementById("badge-info-modal");
const closeBtn = document.getElementById("badge-info-close");
const dotEl = document.getElementById("badge-info-dot");
const titleEl = document.getElementById("badge-info-title");
const descEl = document.getElementById("badge-info-desc");
const eligibilityEl = document.getElementById("badge-info-eligibility");

closeBtn.addEventListener("click", () => modal.classList.add("hidden"));
modal.addEventListener("click", (e) => {
  if (e.target === modal) modal.classList.add("hidden");
});

export function openBadgeInfo(key) {
  const badge = getBadge(key);
  if (!badge) return;

  dotEl.src = `icons/badges/icon-badge-${badge.key}.svg`;
  titleEl.textContent = badge.label;
  descEl.textContent = badge.description;
  eligibilityEl.textContent = badge.eligibility;
  modal.classList.remove("hidden");
}

/* === Памятка по галочкам в админ-панели (сворачиваемый список) === */
const legendToggle = document.getElementById("badge-legend-toggle");
const legendList = document.getElementById("badge-legend-list");

function renderLegend() {
  legendList.innerHTML = BADGES.map(
    (b) => `
      <li class="badge-legend-item" data-key="${b.key}">
        <img class="badge-legend-icon" src="icons/badges/icon-badge-${b.key}.svg" alt="" width="26" height="26" />
        <span class="badge-legend-text">
          <span class="badge-legend-label">${b.label}</span>
          <span class="badge-legend-desc">${b.description}</span>
        </span>
        <span class="svg-icon svg-question badge-legend-question" style="width:16px;height:16px;"></span>
      </li>`
  ).join("");

  legendList.querySelectorAll(".badge-legend-item").forEach((el) => {
    el.addEventListener("click", () => openBadgeInfo(el.dataset.key));
  });
}

legendToggle?.addEventListener("click", () => {
  const isOpen = !legendList.classList.contains("hidden");
  legendList.classList.toggle("hidden", isOpen);
  legendToggle.classList.toggle("open", !isOpen);
  if (!isOpen && !legendList.dataset.rendered) {
    renderLegend();
    legendList.dataset.rendered = "1";
  }
});
