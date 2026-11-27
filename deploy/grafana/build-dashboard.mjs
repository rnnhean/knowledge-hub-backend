/**
 * 生成 knowledge-hub 的 Grafana dashboard 并推送到本地 Grafana。
 *
 * 单独抽成脚本而不是手写 JSON：面板一多，手改 JSON 很容易漏个逗号，
 * 而且表达式（PromQL）集中在代码里更便于 review。
 *
 * 用法：GRAFANA_USER=admin GRAFANA_PASS=*** node deploy/grafana/build-dashboard.mjs
 * 前置：Grafana 在 13000（与 loyalty-console 共用同一实例，靠指标前缀区分）。
 *
 * 凭据从环境变量读，不写死在代码里——默认口令只该存在于本机的
 * docker-compose，不该跟着源码进仓库。
 */

const GRAFANA = process.env.GRAFANA || 'http://127.0.0.1:13000';
const USER = process.env.GRAFANA_USER || 'admin';
const PASS = process.env.GRAFANA_PASS;
if (!PASS) {
    console.error('缺少 GRAFANA_PASS 环境变量');
    process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${USER}:${PASS}`).toString('base64');
const DS = { type: 'prometheus', uid: 'prometheus' };

const stat = (title, expr, unit, x, y, extra = {}) => ({
    type: 'stat',
    title,
    datasource: DS,
    gridPos: { x, y, w: 4, h: 4 },
    fieldConfig: { defaults: { unit, ...extra }, overrides: [] },
    targets: [{ refId: 'A', expr }],
    options: { reduceOptions: { calcs: ['lastNotNull'] }, colorMode: 'value', graphMode: 'area' },
});

const ts = (title, expr, unit, x, y, legend, w = 12, h = 8) => ({
    type: 'timeseries',
    title,
    datasource: DS,
    gridPos: { x, y, w, h },
    fieldConfig: { defaults: { unit }, overrides: [] },
    targets: [{ refId: 'A', expr, legendFormat: legend || '{{label}}' }],
    options: { legend: { displayMode: 'list', placement: 'bottom' } },
});

/** 多曲线面板：同一张图叠 P50/P95/P99，比三张图省地方也更容易读。 */
const quantiles = (title, metric, x, y, w = 12, h = 8) => ({
    type: 'timeseries',
    title,
    datasource: DS,
    gridPos: { x, y, w, h },
    fieldConfig: { defaults: { unit: 's' }, overrides: [] },
    targets: [
        { refId: 'A', expr: `histogram_quantile(0.50, sum by (le) (rate(${metric}_bucket[5m])))`, legendFormat: 'p50' },
        { refId: 'B', expr: `histogram_quantile(0.95, sum by (le) (rate(${metric}_bucket[5m])))`, legendFormat: 'p95' },
        { refId: 'C', expr: `histogram_quantile(0.99, sum by (le) (rate(${metric}_bucket[5m])))`, legendFormat: 'p99' },
    ],
    options: { legend: { displayMode: 'list', placement: 'bottom' } },
});

const row = (title, y) => ({ type: 'row', title, gridPos: { x: 0, y, w: 24, h: 1 }, panels: [] });

const dashboard = {
    uid: 'knowledge-hub',
    title: 'Knowledge Hub · 知识库',
    tags: ['knowledge-hub', 'rag', 'agent'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 0,
    refresh: '10s',
    time: { from: 'now-1h', to: 'now' },
    panels: [
        row('RAG 服务 · 吞吐与模型', 0),
        stat('请求数（1h）', 'sum(increase(kh_http_requests_total[1h]))', 'short', 0, 1),
        stat('在途请求', 'kh_refresh_inflight', 'short', 4, 1),
        stat('模型调用（1h）', 'sum(increase(kh_llm_calls_total[1h]))', 'short', 8, 1),
        stat('Token 总量（1h）', 'sum(increase(kh_llm_tokens_total[1h]))', 'short', 12, 1),
        // 加 or vector(0)：没有 5xx 时 PromQL 返回空向量，面板会显示 "No data"，
        // 看起来像采集挂了，实际是「一切正常」。显式补 0 才是对的读法。
        stat('5xx 错误率', '(sum(rate(kh_http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(kh_http_requests_total[5m])), 0.001)) or vector(0)', 'percentunit', 16, 1),
        stat('P95 延迟', 'histogram_quantile(0.95, sum by (le) (rate(kh_http_request_duration_seconds_bucket[5m])))', 's', 20, 1),

        ts('请求速率（按状态码）', 'sum by (status) (rate(kh_http_requests_total[5m]))', 'reqps', 0, 5, '{{status}}'),
        quantiles('接口延迟 P50 / P95 / P99', 'kh_http_request_duration_seconds', 12, 5),

        row('大模型用量 · 成本', 13),
        ts('Token 用量（按方向）', 'sum by (direction) (rate(kh_llm_tokens_total[5m]))', 'short', 0, 14, '{{direction}}'),
        ts('模型调用结果', 'sum by (result) (increase(kh_llm_calls_total[1h]))', 'short', 12, 14, '{{result}}'),

        row('检索质量', 22),
        ts('检索判定分布（ok / insufficient）', 'sum by (verdict) (increase(kh_retrieval_total[1h]))', 'short', 0, 23, '{{verdict}}'),
        ts('最慢的接口（P95）', 'topk(8, histogram_quantile(0.95, sum by (le, route) (rate(kh_http_request_duration_seconds_bucket[10m]))))', 's', 12, 23, '{{route}}'),
    ],
};

const res = await fetch(`${GRAFANA}/api/dashboards/db`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: AUTH },
    body: JSON.stringify({ dashboard, overwrite: true, folderUid: '' }),
});
const json = await res.json();
console.log(res.status, JSON.stringify(json).slice(0, 200));
if (json.status !== 'success') process.exit(1);
console.log(`\n打开：${GRAFANA}${json.url}`);
