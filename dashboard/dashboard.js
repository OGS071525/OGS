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
  const SESSION_EXPIRED_MESSAGE = "セッションが切れました。もう一度ログインしてください";
  /** API が内訳で null / undefined の値に付けるキー（cosmosMetrics.ts の UNSET_KEY と対） */
  const UNSET_KEY = "(未設定)";
  /** 直近データの表で 1 セルに出す最大文字数 */
  const CELL_MAX_CHARS = 80;
  const DAY_MS = 86400000;
  const JST_OFFSET_MS = 9 * 3600000;
  /** 系列色のスロット数（dashboard.css の --series-1〜8）。超えたアプリは灰色にする */
  const SERIES_SLOTS = 8;

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

  function fmtFullDay(day) {
    // "2026-09-24" → "2026/9/24"
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || "");
    return m ? `${m[1]}/${Number(m[2])}/${Number(m[3])}` : day;
  }

  /** 日本時間の日付（YYYY-MM-DD） */
  function jstDay(ms) {
    return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10);
  }

  /** 集計時点（日本時間）の日付 */
  function generatedDay() {
    const t = Date.parse(overview.generatedAt);
    return jstDay(Number.isNaN(t) ? Date.now() : t);
  }

  /** endDay から遡る days 日分の日付（古い順） */
  function dayRange(endDay, days) {
    const end = Date.parse(`${endDay}T00:00:00Z`);
    const out = [];
    for (let i = days - 1; i >= 0; i--) out.push(new Date(end - i * DAY_MS).toISOString().slice(0, 10));
    return out;
  }

  /** startDay〜endDay の日付（古い順） */
  function daysBetween(startDay, endDay) {
    const start = Date.parse(`${startDay}T00:00:00Z`);
    const end = Date.parse(`${endDay}T00:00:00Z`);
    return dayRange(endDay, Math.max(1, Math.round((end - start) / DAY_MS) + 1));
  }

  /** アプリの系列色。色はアプリの並び順（設定順）で固定し、表示するアプリが減っても塗り替えない */
  function appColor(app) {
    const i = (overview.apps || []).indexOf(app);
    return i >= 0 && i < SERIES_SLOTS ? `var(--series-${i + 1})` : "var(--muted)";
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

  /** アプリごとの辞書（section: fields / arrays）→ 共通の fields 辞書 → 生の名前。 */
  function nameFrom(appKey, section, key) {
    const perApp = appLabels(appKey)[section] || {};
    return perApp[key] || (LABELS.fields || {})[key] || key;
  }

  /** 項目名（createdAt → 作成日時 など）。 */
  function fieldLabel(appKey, field) {
    return nameFrom(appKey, "fields", field);
  }

  /** 値の意味（type: "daily-quiz" → 今日のクイズ など）。 */
  function valueLabel(appKey, field, value) {
    const perApp = (appLabels(appKey).values || {})[field] || {};
    const common = (LABELS.values || {})[field] || {};
    const key = String(value);
    return perApp[key] || common[key] || key;
  }

  /** 埋め込み配列の名前（histories → 立替・割り勘の記録 など）。 */
  function arrayLabel(appKey, field) {
    return nameFrom(appKey, "arrays", field);
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
      if (e.unauthorized) return logout(SESSION_EXPIRED_MESSAGE);
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
    renderUsersTable();
    renderUsersCharts();
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
    const m = metricLabel;
    const items = [
      ["登録データ（全アプリ合計）", fmtNum(sum("documents")), "件", "全アプリの Cosmos DB に保存されているデータの総数"],
      [m("last7d").name, fmtNum(sum("new7d")), "件", m("last7d").desc],
      [m("last30d").name, fmtNum(sum("new30d")), "件", m("last30d").desc],
      [`${m("users").name}（合計）`, fmtNum(sum("users")), "人・端末", "各アプリの利用者数の合計。アプリをまたいだ名寄せはしていない"],
      [m("active30d").name, fmtNum(sum("activeUsers30d")), "人・端末", m("active30d").desc],
      ["保存ファイルの容量", fmtBytes(sum("blobBytes")), `${fmtNum(sum("blobCount"))} ファイル`, "写真・レシート・PDF など Blob Storage の合計（Functions の内部ファイルは除く）"],
      [m("health").name, `${healthy} / ${checked}`, `${withServer.length} アプリにサーバーあり`, m("health").desc],
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

  // ---------------------------------------------------------------------------
  // アプリ別の利用者数・ダウンロード数（一覧表）
  // ---------------------------------------------------------------------------

  /** 一覧表の数値列: [UserStats の項目, 見出し] */
  const DOWNLOAD_COLUMNS = [
    ["total", "累計"],
    ["new1d", "24時間"],
    ["new7d", "7日"],
    ["new30d", "30日"],
  ];
  const ACTIVE_COLUMNS = [
    ["active1d", "24時間"],
    ["active7d", "7日"],
    ["active30d", "30日"],
  ];
  const USER_COLUMNS = DOWNLOAD_COLUMNS.concat(ACTIVE_COLUMNS);

  function selectApp(key) {
    selectedApp = key;
    renderTabs();
    renderSections();
    const target = $(`app-${key}`);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  /** 利用者数が出せないアプリの理由（表の 1 セルにまとめて出す）。 */
  function usersUnavailableReason(app) {
    if (!app.cosmos) return `${app.note || "サーバーにデータを持ちません"}。ストアの数値は App Store Connect で確認してください`;
    if (app.cosmos.error) return `データベースに接続できませんでした: ${app.cosmos.error}`;
    return "利用者 ID を持つデータがありません";
  }

  function renderUsersTable() {
    const root = $("users-table");
    clear(root);
    const m = metricLabel;
    const apps = overview.apps || [];
    const counted = apps.filter((a) => a.users);

    const rows = apps.map((app) => {
      const nameCell = el("td", {}, [
        el("button", { class: "app-link", type: "button", text: `${app.icon || "📱"} ${app.name}`, onclick: () => selectApp(app.key) }),
      ]);
      const u = app.users;
      if (!u) {
        return el("tr", {}, [nameCell, el("td", { class: "muted", colspan: USER_COLUMNS.length + 1, text: usersUnavailableReason(app) })]);
      }
      return el("tr", {}, [
        nameCell,
        ...USER_COLUMNS.map(([key], i) => el("td", { class: i === 0 ? "num strong" : "num", text: fmtNum(u[key]) })),
        el("td", { text: fmtDateTime(u.lastActiveAt) }),
      ]);
    });

    const sum = (key) => counted.reduce((s, a) => s + (a.users[key] || 0), 0);
    const latest = counted.map((a) => a.users.lastActiveAt).filter(Boolean).sort().pop();
    const foot = el("tr", {}, [
      el("td", { text: "合計", title: "アプリをまたいだ名寄せはしていない単純合計" }),
      ...USER_COLUMNS.map(([key]) => el("td", { class: "num", text: fmtNum(sum(key)) })),
      el("td", { text: fmtDateTime(latest) }),
    ]);

    const sub = (cols, desc) => cols.map(([, label]) => el("th", { class: "num", text: label, title: desc }));
    root.appendChild(
      el("div", { class: "table-wrap" }, [
        el("table", { class: "data-table users-table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { rowspan: 2, text: "アプリ" }),
              el("th", { class: "group", colspan: DOWNLOAD_COLUMNS.length, text: m("downloads").name, title: m("downloads").desc }),
              el("th", { class: "group", colspan: ACTIVE_COLUMNS.length, text: m("activeUsers").name, title: m("activeUsers").desc }),
              el("th", { rowspan: 2, text: m("lastActive").name, title: m("lastActive").desc }),
            ]),
            el("tr", {}, [...sub(DOWNLOAD_COLUMNS, m("downloads").desc), ...sub(ACTIVE_COLUMNS, m("activeUsers").desc)]),
          ]),
          el("tbody", {}, rows),
          counted.length > 1 ? el("tfoot", {}, [foot]) : null,
        ]),
      ])
    );
  }

  // ---------------------------------------------------------------------------
  // アプリ別の利用者数・ダウンロード数（グラフ）
  //   - 日別のダウンロード数 / 日別の利用者数: 日ごとの積み上げ棒（積み上げの色 = アプリ）
  //   - 累計ダウンロード数の推移: アプリごとの折れ線
  // 上の「期間」「アプリ」の切り替えが 3 つのグラフすべてに効く。色はアプリの並び順で固定（appColor）。
  // SVG は表示幅に合わせて描き直す（viewBox で拡大すると文字の大きさが揃わないため）
  // ---------------------------------------------------------------------------

  const PERIODS = [
    ["30", "30日"],
    ["90", "90日"],
    ["all", "全期間"],
  ];
  const DEFAULT_USERS_FILTER = { period: "30", app: "all" };
  /** 期間とアプリの選択はこのブラウザにだけ覚えておく（無くても既定値で動く） */
  const USERS_FILTER_KEY = "ogs_dashboard_users_filter";
  /** タッチで読んだツールチップを消すまでの時間 */
  const TOUCH_TOOLTIP_MS = 3000;

  let usersFilter = loadUsersFilter();
  let chartObservers = [];

  function loadUsersFilter() {
    try {
      return Object.assign({}, DEFAULT_USERS_FILTER, JSON.parse(localStorage.getItem(USERS_FILTER_KEY) || "{}"));
    } catch {
      return Object.assign({}, DEFAULT_USERS_FILTER);
    }
  }

  function setUsersFilter(change, focus) {
    Object.assign(usersFilter, change);
    try {
      localStorage.setItem(USERS_FILTER_KEY, JSON.stringify(usersFilter));
    } catch {
      /* 保存できなくても今回の表示には効く */
    }
    renderUsersCharts(focus);
  }

  /** container の幅が変わるたびに draw(幅) で中身を作り直す。 */
  function drawResponsive(container, draw) {
    let lastWidth = 0;
    const ro = new ResizeObserver(() => {
      const w = Math.floor(container.clientWidth);
      if (!w || w === lastWidth) return;
      lastWidth = w;
      clear(container);
      container.appendChild(draw(w));
    });
    ro.observe(container);
    chartObservers.push(ro);
  }

  function legend(items) {
    return el(
      "div",
      { class: "legend" },
      items.map((it) =>
        el("span", { class: "legend-item" }, [el("span", { class: it.line ? "legend-line" : "legend-swatch", style: `background:${it.color}` }), it.label])
      )
    );
  }

  /** 0 から max を覆う、きりのよい目盛（4 区切り前後） */
  function niceTicks(max) {
    const raw = Math.max(1, max) / 4;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw));
    const ticks = [];
    for (let v = 0; v < max + step; v += step) ticks.push(v);
    return ticks;
  }

  /** focus: 作り直したあとにフォーカスを戻す切り替え（"period" / "app"） */
  function renderUsersCharts(focus) {
    chartObservers.forEach((o) => o.disconnect());
    chartObservers = [];
    const root = $("users-charts");
    clear(root);
    const withUsers = (overview.apps || []).filter((a) => a.users);
    if (withUsers.length === 0) return;
    if (!PERIODS.some(([key]) => key === usersFilter.period)) usersFilter.period = DEFAULT_USERS_FILTER.period;
    if (!withUsers.some((a) => a.key === usersFilter.app)) usersFilter.app = "all";

    const apps = usersFilter.app === "all" ? withUsers : withUsers.filter((a) => a.key === usersFilter.app);
    const days = chartDays(apps);
    const m = metricLabel;

    const filters = usersFilterBar(withUsers);
    root.appendChild(filters);

    const downloads = apps.map((a) => dailySeries(a, a.users.newByDay, days));
    const downloadSum = downloads.reduce((s, x) => s + x.values.reduce((a, b) => a + b, 0), 0);
    root.appendChild(
      dailyStackChart(m("dailyNew").name, `期間内の合計 ${fmtNum(downloadSum)}。${m("dailyNew").desc}`, downloads, days)
    );

    const active = apps.map((a) => dailySeries(a, a.users.activeByDay, days));
    const activeSum = active.reduce((s, x) => s + x.values.reduce((a, b) => a + b, 0), 0);
    const perDay = Math.round((activeSum / days.length) * 10) / 10;
    root.appendChild(
      dailyStackChart(m("dailyActive").name, `期間内の 1 日平均 ${fmtNum(perDay)}。${m("dailyActive").desc}`, active, days)
    );

    root.appendChild(cumulativeChart(cumulativeSeries(apps, days), days));

    if (focus) {
      const target = filters.querySelector(focus === "app" ? "select" : '.seg-btn[aria-pressed="true"]');
      if (target) target.focus();
    }
  }

  /** 期間の日付（日本時間・古い順）。全期間は選んだアプリの最初の記録から */
  function chartDays(apps) {
    const end = generatedDay();
    if (usersFilter.period !== "all") return dayRange(end, Number(usersFilter.period));
    const firsts = apps
      .flatMap((a) => [a.users.newByDay, a.users.activeByDay])
      .map((points) => (points && points[0] ? points[0].day : null))
      .filter(Boolean)
      .sort();
    const days = firsts.length ? daysBetween(firsts[0], end) : [];
    return days.length >= 30 ? days : dayRange(end, 30);
  }

  function dailySeries(app, points, days) {
    const counts = new Map((points || []).map((d) => [d.day, d.count]));
    return { app, color: appColor(app), values: days.map((day) => counts.get(day) || 0) };
  }

  /** アプリごとの累計（days の各日の終わり時点）。期間より前の分は初日の値に含める */
  function cumulativeSeries(apps, days) {
    return apps.map((app) => {
      const points = app.users.newByDay || [];
      const counts = new Map(points.map((d) => [d.day, d.count]));
      let running = points.filter((d) => d.day < days[0]).reduce((s, d) => s + d.count, 0);
      const values = days.map((day) => (running += counts.get(day) || 0));
      return { app, color: appColor(app), values };
    });
  }

  function usersFilterBar(apps) {
    const periodButtons = PERIODS.map(([key, label]) =>
      el("button", {
        class: "seg-btn",
        type: "button",
        "aria-pressed": String(usersFilter.period === key),
        text: label,
        onclick: () => setUsersFilter({ period: key }, "period"),
      })
    );
    const options = [{ key: "all", label: "すべてのアプリ" }].concat(apps.map((a) => ({ key: a.key, label: `${a.icon || ""} ${a.name}`.trim() })));
    const select = el(
      "select",
      { class: "filter-select", "aria-label": "アプリ" },
      options.map((o) => el("option", { value: o.key, text: o.label, selected: usersFilter.app === o.key }))
    );
    select.addEventListener("change", () => setUsersFilter({ app: select.value }, "app"));
    return el("div", { class: "chart-filters" }, [
      el("div", { class: "filter-group" }, [
        el("span", { class: "filter-label", text: "期間" }),
        el("div", { class: "segmented", role: "group", "aria-label": "期間" }, periodButtons),
      ]),
      el("div", { class: "filter-group" }, [el("span", { class: "filter-label", text: "アプリ" }), select]),
    ]);
  }

  /** グラフの枠: 見出し・説明・「表で見る」・凡例（2 系列以上）・本体（幅に合わせて描画）・表 */
  function chartFigure({ title, desc, series, lineKeys, table, draw }) {
    const fig = el("figure", { class: "chart users-chart" });
    const body = el("div", { class: "chart-body" });
    table.hidden = true;
    const toggle = el("button", { class: "chart-toggle", type: "button", text: "表で見る", "aria-pressed": "false" });
    toggle.addEventListener("click", () => {
      const showTable = table.hidden;
      table.hidden = !showTable;
      body.hidden = showTable;
      toggle.textContent = showTable ? "グラフで見る" : "表で見る";
      toggle.setAttribute("aria-pressed", String(showTable));
    });
    fig.appendChild(
      el("div", { class: "chart-head" }, [
        el("div", {}, [el("figcaption", { class: "chart-title", text: title }), desc ? el("p", { class: "chart-desc", text: desc }) : null]),
        toggle,
      ])
    );
    if (series.length > 1) fig.appendChild(legend(series.map((s) => ({ color: s.color, label: s.app.name, line: lineKeys }))));
    fig.appendChild(body);
    fig.appendChild(table);
    drawResponsive(body, draw);
    return fig;
  }

  /** 日付が横に並ぶグラフに、ポインタとキーボードでの読み取りを付ける。render(i) が強調とツールチップの中身を作る */
  function attachDayCursor(svg, o) {
    let current = o.n - 1;
    let touchTimer = 0;
    const clamp = (i) => Math.max(0, Math.min(o.n - 1, i));
    const show = (i, clientX, clientY) => {
      clearTimeout(touchTimer);
      current = clamp(i);
      showTooltipAt(clientX, clientY, o.render(current));
    };
    const hide = () => {
      o.reset();
      hideTooltip();
    };
    const onPointer = (ev) => {
      const r = svg.getBoundingClientRect();
      show(o.indexAt(ev.clientX - r.left), ev.clientX, ev.clientY);
    };
    const overlay = el("svg:rect", { class: "hit", x: o.left, y: o.top, width: o.width, height: o.height });
    overlay.addEventListener("pointermove", onPointer);
    overlay.addEventListener("pointerdown", onPointer);
    overlay.addEventListener("pointerleave", (ev) => {
      // タッチは指を離した時点で leave になるので、少し読めるように残してから消す
      if (ev.pointerType === "touch") touchTimer = setTimeout(hide, TOUCH_TOOLTIP_MS);
      else hide();
    });
    svg.appendChild(overlay);

    // キーボード: フォーカスで最新日、左右キーで 1 日ずつ移動
    const showCurrent = () => {
      const r = svg.getBoundingClientRect();
      show(current, r.left + o.xAt(current), r.top + o.top + 8);
    };
    svg.setAttribute("tabindex", "0");
    svg.addEventListener("focus", () => {
      current = o.n - 1;
      showCurrent();
    });
    svg.addEventListener("keydown", (ev) => {
      if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
      ev.preventDefault();
      current = clamp(current + (ev.key === "ArrowLeft" ? -1 : 1));
      showCurrent();
    });
    svg.addEventListener("blur", hide);
  }

  /** 目盛（y の横線と数値、x の日付）を描く */
  function drawDayAxes(svg, { days, ticks, yAt, xAt, left, right, height }) {
    for (const v of ticks) {
      const yy = yAt(v);
      svg.appendChild(el("svg:line", { class: v === 0 ? "baseline" : "gridline", x1: left, x2: right, y1: yy, y2: yy }));
      svg.appendChild(el("svg:text", { class: "tick", x: left - 6, y: yy + 3, "text-anchor": "end", text: fmtNum(v) }));
    }
    const last = days.length - 1;
    for (const t of dayTicks(days)) {
      const anchor = t.i === 0 ? "start" : t.i === last ? "end" : "middle";
      svg.appendChild(el("svg:text", { class: "tick", x: xAt(t.i), y: height - 6, "text-anchor": anchor, text: t.label }));
    }
  }

  /** x 軸の目盛: 長い期間は月初、短い期間は最初・中央・最後の日付 */
  function dayTicks(days) {
    if (days.length <= 62) {
      return [0, Math.floor((days.length - 1) / 2), days.length - 1].map((i) => ({ i, label: fmtDay(days[i]) }));
    }
    const months = [];
    days.forEach((d, i) => {
      if (d.endsWith("-01")) months.push({ i, label: `${Number(d.slice(5, 7))}月` });
    });
    const every = Math.ceil(months.length / 8);
    return months.filter((_, k) => k % every === 0);
  }

  // --- 日別の積み上げ棒 ---

  function dailyStackChart(title, desc, series, days) {
    const totals = days.map((_, i) => series.reduce((s, x) => s + x.values[i], 0));
    return chartFigure({
      title,
      desc,
      series,
      lineKeys: false,
      table: dayValuesTable(days, series, (i) => totals[i] > 0, series.length > 1),
      draw: (w) => drawStackedDays(series, days, totals, w, title),
    });
  }

  function drawStackedDays(series, days, totals, W, title) {
    const H = 200;
    const padT = 18;
    const padB = 22;
    const padL = 32;
    const padR = 8;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = days.length;
    const maxTotal = Math.max(...totals);
    const ticks = niceTicks(maxTotal);
    const yMax = ticks[ticks.length - 1];
    const unit = plotH / yMax;
    const baseY = padT + plotH;
    const yAt = (v) => baseY - v * unit;
    // 1 日ぶんの幅。棒どうしの隙間は 2px（狭いときは詰める）、棒の太さは 24px まで
    const slot = plotW / n;
    const gap = slot >= 8 ? 2 : slot >= 3 ? 1 : 0;
    const barW = Math.min(24, slot - gap);
    const segGap = unit >= 8 ? 2 : unit >= 4 ? 1 : 0;
    const xAt = (i) => padL + i * slot + slot / 2;

    const svg = el("svg:svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${title}。左右キーで日付を移動できます` });
    drawDayAxes(svg, { days, ticks, yAt, xAt, left: padL, right: padL + plotW, height: H });

    const highlight = el("svg:rect", { class: "col-highlight", y: padT, width: slot, height: plotH });
    highlight.style.display = "none";
    svg.appendChild(highlight);

    const maxIdx = maxTotal > 0 ? totals.indexOf(maxTotal) : -1;
    days.forEach((_, i) => {
      if (!totals[i]) return;
      const x = xAt(i) - barW / 2;
      const parts = series.filter((s) => s.values[i] > 0);
      let bottom = baseY;
      parts.forEach((s, k) => {
        const top = bottom - s.values[i] * unit;
        // 積み上げの境目は面の色の隙間で分ける（下の段の上端を削る）
        const height = Math.max(1, bottom - (k > 0 ? segGap : 0) - top);
        const d =
          k === parts.length - 1 ? roundedTopBar(x, top, barW, height, Math.min(4, barW / 2, height)) : `M${x},${top} h${barW} v${height} h${-barW} z`;
        svg.appendChild(el("svg:path", { class: "seg", d, style: `fill:${s.color}` }));
        bottom = top;
      });
      if (i === maxIdx) {
        svg.appendChild(el("svg:text", { class: "value", x: xAt(i), y: yAt(totals[i]) - 5, "text-anchor": "middle", text: fmtNum(totals[i]) }));
      }
    });
    if (maxTotal === 0) {
      svg.appendChild(el("svg:text", { class: "label", x: padL + plotW / 2, y: padT + plotH / 2, "text-anchor": "middle", text: "この期間はありません" }));
    }

    attachDayCursor(svg, {
      n,
      left: padL,
      top: padT,
      width: plotW,
      height: plotH + padB,
      xAt,
      indexAt: (px) => Math.floor((px - padL) / slot),
      render: (i) => {
        highlight.setAttribute("x", padL + i * slot);
        highlight.style.display = "";
        const rows = series.map((s) => tooltipRow(s.color, fmtNum(s.values[i]), s.app.name));
        if (series.length > 1) rows.push(tooltipRow("transparent", fmtNum(totals[i]), "合計"));
        return [el("div", { class: "tt-title", text: fmtFullDay(days[i]) }), ...rows];
      },
      reset: () => {
        highlight.style.display = "none";
      },
    });
    return svg;
  }

  // --- 累計ダウンロード数の推移 ---

  function cumulativeChart(series, days) {
    const m = metricLabel;
    return chartFigure({
      title: m("cumulative").name,
      desc: m("cumulative").desc,
      series,
      lineKeys: true,
      table: dayValuesTable(days, series, (i) => i === 0 || i === days.length - 1 || series.some((s) => s.values[i] !== s.values[i - 1]), false),
      draw: (w) => drawTrend(series, days, w),
    });
  }

  function drawTrend(series, days, W) {
    const H = 220;
    const padT = 10;
    const padB = 22;
    const padL = 32;
    const endLabels = W >= 480;
    const padR = endLabels ? 128 : 12;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const n = days.length;
    const last = n - 1;
    const xAt = (i) => padL + (n === 1 ? plotW : (i / last) * plotW);
    const ticks = niceTicks(Math.max(...series.map((s) => s.values[last])));
    const yMax = ticks[ticks.length - 1];
    const yAt = (v) => padT + plotH - (v / yMax) * plotH;

    const svg = el("svg:svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "累計ダウンロード数の推移。左右キーで日付を移動できます" });
    drawDayAxes(svg, { days, ticks, yAt, xAt, left: padL, right: padL + plotW, height: H });

    for (const s of series) {
      const points = s.values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
      svg.appendChild(el("svg:polyline", { class: "line", points, style: `stroke:${s.color}` }));
      svg.appendChild(el("svg:circle", { class: "end-dot", cx: xAt(last), cy: yAt(s.values[last]), r: 4, style: `fill:${s.color}` }));
    }

    // 線の終点に名前と値。重なる場合は値の大きい方だけ残し、残りは凡例とツールチップに任せる
    if (endLabels) {
      const placed = [];
      for (const s of series.slice().sort((a, b) => b.values[last] - a.values[last])) {
        const y = yAt(s.values[last]);
        if (placed.some((p) => Math.abs(p - y) < 14)) continue;
        placed.push(y);
        svg.appendChild(el("svg:text", { class: "value", x: xAt(last) + 8, y: y + 4, text: `${s.app.name} ${fmtNum(s.values[last])}` }));
      }
    }

    // 十字線（ポインタに最も近い日へ吸着）と、その日の全系列の値
    const cross = el("svg:g", { class: "crosshair-layer" });
    cross.style.display = "none";
    const vline = el("svg:line", { class: "crosshair", y1: padT, y2: padT + plotH });
    cross.appendChild(vline);
    const dots = series.map((s) => {
      const d = el("svg:circle", { class: "end-dot", r: 4, style: `fill:${s.color}` });
      cross.appendChild(d);
      return d;
    });
    svg.appendChild(cross);

    attachDayCursor(svg, {
      n,
      left: padL,
      top: padT,
      width: plotW,
      height: plotH + padB,
      xAt,
      indexAt: (px) => Math.round(((px - padL) / plotW) * last),
      render: (i) => {
        const x = xAt(i);
        vline.setAttribute("x1", x);
        vline.setAttribute("x2", x);
        series.forEach((s, k) => {
          dots[k].setAttribute("cx", x);
          dots[k].setAttribute("cy", yAt(s.values[i]));
        });
        cross.style.display = "";
        const rows = series
          .slice()
          .sort((a, b) => b.values[i] - a.values[i])
          .map((s) => tooltipRow(s.color, fmtNum(s.values[i]), s.app.name));
        return [el("div", { class: "tt-title", text: fmtFullDay(days[i]) }), ...rows];
      },
      reset: () => {
        cross.style.display = "none";
      },
    });
    return svg;
  }

  /** グラフの表表示: include(i) が真の日を新しい順に。withTotal で合計列を付ける */
  function dayValuesTable(days, series, include, withTotal) {
    const columns = series.length + 1 + (withTotal ? 1 : 0);
    const rows = [];
    days.forEach((day, i) => {
      if (!include(i)) return;
      const cells = series.map((s) => el("td", { text: fmtNum(s.values[i]) }));
      if (withTotal) cells.push(el("td", { text: fmtNum(series.reduce((sum, s) => sum + s.values[i], 0)) }));
      rows.push(el("tr", {}, [el("td", { text: day }), ...cells]));
    });
    rows.reverse();
    if (rows.length === 0) rows.push(el("tr", {}, [el("td", { colspan: columns, text: "この期間はありません" })]));
    const head = [el("th", { text: "日付" }), ...series.map((s) => el("th", { text: s.app.name }))];
    if (withTotal) head.push(el("th", { text: "合計" }));
    return el("div", { class: "chart-table-wrap" }, [
      el("table", { class: "chart-table" }, [el("thead", {}, [el("tr", {}, head)]), el("tbody", {}, rows)]),
    ]);
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

    const m = metricLabel;
    section.appendChild(
      el(
        "div",
        { class: "app-summary" },
        [
          ["登録データ", fmtNum(s.documents), "このアプリの全コンテナの合計件数"],
          [m("last7d").name, fmtNum(s.new7d), m("last7d").desc],
          [m("last30d").name, fmtNum(s.new30d), m("last30d").desc],
          [m("users").name, fmtNum(s.users), "全コンテナの利用者 ID を名寄せした端末・アカウントの数"],
          [m("active30d").name, fmtNum(s.activeUsers30d), m("active30d").desc],
          ["保存ファイルの容量", fmtBytes(s.blobBytes), "写真・レシート・PDF などの合計サイズ"],
        ].map(([label, value, desc]) =>
          el("div", { class: "mini-stat", title: desc }, [el("p", { class: "kpi-label", text: label }), el("p", { class: "kpi-value", text: value })])
        )
      )
    );

    if (app.users) section.appendChild(renderUserTrend(app));
    if (app.cosmos) section.appendChild(renderCosmos(app));
    if (app.blob) section.appendChild(renderBlob(app));
    return section;
  }

  /** 直近 30 日の日別のダウンロード数・利用者数と、利用者を数えた根拠（どのコンテナの何の項目か）。 */
  function renderUserTrend(app) {
    const u = app.users;
    const sources = (u.sources || [])
      .slice()
      .sort((a, b) => b.users - a.users)
      .map((s) => {
        const name = containerLabel(app.key, s.container).name;
        const label = s.array ? `${name}の${arrayLabel(app.key, s.array)}` : name;
        const raw = [s.container, s.array, s.field].filter(Boolean).join(".");
        return `${label}（${raw}）${fmtNum(s.users)}${s.truncated ? "・上限で打ち切り" : ""}`;
      });
    const days = dayRange(generatedDay(), 30);
    const daily = (points) => {
      const counts = new Map((points || []).map((d) => [d.day, d.count]));
      return days.map((day) => ({ day, count: counts.get(day) || 0 }));
    };
    const m = metricLabel;
    return el("div", { class: "user-trend" }, [
      el("div", { class: "user-trend-charts" }, [
        barChart(daily(u.newByDay), `${m("dailyNew").name}（直近 30 日）`),
        barChart(daily(u.activeByDay), `${m("dailyActive").name}（直近 30 日）`),
      ]),
      el("p", { class: "hint", text: `利用者の数え方: ${sources.join(" / ")} を名寄せ。最初の記録 ${fmtDateTime(u.firstSeenAt)}` }),
    ]);
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
      const friendly = v.key === UNSET_KEY ? v.key : valueLabel(appKey, b.field, v.key);
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
  /** content は文字列か DOM ノードの配列（複数系列の読み取り行など） */
  function showTooltip(ev, content) {
    showTooltipAt(ev.clientX, ev.clientY, content);
  }

  function showTooltipAt(x, y, content) {
    const t = $("tooltip");
    clear(t);
    for (const c of [].concat(content)) t.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    t.hidden = false;
    t.style.left = `${x}px`;
    t.style.top = `${y}px`;
  }

  function moveTooltip(ev) {
    const t = $("tooltip");
    t.style.left = `${ev.clientX}px`;
    t.style.top = `${ev.clientY}px`;
  }

  /** ツールチップの 1 行: 系列の色の短い線 ＋ 値（強調）＋ 系列名 */
  function tooltipRow(color, value, label) {
    return el("div", { class: "tt-row" }, [
      el("span", { class: "tt-key", style: `background:${color}` }),
      el("b", { text: value }),
      el("span", { text: label }),
    ]);
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

  function closeRecent() {
    $("recent-modal").hidden = true;
  }

  /** 「JSON 表示」⇄「表で表示」の切替ボタンの文言を現在の表示形式に合わせる。 */
  function setRecentRaw(raw) {
    recentRaw = raw;
    $("recent-toggle-raw").textContent = raw ? "表で表示" : "JSON 表示";
  }

  async function openRecent(app, containerName) {
    recentAppKey = app.key;
    const label = containerLabel(app.key, containerName);
    $("recent-title").textContent = `${app.name} / ${label.name}${label.mapped ? `（${containerName}）` : ""} の直近データ`;
    const body = $("recent-body");
    clear(body);
    body.appendChild(el("p", { class: "empty", text: "取得しています…" }));
    $("recent-modal").hidden = false;
    setRecentRaw(false);
    try {
      const res = await api(`/dashboard/apps/${encodeURIComponent(app.key)}/containers/${encodeURIComponent(containerName)}/recent?limit=50`);
      recentItems = res.items || [];
      renderRecent();
    } catch (e) {
      if (e.unauthorized) {
        closeRecent();
        return logout(SESSION_EXPIRED_MESSAGE);
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
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return s.length > CELL_MAX_CHARS ? `${s.slice(0, CELL_MAX_CHARS)}…` : s;
  }

  $("recent-toggle-raw").addEventListener("click", () => {
    setRecentRaw(!recentRaw);
    renderRecent();
  });

  $("recent-modal").addEventListener("click", (ev) => {
    if (ev.target.closest("[data-close]")) closeRecent();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") closeRecent();
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
