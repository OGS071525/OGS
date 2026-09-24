/* OGS 管理ダッシュボード
   - ログイン（ID / パスワード）→ セッショントークンを sessionStorage に保持
   - /dashboard/overview を取得し、アプリごとに Cosmos DB / Blob の利用状況を描く
   - グラフは inline SVG（外部ライブラリなし）。すべての値に表表示を用意する */
(function () {
  "use strict";

  const cfg = window.OGS_DASHBOARD_CONFIG || {};
  const API = String(cfg.apiBase || "").replace(/\/+$/, "");
  const API_CONFIGURED = API && !API.includes("__DASHBOARD_FUNCTION_HOST__");
  const TOKEN_KEY = "ogs_dashboard_token";

  const $ = (id) => document.getElementById(id);
  const nf = new Intl.NumberFormat("ja-JP");

  let overview = null;
  let selectedApp = "all";

  // ---------------------------------------------------------------------------
  // 小さな DOM ヘルパー（文字列連結で HTML を組まない）
  // ---------------------------------------------------------------------------

  function el(tag, attrs, children) {
    const node = tag.startsWith("svg:")
      ? document.createElementNS("http://www.w3.org/2000/svg", tag.slice(4))
      : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "class") node.setAttribute("class", v);
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
        else if (k === "dataset") Object.assign(node.dataset, v);
        else node.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const c of [].concat(children || [])) {
      if (c === null || c === undefined || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  // ---------------------------------------------------------------------------
  // 表示フォーマット
  // ---------------------------------------------------------------------------

  function fmtNum(n) {
    return n === undefined || n === null ? "–" : nf.format(n);
  }

  function fmtBytes(n) {
    if (n === undefined || n === null) return "–";
    if (n < 1024) return `${n} B`;
    if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
    return `${(n / 1024 ** 3).toFixed(2)} GB`;
  }

  function fmtDateTime(iso) {
    if (!iso) return "–";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
  }

  function fmtDay(day) {
    // "2026-09-24" → "9/24"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    return m ? `${Number(m[2])}/${Number(m[3])}` : day;
  }

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch {
      return url || "";
    }
  }

  // ---------------------------------------------------------------------------
  // 表示名（labels.js の辞書）。Azure 上の生の名前を「何のデータか」が分かる名前にする。
  // 辞書に無ければ生の名前をそのまま返す。
  // ---------------------------------------------------------------------------

  const LABELS = window.OGS_DASHBOARD_LABELS || {};
  const appLabels = (appKey) => (LABELS.apps && LABELS.apps[appKey]) || {};

  function metricLabel(key) {
    return (LABELS.metrics && LABELS.metrics[key]) || { name: key, desc: "" };
  }

  /** コンテナの表示名と説明。 */
  function containerLabel(appKey, name) {
    const entry = (appLabels(appKey).containers || {})[name];
    if (!entry) return { name, desc: "", raw: name, mapped: false };
    if (typeof entry === "string") return { name: entry, desc: "", raw: name, mapped: true };
    return { name: entry.name || name, desc: entry.desc || "", raw: name, mapped: true };
  }

  /** 項目名（createdAt → 作成日時 など）。アプリごとの上書き → 共通辞書 → 生の名前。 */
  function fieldLabel(appKey, field) {
    const perApp = appLabels(appKey).fields || {};
    return perApp[field] || (LABELS.fields || {})[field] || field;
  }

  /** 値の意味（type: "daily-quiz" → 今日のクイズ など）。 */
  function valueLabel(appKey, field, value) {
    const perApp = (appLabels(appKey).values || {})[field] || {};
    const common = (LABELS.values || {})[field] || {};
    const key = String(value);
    return perApp[key] || common[key] || key;
  }

  function arrayLabel(appKey, field) {
    const perApp = appLabels(appKey).arrays || {};
    return perApp[field] || (LABELS.fields || {})[field] || field;
  }

  function blobLabel(appKey, name) {
    const perApp = appLabels(appKey).blobs || {};
    return perApp[name] || name;
  }

  /** 表示名の横に生の名前を小さく出す（辞書で変換したときだけ）。 */
  function rawTag(raw, friendly) {
    if (!raw || raw === friendly) return null;
    return el("code", { class: "raw", text: raw, title: `Azure 上の名前: ${raw}` });
  }

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  function token() {
    try {
      return sessionStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  }

  function setToken(value) {
    try {
      if (value) sessionStorage.setItem(TOKEN_KEY, value);
      else sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* プライベートモード等で保存できないときはメモリだけで動く */
    }
  }

  async function api(path, options) {
    const opts = Object.assign({ headers: {} }, options || {});
    opts.headers = Object.assign({ Accept: "application/json" }, opts.headers);
    const t = token();
    if (t) opts.headers.Authorization = `Bearer ${t}`;
    let res;
    try {
      res = await fetch(`${API}${path}`, opts);
    } catch (err) {
      throw new Error("API に接続できません。ネットワークか API の設定を確認してください");
    }
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.status === 401) {
      const e = new Error((body && body.error) || "ログインが必要です");
      e.unauthorized = true;
      throw e;
    }
    if (!res.ok) throw new Error((body && body.error) || `API エラー (${res.status})`);
    return body;
  }

  // ---------------------------------------------------------------------------
  // 画面切替
  // ---------------------------------------------------------------------------

  function showLogin(message) {
    $("dashboard-view").hidden = true;
    $("topbar-actions").hidden = true;
    $("login-view").hidden = false;
    const err = $("login-error");
    if (message) {
      err.textContent = message;
      err.hidden = false;
    } else {
      err.hidden = true;
    }
    $("login-password").value = "";
  }

  function showDashboard() {
    $("login-view").hidden = true;
    $("dashboard-view").hidden = false;
    $("topbar-actions").hidden = false;
  }

  function setLoading(on, text) {
    $("loading").hidden = !on;
    if (text) $("loading-text").textContent = text;
    $("refresh-btn").disabled = on;
  }

  function logout(message) {
    setToken(null);
    overview = null;
    showLogin(message);
  }

  // ---------------------------------------------------------------------------
  // ログイン
  // ---------------------------------------------------------------------------

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (!API_CONFIGURED) return;
    const id = $("login-id").value.trim();
    const password = $("login-password").value;
    const err = $("login-error");
    err.hidden = true;
    if (!id || !password) {
      err.textContent = "ID とパスワードを入力してください";
      err.hidden = false;
      return;
    }
    $("login-submit").disabled = true;
    try {
      const res = await api("/dashboard/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, password }),
      });
      setToken(res.token);
      showDashboard();
      await loadOverview(false);
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      $("login-submit").disabled = false;
    }
  });

  $("logout-btn").addEventListener("click", () => logout());
  $("refresh-btn").addEventListener("click", () => loadOverview(true));

  // ---------------------------------------------------------------------------
  // 集計の取得と描画
  // ---------------------------------------------------------------------------

  async function loadOverview(refresh) {
    setLoading(true, refresh ? "全アプリを集計し直しています（1 分ほどかかることがあります）…" : "集計を取得しています…");
    try {
      overview = await api(`/dashboard/overview${refresh ? "?refresh=1" : ""}`);
      render();
    } catch (e) {
      if (e.unauthorized) return logout("セッションが切れました。もう一度ログインしてください");
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }

  function render() {
    if (!overview) return;
    $("generated-at").textContent = `最終集計 ${fmtDateTime(overview.generatedAt)}${overview.cached ? "（キャッシュ）" : ""}`;
    $("cache-note").textContent = overview.cached
      ? `${fmtDateTime(overview.generatedAt)} 時点のキャッシュです（「再集計」で最新化）`
      : `${fmtDateTime(overview.generatedAt)} に ${nf.format(Math.round(overview.elapsedMs / 100) / 10)} 秒で集計しました`;
    renderKpis();
    renderTabs();
    renderSections();
  }

  function renderKpis() {
    const row = $("kpi-row");
    clear(row);
    const apps = overview.apps || [];
    const sum = (f) => apps.reduce((s, a) => s + (a.summary ? a.summary[f] || 0 : 0), 0);
    const withServer = apps.filter((a) => a.cosmos || a.blob);
    const healthy = apps.filter((a) => a.health && a.health.ok).length;
    const checked = apps.filter((a) => a.health).length;
    const items = [
      ["登録データ（全アプリ合計）", fmtNum(sum("documents")), "件", "全アプリの Cosmos DB に保存されているデータの総数"],
      [`${metricLabel("last7d").name}`, fmtNum(sum("new7d")), "件", metricLabel("last7d").desc],
      [`${metricLabel("last30d").name}`, fmtNum(sum("new30d")), "件", metricLabel("last30d").desc],
      [`${metricLabel("users").name}（合計）`, fmtNum(sum("users")), "人・端末", "各アプリの利用者数の合計。アプリをまたいだ名寄せはしていない"],
      [metricLabel("active30d").name, fmtNum(sum("activeUsers30d")), "人・端末", metricLabel("active30d").desc],
      ["保存ファイルの容量", fmtBytes(sum("blobBytes")), `${fmtNum(sum("blobCount"))} ファイル`, "写真・レシート・PDF など Blob Storage の合計（Functions の内部ファイルは除く）"],
      [metricLabel("health").name, `${healthy} / ${checked}`, `${withServer.length} アプリにサーバーあり`, metricLabel("health").desc],
    ];
    for (const [label, value, sub, desc] of items) {
      row.appendChild(
        el("div", { class: "kpi", title: desc || "" }, [
          el("p", { class: "kpi-label", text: label }),
          el("p", { class: "kpi-value", text: value }),
          el("p", { class: "kpi-sub", text: sub }),
        ])
      );
    }
  }

  function renderTabs() {
    const nav = $("app-tabs");
    clear(nav);
    const tabs = [{ key: "all", label: "すべて" }].concat(
      (overview.apps || []).map((a) => ({ key: a.key, label: `${a.icon} ${a.name}` }))
    );
    for (const t of tabs) {
      nav.appendChild(
        el("button", {
          class: "app-tab",
          type: "button",
          role: "tab",
          "aria-selected": String(selectedApp === t.key),
          text: t.label,
          onclick: () => {
            selectedApp = t.key;
            renderTabs();
            renderSections();
          },
        })
      );
    }
  }

  function renderSections() {
    const root = $("app-sections");
    clear(root);
    for (const app of overview.apps || []) {
      if (selectedApp !== "all" && selectedApp !== app.key) continue;
      root.appendChild(renderApp(app));
    }
  }

  // ---------------------------------------------------------------------------
  // アプリ区画
  // ---------------------------------------------------------------------------

  function healthBadge(app) {
    if (!app.cosmos && !app.blob && !app.health) {
      return el("span", { class: "badge neutral" }, [el("span", { class: "dot" }), "サーバーなし"]);
    }
    if (!app.health) return null;
    const ok = app.health.ok;
    const label = ok
      ? `API 稼働中 ${app.health.latencyMs != null ? app.health.latencyMs + "ms" : ""}`
      : `API 応答なし ${app.health.status ? "(" + app.health.status + ")" : ""}`;
    return el("span", { class: `badge ${ok ? "good" : "bad"}`, title: app.health.url }, [
      el("span", { class: "dot" }),
      (ok ? "✓ " : "✕ ") + label.trim(),
    ]);
  }

  function renderApp(app) {
    const s = app.summary || {};
    const section = el("section", { class: "app-section", id: `app-${app.key}` });

    const meta = [];
    if (app.cosmos) meta.push(`Cosmos DB: ${hostOf(app.cosmos.endpoint)} / ${app.cosmos.database}`);
    if (app.blob && app.blob.accountName) meta.push(`Blob: ${app.blob.accountName}`);
    if (app.note) meta.push(app.note);

    section.appendChild(
      el("header", { class: "app-header" }, [
        el("span", { class: "app-icon", text: app.icon || "📱" }),
        el("div", {}, [el("h2", { class: "app-title", text: app.name }), el("p", { class: "app-meta", text: meta.join("　|　") })]),
        healthBadge(app),
      ])
    );

    if (!app.cosmos && !app.blob) {
      section.appendChild(el("p", { class: "empty", text: "このアプリはサーバーにデータを持ちません（端末内保存のみ）。ストアの統計は App Store Connect で確認してください。" }));
      return section;
    }

    section.appendChild(
      el(
        "div",
        { class: "app-summary" },
        [
          ["登録データ", fmtNum(s.documents), "このアプリの全コンテナの合計件数"],
          [metricLabel("last7d").name, fmtNum(s.new7d), metricLabel("last7d").desc],
          [metricLabel("last30d").name, fmtNum(s.new30d), metricLabel("last30d").desc],
          [metricLabel("users").name, fmtNum(s.users), "利用者の台帳（users / Members など）があればその件数、無ければ利用者 ID の種類数"],
          [metricLabel("active30d").name, fmtNum(s.activeUsers30d), metricLabel("active30d").desc],
          ["保存ファイルの容量", fmtBytes(s.blobBytes), "写真・レシート・PDF などの合計サイズ"],
        ].map(([label, value, desc]) =>
          el("div", { class: "mini-stat", title: desc }, [el("p", { class: "kpi-label", text: label }), el("p", { class: "kpi-value", text: value })])
        )
      )
    );

    if (app.cosmos) section.appendChild(renderCosmos(app));
    if (app.blob) section.appendChild(renderBlob(app));
    return section;
  }

  // ---------------------------------------------------------------------------
  // Cosmos DB
  // ---------------------------------------------------------------------------

  function renderCosmos(app) {
    const frag = document.createDocumentFragment();
    const c = app.cosmos;
    frag.appendChild(
      el("h3", { class: "subhead" }, [
        "保存データ（Cosmos DB）",
        el("span", { class: "count", text: `${c.containers.length} 種類` }),
      ])
    );
    if (c.error) frag.appendChild(el("div", { class: "error-box", text: `接続エラー: ${c.error}` }));
    if (c.containers.length === 0 && !c.error) frag.appendChild(el("p", { class: "empty", text: "コンテナがありません" }));

    const grid = el("div", { class: "container-grid" });
    const sorted = c.containers.slice().sort((a, b) => b.total - a.total);
    for (const cont of sorted) grid.appendChild(renderContainerCard(app, cont));
    frag.appendChild(grid);
    return frag;
  }

  function numBlock(value, label, desc) {
    return el("div", { class: "num", title: desc || "" }, [el("b", { text: value }), el("span", { text: label })]);
  }

  function renderContainerCard(app, cont) {
    const label = containerLabel(app.key, cont.name);
    const card = el("article", { class: "container-card" });
    card.appendChild(
      el("div", { class: "card-head" }, [
        el("div", {}, [
          el("h4", { class: "card-title" }, [label.name, " ", rawTag(label.raw, label.name)]),
          label.desc ? el("p", { class: "card-desc", text: label.desc }) : null,
        ]),
        cont.partitionKey ? el("span", { class: "card-pk", text: `PK ${cont.partitionKey}`, title: "パーティションキー（Cosmos DB のデータ分割の軸）" }) : null,
      ])
    );
    if (cont.error) card.appendChild(el("div", { class: "error-box", text: cont.error }));

    const m = metricLabel;
    const nums = [numBlock(fmtNum(cont.total), m("total").name, m("total").desc)];
    if (cont.timestampField) {
      const tsName = fieldLabel(app.key, cont.timestampField);
      nums.push(numBlock(fmtNum(cont.last7d), m("last7d").name, `${m("last7d").desc}（${tsName} で判定）`));
      nums.push(numBlock(fmtNum(cont.last30d), m("last30d").name, `${m("last30d").desc}（${tsName} で判定）`));
    }
    if (cont.userField) {
      const userName = fieldLabel(app.key, cont.userField);
      nums.push(numBlock(fmtNum(cont.distinctUsers), m("users").name, `${userName}（${cont.userField}）の異なる値の数`));
      if (cont.activeUsers30d !== undefined) nums.push(numBlock(fmtNum(cont.activeUsers30d), m("active30d").name, m("active30d").desc));
    }
    card.appendChild(el("div", { class: "card-numbers" }, nums));

    if (cont.daily && cont.daily.length) {
      card.appendChild(barChart(cont.daily, `日別の新規件数（${fieldLabel(app.key, cont.timestampField)} で集計）`));
    } else if (cont.total > 0) {
      card.appendChild(el("p", { class: "hint", text: "日時の項目が見つからないため推移は出せません" }));
    }

    for (const arr of cont.arrays || []) {
      const arrName = arrayLabel(app.key, arr.field);
      card.appendChild(
        el("div", { class: "array-block" }, [
          el("p", { class: "array-title" }, [`埋め込みデータ: ${arrName}`, " ", rawTag(arr.field, arrName)]),
          el("div", { class: "card-numbers" }, [
            numBlock(fmtNum(arr.total), m("arrayTotal").name, m("arrayTotal").desc),
            arr.timestampField ? numBlock(fmtNum(arr.last7d), m("last7d").name, `${fieldLabel(app.key, arr.timestampField)} で判定`) : null,
            arr.timestampField ? numBlock(fmtNum(arr.last30d), m("last30d").name, `${fieldLabel(app.key, arr.timestampField)} で判定`) : null,
          ]),
        ])
      );
      if (arr.daily && arr.daily.length) {
        card.appendChild(barChart(arr.daily, `${arrName} の日別件数（${fieldLabel(app.key, arr.timestampField)} で集計）`));
      }
    }

    for (const b of cont.breakdowns || []) card.appendChild(breakdownList(app.key, b));

    card.appendChild(
      el("div", { class: "card-actions" }, [
        el("button", {
          class: "btn ghost small",
          type: "button",
          text: "直近データを見る",
          disabled: cont.total === 0,
          onclick: () => openRecent(app, cont.name),
        }),
        el("span", { class: "hint", text: `${m("ru").name} ${Math.round(cont.requestCharge || 0)}`, title: m("ru").desc }),
      ])
    );
    return card;
  }

  // ---------------------------------------------------------------------------
  // 内訳（横棒）
  // ---------------------------------------------------------------------------

  function breakdownList(appKey, b) {
    const wrap = el("figure", { class: "breakdown" });
    const fieldName = fieldLabel(appKey, b.field);
    wrap.appendChild(el("figcaption", { class: "breakdown-title" }, [`内訳: ${fieldName}`, " ", rawTag(b.field, fieldName)]));
    const values = b.values || [];
    const max = values.reduce((m, v) => Math.max(m, v.count), 0) || 1;
    const shown = values.slice(0, 12);
    for (const v of shown) {
      const friendly = v.key === "(未設定)" ? v.key : valueLabel(appKey, b.field, v.key);
      const tip = friendly === v.key ? `${v.key}: ${fmtNum(v.count)} 件` : `${friendly}（${v.key}）: ${fmtNum(v.count)} 件`;
      wrap.appendChild(
        el("div", { class: "breakdown-row", title: tip }, [
          el("span", { class: "breakdown-key", text: friendly }),
          el("div", { class: "breakdown-track" }, [el("div", { class: "breakdown-fill", style: `width:${(v.count / max) * 100}%` })]),
          el("span", { class: "breakdown-count", text: fmtNum(v.count) }),
        ])
      );
    }
    if (values.length > shown.length) {
      const rest = values.slice(shown.length).reduce((s, v) => s + v.count, 0);
      wrap.appendChild(el("p", { class: "hint", text: `他 ${values.length - shown.length} 種 ${fmtNum(rest)} 件` }));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // 日別棒グラフ（inline SVG）
  // ---------------------------------------------------------------------------

  function barChart(daily, title) {
    const W = 320;
    const H = 96;
    const padL = 28;
    const padR = 4;
    const padT = 12;
    const padB = 16;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = daily.length;
    const gap = 2;
    const barW = Math.max(1, (plotW - gap * (n - 1)) / n);
    const max = daily.reduce((m, d) => Math.max(m, d.count), 0);
    const yMax = niceMax(max);
    const y = (v) => padT + plotH - (yMax ? (v / yMax) * plotH : 0);

    const fig = el("figure", { class: "chart" });
    const table = dailyTable(daily);
    table.hidden = true;
    const toggle = el("button", { class: "chart-toggle", type: "button", text: "表で見る", "aria-pressed": "false" });
    toggle.addEventListener("click", () => {
      const showTable = table.hidden;
      table.hidden = !showTable;
      svg.hidden = showTable;
      toggle.textContent = showTable ? "グラフで見る" : "表で見る";
      toggle.setAttribute("aria-pressed", String(showTable));
    });
    fig.appendChild(el("div", { class: "chart-head" }, [el("figcaption", { class: "chart-title", text: title }), toggle]));

    const svg = el("svg:svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}。直近 ${n} 日、最大 ${max} 件` });

    // グリッド（0 / 半分 / 最大）と目盛。最大が 1 以下なら中間線は出さない
    const ticks = yMax >= 2 ? [0, yMax / 2, yMax] : [0, yMax];
    for (const v of ticks) {
      const yy = y(v);
      svg.appendChild(el("svg:line", { class: v === 0 ? "baseline" : "gridline", x1: padL, x2: W - padR, y1: yy, y2: yy }));
      svg.appendChild(el("svg:text", { class: "tick", x: padL - 4, y: yy + 3, "text-anchor": "end", text: fmtNum(Math.round(v)) }));
    }

    let maxIdx = -1;
    daily.forEach((d, i) => {
      if (d.count === max && max > 0 && maxIdx === -1) maxIdx = i;
    });

    daily.forEach((d, i) => {
      const x = padL + i * (barW + gap);
      const top = y(d.count);
      const h = padT + plotH - top;
      if (d.count > 0) {
        svg.appendChild(el("svg:path", { class: "bar", d: roundedTopBar(x, top, barW, h, Math.min(2, barW / 2)) }));
      } else {
        svg.appendChild(el("svg:rect", { class: "bar zero", x, y: padT + plotH - 1.5, width: barW, height: 1.5 }));
      }
      // ヒット領域は棒より大きく（列全体）
      const hit = el("svg:rect", { class: "hit", x: x - gap / 2, y: padT, width: barW + gap, height: plotH + padB });
      hit.addEventListener("mouseenter", (ev) => showTooltip(ev, `${fmtDay(d.day)}　${fmtNum(d.count)} 件`));
      hit.addEventListener("mousemove", (ev) => moveTooltip(ev));
      hit.addEventListener("mouseleave", hideTooltip);
      svg.appendChild(hit);
      if (i === maxIdx) {
        svg.appendChild(el("svg:text", { class: "tick", x: x + barW / 2, y: top - 3, "text-anchor": "middle", text: fmtNum(d.count) }));
      }
    });

    // x 軸ラベル: 最初・中央・最後
    for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
      const x = padL + i * (barW + gap) + barW / 2;
      svg.appendChild(el("svg:text", { class: "tick", x, y: H - 3, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle", text: fmtDay(daily[i].day) }));
    }

    fig.appendChild(svg);
    fig.appendChild(table);
    return fig;
  }

  function roundedTopBar(x, y, w, h, r) {
    if (h <= r) return `M${x},${y + h} v${-h} h${w} v${h} z`;
    return `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`;
  }

  function niceMax(max) {
    if (max <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(max)));
    const unit = max / pow;
    const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
    return nice * pow;
  }

  function dailyTable(daily) {
    const rows = daily.map((d) => el("tr", {}, [el("td", { text: d.day }), el("td", { text: fmtNum(d.count) })]));
    return el("table", { class: "chart-table" }, [
      el("thead", {}, [el("tr", {}, [el("th", { text: "日付" }), el("th", { text: "件数" })])]),
      el("tbody", {}, rows),
    ]);
  }

  // --- ツールチップ ---
  function showTooltip(ev, text) {
    const t = $("tooltip");
    t.textContent = text;
    t.hidden = false;
    moveTooltip(ev);
  }

  function moveTooltip(ev) {
    const t = $("tooltip");
    t.style.left = `${ev.clientX}px`;
    t.style.top = `${ev.clientY}px`;
  }

  function hideTooltip() {
    $("tooltip").hidden = true;
  }

  // ---------------------------------------------------------------------------
  // Blob Storage
  // ---------------------------------------------------------------------------

  function renderBlob(app) {
    const frag = document.createDocumentFragment();
    const b = app.blob;
    const user = b.containers.filter((c) => !c.system);
    const system = b.containers.filter((c) => c.system);
    frag.appendChild(
      el("h3", { class: "subhead" }, [
        "保存ファイル（Blob Storage）",
        el("span", { class: "count", text: `${user.length} 種類` }),
        el("code", { class: "raw", text: b.accountName || "-", title: "ストレージアカウント名" }),
      ])
    );
    if (b.error) frag.appendChild(el("div", { class: "error-box", text: `接続エラー: ${b.error}` }));
    if (user.length === 0 && !b.error) frag.appendChild(el("p", { class: "empty", text: "アプリのファイル保存領域はありません" }));
    if (user.length) frag.appendChild(blobTable(app.key, user));
    if (system.length) {
      frag.appendChild(
        el("details", { class: "system-toggle" }, [
          el("summary", { text: `Functions 内部のファイル（デプロイ パッケージ・鍵など）${system.length} 種類を表示` }),
          blobTable(app.key, system),
        ])
      );
    }
    return frag;
  }

  function blobTable(appKey, containers) {
    const m = metricLabel;
    const rows = containers.map((c) => {
      const friendly = c.system ? c.name : blobLabel(appKey, c.name);
      return el("tr", { class: c.system ? "system" : "" }, [
        el("td", {}, friendly === c.name ? [el("code", { text: c.name })] : [friendly, " ", rawTag(c.name, friendly)]),
        el("td", { class: "num", text: fmtNum(c.blobCount) + (c.truncated ? "+" : "") }),
        el("td", { class: "num", text: fmtBytes(c.totalBytes) }),
        el("td", { class: "num", text: fmtNum(c.modified30d) }),
        el("td", { text: fmtDateTime(c.lastModified) }),
        el("td", { text: c.error || "" }),
      ]);
    });
    return el("div", { class: "table-wrap" }, [
      el("table", { class: "data-table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "保存しているもの" }),
            el("th", { class: "num", text: m("blobCount").name, title: m("blobCount").desc }),
            el("th", { class: "num", text: m("blobBytes").name, title: m("blobBytes").desc }),
            el("th", { class: "num", text: m("modified30d").name, title: m("modified30d").desc }),
            el("th", { text: m("lastModified").name, title: m("lastModified").desc }),
            el("th", { text: "" }),
          ]),
        ]),
        el("tbody", {}, rows),
      ]),
    ]);
  }

  // ---------------------------------------------------------------------------
  // 直近データ（モーダル）
  // ---------------------------------------------------------------------------

  let recentItems = [];
  let recentRaw = false;

  let recentAppKey = "";

  async function openRecent(app, containerName) {
    const modal = $("recent-modal");
    recentAppKey = app.key;
    const label = containerLabel(app.key, containerName);
    $("recent-title").textContent = `${app.name} / ${label.name}${label.mapped ? `（${containerName}）` : ""} の直近データ`;
    const body = $("recent-body");
    clear(body);
    body.appendChild(el("p", { class: "empty", text: "取得しています…" }));
    modal.hidden = false;
    recentRaw = false;
    $("recent-toggle-raw").textContent = "JSON 表示";
    try {
      const res = await api(`/dashboard/apps/${encodeURIComponent(app.key)}/containers/${encodeURIComponent(containerName)}/recent?limit=50`);
      recentItems = res.items || [];
      renderRecent();
    } catch (e) {
      if (e.unauthorized) {
        modal.hidden = true;
        return logout("セッションが切れました。もう一度ログインしてください");
      }
      clear(body);
      body.appendChild(el("div", { class: "error-box", text: e.message }));
    }
  }

  function renderRecent() {
    const body = $("recent-body");
    clear(body);
    if (recentItems.length === 0) {
      body.appendChild(el("p", { class: "empty", text: "データがありません" }));
      return;
    }
    if (recentRaw) {
      body.appendChild(el("pre", { text: JSON.stringify(recentItems, null, 2) }));
      return;
    }
    // 列 = 全件のキーの和集合。id と日時っぽい列を前に出し、最大 14 列。
    const keys = new Map();
    for (const item of recentItems) for (const k of Object.keys(item || {})) keys.set(k, (keys.get(k) || 0) + 1);
    const priority = (k) => (k === "id" ? 0 : /At$|_at$|^timestamp$|^date$/.test(k) ? 1 : /^(type|kind|status)$/.test(k) ? 2 : 3);
    const columns = [...keys.keys()].sort((a, b) => priority(a) - priority(b) || keys.get(b) - keys.get(a)).slice(0, 14);

    const rows = recentItems.map((item) =>
      el(
        "tr",
        {},
        columns.map((k) => {
          const v = item[k];
          // 種類・状態などの値は辞書で意味に置き換える（元の値はツールチップ）
          const friendly = typeof v === "string" || typeof v === "boolean" ? valueLabel(recentAppKey, k, v) : null;
          const text = friendly !== null && friendly !== String(v) ? `${friendly}（${v}）` : cellText(v);
          return el("td", { text });
        })
      )
    );
    body.appendChild(
      el("div", { class: "table-wrap" }, [
        el("table", { class: "data-table" }, [
          el("thead", {}, [
            el("tr", {}, columns.map((k) => {
              const friendly = fieldLabel(recentAppKey, k);
              return el("th", { title: k }, friendly === k ? [k] : [friendly, " ", rawTag(k, friendly)]);
            })),
          ]),
          el("tbody", {}, rows),
        ]),
      ])
    );
  }

  function cellText(v) {
    if (v === undefined) return "";
    if (v === null) return "null";
    if (typeof v === "object") {
      const s = JSON.stringify(v);
      return s.length > 80 ? `${s.slice(0, 80)}…` : s;
    }
    const s = String(v);
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  }

  $("recent-toggle-raw").addEventListener("click", () => {
    recentRaw = !recentRaw;
    $("recent-toggle-raw").textContent = recentRaw ? "表で表示" : "JSON 表示";
    renderRecent();
  });

  $("recent-modal").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-close]")) $("recent-modal").hidden = true;
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") $("recent-modal").hidden = true;
  });

  // ---------------------------------------------------------------------------
  // 起動
  // ---------------------------------------------------------------------------

  async function boot() {
    if (!API_CONFIGURED) {
      $("login-note").textContent = "API の接続先が設定されていません。dashboard/config.js の apiBase に Function App のホストを設定してください。";
      $("login-submit").disabled = true;
      showLogin();
      return;
    }
    if (!token()) {
      showLogin();
      return;
    }
    try {
      await api("/dashboard/session");
      showDashboard();
      await loadOverview(false);
    } catch (e) {
      logout(e.unauthorized ? "" : e.message);
    }
  }

  boot();
})();
