// The panel's favorites client, kept as a plain string: it must run in a
// static file:// page as well as under --serve, so it uses no bundler, no
// template literals and no external asset.
//
// Behaviour:
//   - star toggles a target; under --serve it POSTs, otherwise it writes to
//     localStorage and the page says so
//   - a tab switches between all rows and favorites; favorites that dropped
//     off the board (ended over a week ago) are listed in their own block
//   - the note/status editor lives in the expanded detail row
//   - filters, sort and tab are mirrored into location.hash (shareable) and
//     localStorage is only the fallback default
//   - exports: targets.json for the batch runner and favorites.jsonl for
//     offline analysis

export const FAVORITES_CLIENT = `
(function () {
  var SERVE = window.__SERVE__ === true;
  var panel = window.__PANEL__;
  if (!panel) return;

  var store = window.__FAVORITES__ || { favorites: {} };
  var favs = {};
  Object.keys(store.favorites || {}).forEach(function (key) { favs[key] = store.favorites[key]; });

  if (!SERVE) {
    try {
      var local = JSON.parse(localStorage.getItem("nftFavs") || "null");
      if (local && local.favorites) Object.keys(local.favorites).forEach(function (key) { favs[key] = local.favorites[key]; });
    } catch (e) {}
  }

  var tab = "all";
  var FILTERS = ["gradeFilter", "phaseFilter", "chainFilter", "qFilter", "freeOnly", "onlyPending", "onlyExecuted", "excludeInstant", "search"];
  function el(id) { return document.getElementById(id); }
  function keyOf(chain, contract) { return String(chain).toLowerCase() + "|" + String(contract).toLowerCase(); }

  function persistLocal() {
    if (SERVE) return;
    try { localStorage.setItem("nftFavs", JSON.stringify({ version: 1, favorites: favs })); } catch (e) {}
  }

  function save(record, action) {
    persistLocal();
    if (!SERVE) return;
    fetch("/api/favorites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: action,
        chain: record.chain,
        contract: record.contract,
        slug: record.slug,
        name: record.name,
        status: record.status,
        note: record.note,
        snapshot: record.snapshot,
      }),
    }).catch(function () { el("favNote").textContent = "保存失败（本地已记录，刷新后可能丢失）"; });
  }

  function isFav(chain, contract) { return Boolean(favs[keyOf(chain, contract)]); }

  function starHtml(row) {
    var on = isFav(row.dataset.chain, row.dataset.contract);
    return '<button type="button" class="star' + (on ? " on" : "") + '" data-fav="' + (on ? "1" : "0") +
      '" title="' + (on ? "取消收藏" : "收藏（记录当时的信号，供以后分析）") + '">' + (on ? "★" : "☆") + "</button>";
  }

  function decorateRows() {
    panel.rows.forEach(function (row) {
      var cell = row.querySelector("td.col-name");
      if (cell && !cell.querySelector(".star")) {
        cell.insertAdjacentHTML("afterbegin", starHtml(row));
      }
      row.dataset.favorite = isFav(row.dataset.chain, row.dataset.contract) ? "1" : "0";
      var detail = row.nextElementSibling;
      if (detail && detail.classList.contains("detail")) {
        var editor = detail.querySelector(".fav-editor");
        if (editor) editor.innerHTML = row.dataset.favorite === "1" ? editorHtml(row) : "";
      }
    });
  }

  function applyTabVisibility() {
    var onlyFavs = tab === "favs";
    panel.rows.forEach(function (row) {
      var hide = onlyFavs && row.dataset.favorite !== "1";
      row.classList.toggle("tab-hidden", hide);
      var detail = row.nextElementSibling;
      if (hide && detail && detail.classList.contains("detail")) detail.hidden = true;
    });
    var missing = el("missingFavs");
    if (missing) missing.hidden = !onlyFavs;
    var favCount = Object.keys(favs).length;
    var all = el("tabAll");
    var fav = el("tabFavs");
    if (all) all.className = onlyFavs ? "" : "on";
    if (fav) fav.className = onlyFavs ? "on" : "";
    if (fav) fav.textContent = "收藏 (" + favCount + ")";
  }

  function refresh() {
    decorateRows();
    applyTabVisibility();
    panel.apply();
  }

  // ── filters, sort and tab survive a reload ────────────────────────────────
  function currentState() {
    var state = { tab: tab };
    FILTERS.forEach(function (id) {
      var node = el(id);
      if (!node) return;
      state[id] = node.type === "checkbox" ? (node.checked ? "1" : "0") : node.value;
    });
    return state;
  }

  function persist() {
    var parts = [];
    var state = currentState();
    Object.keys(state).forEach(function (k) {
      if (state[k] !== "" && state[k] !== "0") parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(state[k]));
    });
    var hash = parts.length ? "#" + parts.join("&") : "";
    if (location.hash !== hash) history.replaceState(null, "", hash || location.pathname + location.search);
    if (SERVE) { try { localStorage.setItem("nftPanelState", JSON.stringify(state)); } catch (e) {} }
  }

  function restore() {
    var params = new URLSearchParams((location.hash || "").replace(/^#/, ""));
    var state = null;
    if ([...params.keys()].length > 0) {
      state = {};
      params.forEach(function (value, key) { state[key] = value; });
    } else if (SERVE) {
      try { state = JSON.parse(localStorage.getItem("nftPanelState") || "null"); } catch (e) {}
    }
    if (!state) return;
    if (state.tab === "favs") tab = "favs";
    FILTERS.forEach(function (id) {
      var node = el(id);
      if (!node || state[id] === undefined) return;
      if (node.type === "checkbox") node.checked = state[id] === "1";
      else node.value = state[id];
    });
  }

  // ── note / status editor inside the expanded row ──────────────────────────
  function editorHtml(row) {
    var rec = favs[keyOf(row.dataset.chain, row.dataset.contract)];
    return '<span class="fav-editor">收藏标记：<select class="fav-status" data-chain="' + row.dataset.chain + '" data-contract="' + row.dataset.contract + '">' +
      ["watching", "ready", "dismissed"].map(function (value) {
        var label = value === "watching" ? "观察" : value === "ready" ? "准备" : "放弃";
        return '<option value="' + value + '"' + (rec && rec.status === value ? " selected" : "") + ">" + label + "</option>";
      }).join("") +
      '</select> 备注：<input class="fav-note" data-chain="' + row.dataset.chain + '" data-contract="' + row.dataset.contract +
      '" value="' + (rec && rec.note ? String(rec.note).replace(/[&<>"]/g, "") : "") + '" placeholder="为什么收藏它"></span>';
  }

  document.addEventListener("click", function (event) {
    var drop = event.target.closest("[data-remove-fav]");
    if (drop) {
      var dropKey = drop.dataset.removeFav;
      var parts = dropKey.split("|");
      delete favs[dropKey];
      save({ chain: parts[0], contract: parts[1] }, "remove");
      var entry = drop.closest(".missing-item");
      if (entry) entry.remove();
      applyTabVisibility();
      return;
    }
    var star = event.target.closest(".star");
    if (star) {
      event.stopPropagation();
      var row = star.closest("tr");
      var key = keyOf(row.dataset.chain, row.dataset.contract);
      if (favs[key]) {
        delete favs[key];
        save({ chain: row.dataset.chain, contract: row.dataset.contract }, "remove");
      } else {
        var snapshot = null;
        try { snapshot = JSON.parse(row.dataset.snapshot); } catch (e) {}
        favs[key] = {
          chain: row.dataset.chain, contract: row.dataset.contract,
          slug: row.dataset.slug || null, name: row.dataset.name || null,
          addedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          status: "watching", note: "", snapshot: snapshot,
        };
        save(favs[key], "add");
      }
      refresh();
      var detail = row.nextElementSibling;
      if (detail && detail.classList.contains("detail")) {
        var editor = detail.querySelector(".fav-editor");
        if (editor) editor.outerHTML = favs[key] ? editorHtml(row) : '<span class="muted">已取消收藏</span>';
      }
      return;
    }
    var tabButton = event.target.closest("[data-tab]");
    if (tabButton) {
      tab = tabButton.dataset.tab === "favs" ? "favs" : "all";
      persist();
      refresh();
    }
  });

  document.addEventListener("change", function (event) {
    var status = event.target.closest(".fav-status");
    var note = event.target.closest(".fav-note");
    if (!status && !note) return;
    var node = status || note;
    var key = keyOf(node.dataset.chain, node.dataset.contract);
    if (!favs[key]) return;
    if (status) favs[key].status = status.value;
    if (note) favs[key].note = note.value;
    favs[key].updatedAt = new Date().toISOString();
    save(favs[key], "update");
    if (status) el("favNote").textContent = "已保存";
  });

  FILTERS.forEach(function (id) {
    var node = el(id);
    if (node) node.addEventListener("change", persist);
    if (node) node.addEventListener("input", persist);
  });

  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  var targetExport = el("exportTargets");
  if (targetExport) targetExport.addEventListener("click", function () {
    var byChain = {};
    Object.keys(favs).forEach(function (key) {
      var rec = favs[key];
      (byChain[rec.chain] = byChain[rec.chain] || []).push(rec.contract);
    });
    var targets = Object.keys(byChain).map(function (chain) {
      return { chain: chain, targets: byChain[chain].map(function (contract) { return { contract: contract, quantity: 1, maxPriceEth: "current" }; }) };
    });
    download("targets.favorites.json", JSON.stringify(targets.length === 1 ? targets[0] : { version: 1, chains: targets }, null, 2), "application/json");
  });
  var jsonlExport = el("exportFavorites");
  if (jsonlExport) jsonlExport.addEventListener("click", function () {
    if (SERVE) { window.open("/api/favorites?format=jsonl", "_blank"); return; }
    var lines = Object.keys(favs).map(function (key) { return JSON.stringify(Object.assign({ key: key }, favs[key])); });
    download("favorites.jsonl", lines.join("\\n") + (lines.length ? "\\n" : ""), "application/x-ndjson");
  });
  var copyLink = el("copyFilterLink");
  if (copyLink) copyLink.addEventListener("click", function () {
    persist();
    var text = location.href;
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    el("copyNote").textContent = "已复制筛选链接";
  });

  if (!SERVE) {
    var hint = el("favHint");
    if (hint) hint.textContent = "静态页面：收藏与筛选保存在本浏览器（部署 --serve 后可服务端保存与导出）";
  }

  restore();
  refresh();
  persist();
})();
`;
