// ダッシュボード API（OGS_Dashboard_Functions）の接続先。
// Function App をデプロイしたら、そのホスト名に置き換える（末尾は /api）。
// scripts/setup-azure.ps1 を使うと自動で書き換わる。
window.OGS_DASHBOARD_CONFIG = {
  apiBase: "https://ogs-dashboard-fn.azurewebsites.net/api",
};
