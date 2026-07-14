/* NARA / Rihla embeddable widget loader.
 *
 * Drop-in usage on any third-party site:
 *
 *   <script
 *     src="https://YOUR-DOMAIN/embed.js"
 *     data-brand="jeep-ma"
 *     data-position="bottom-right"
 *     defer></script>
 *
 * The script reads its own data-* attributes, injects an iframe pointing at
 * /embed/<brand>, and listens for postMessage("rihla-resize") events from
 * inside the widget to grow / shrink the iframe between the small FAB
 * footprint and the full chat panel.
 *
 * Zero deps. ~3 kB. Safe to load on any page.
 */
(function () {
  "use strict";

  if (window.__rihlaEmbedInjected) return;
  window.__rihlaEmbedInjected = true;

  // ─── Resolve config from the <script> tag that loaded this file ───────────
  var script = document.currentScript;
  if (!script) {
    // Fallback when loaded async without currentScript — pick the last <script>
    // tag whose src ends with /embed.js.
    var all = document.getElementsByTagName("script");
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\/embed\.js(\?|$)/.test(all[i].src)) { script = all[i]; break; }
    }
  }
  if (!script) {
    console.warn("[rihla-embed] could not locate loader <script> tag");
    return;
  }

  var brand = script.getAttribute("data-brand") || "jeep-ma";
  var position = script.getAttribute("data-position") || "bottom-right";

  // Origin = the site hosting embed.js (where the iframe content lives).
  var srcUrl = new URL(script.src);
  var origin = srcUrl.origin;
  var iframeSrc = origin + "/embed/" + encodeURIComponent(brand);

  // ─── Build the floating iframe ────────────────────────────────────────────
  var iframe = document.createElement("iframe");
  iframe.src = iframeSrc;
  iframe.title = "Chat assistant";
  iframe.allow = "microphone; autoplay; clipboard-read; clipboard-write";
  iframe.setAttribute("aria-label", "Open chat assistant");
  iframe.style.cssText = [
    "position: fixed",
    "z-index: 2147483646", // just below the absolute max so dropdowns can sit higher
    "border: 0",
    "background: transparent",
    "color-scheme: normal",
    // Sized for the closed FAB + "Votre assistante virtuelle" pill by default;
    // resized via postMessage below. Generous so the FAB's pulse rings and
    // shadow aren't clipped by the iframe boundary.
    "width: 340px",
    "height: 140px",
    "transition: width 220ms cubic-bezier(0.22,0.68,0,1), height 220ms cubic-bezier(0.22,0.68,0,1)",
  ].join(";");

  // Position anchoring. The iframe is offset from the viewport edges so the
  // widget visually breathes — the panel inside fills the iframe edge-to-edge
  // (no internal padding), so this gap is the entire visual margin.
  var EDGE_GAP = 20; // px — used for both axes on the chosen corner
  switch (position) {
    case "bottom-left":
      iframe.style.bottom = EDGE_GAP + "px";
      iframe.style.left = EDGE_GAP + "px";
      break;
    case "top-right":
      iframe.style.top = EDGE_GAP + "px";
      iframe.style.right = EDGE_GAP + "px";
      break;
    case "top-left":
      iframe.style.top = EDGE_GAP + "px";
      iframe.style.left = EDGE_GAP + "px";
      break;
    case "bottom-right":
    default:
      iframe.style.bottom = EDGE_GAP + "px";
      iframe.style.right = EDGE_GAP + "px";
  }

  // ─── Resize handshake — listen for the widget's open/close events ─────────
  // Sizes are mobile-friendly: clamped to the viewport on small screens so the
  // open chat panel fits on a phone too. Open size is generous to fit the
  // panel's drop shadow.
  var SIZES = {
    // Closed = FAB + the persistent "Votre assistante virtuelle" pill to its
    // side (plus pulse rings / shadow). Wide enough for the longest locale.
    closed: { w: 340, h: 140 },
    open: {
      w: Math.min(420, window.innerWidth - EDGE_GAP * 2),
      h: Math.min(720, window.innerHeight - EDGE_GAP * 2),
    },
  };

  function applySize(state) {
    var s = SIZES[state] || SIZES.closed;
    iframe.style.width = s.w + "px";
    iframe.style.height = s.h + "px";
  }

  window.addEventListener("message", function (ev) {
    // Only trust messages coming from our own iframe origin.
    if (ev.origin !== origin) return;
    var data = ev.data;
    if (!data || data.type !== "rihla-resize") return;
    applySize(data.state === "open" ? "open" : "closed");
  });

  // Recompute the open-size on resize so a rotation / window-change doesn't
  // leave the iframe overflowing the viewport.
  window.addEventListener("resize", function () {
    SIZES.open = {
      w: Math.min(420, window.innerWidth - EDGE_GAP * 2),
      h: Math.min(720, window.innerHeight - EDGE_GAP * 2),
    };
  });

  // ─── Mount ────────────────────────────────────────────────────────────────
  function mount() {
    if (!document.body) return setTimeout(mount, 50);
    document.body.appendChild(iframe);
  }
  mount();
})();
