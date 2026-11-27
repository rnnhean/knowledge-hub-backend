/**
 * Prometheus 指标（零依赖）。
 *
 * 为什么不用 prom-client：
 *   这个项目已经在跑 17 个容器，依赖表越长、镜像越大、升级越容易冲。
 *   Prometheus 文本格式就几行正则能生成，自己糊一个注册表足够用，
 *   而且能精确控制「哪些路由算业务路由、哪些不算」。
 *
 * 三个问题对应三类指标：
 *   - 变慢了吗  → http_request_duration_seconds（直方图，算 P50/P95/P99）
 *   - 出错了吗  → http_requests_total{status}
 *   - 大模型花多少 → llm_tokens_total{direction} / llm_calls_total{result}
 */

export class Counter {
  private readonly values = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {}

  inc(labels: Record<string, string> = {}, value = 1): void {
    const key = this.keyOf(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + value);
  }

  private keyOf(labels: Record<string, string>): string {
    if (this.labelNames.length === 0) return '';
    return this.labelNames.map((n) => `${n}="${escape(String(labels[n] ?? ''))}"`).join(',');
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) return lines.join('\n');
    for (const [key, v] of this.values) {
      lines.push(`${this.name}${key ? `{${key}}` : ''} ${v}`);
    }
    return lines.join('\n');
  }
}

export class Gauge {
  private value = 0;
  private readonly labeled = new Map<string, number>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
  ) {}

  set(v: number): void {
    this.value = v;
  }

  setLabeled(labels: Record<string, string>, v: number): void {
    this.labeled.set(
      this.labelNames.map((n) => `${n}="${escape(String(labels[n] ?? ''))}"`).join(','),
      v,
    );
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    if (this.labelNames.length === 0) {
      lines.push(`${this.name} ${this.value}`);
    } else {
      for (const [key, v] of this.labeled) lines.push(`${this.name}{${key}} ${v}`);
    }
    return lines.join('\n');
  }
}

const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export class Histogram {
  private readonly buckets = new Map<string, { counts: number[]; sum: number; count: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: string[] = [],
    private readonly boundaries: number[] = BUCKETS,
  ) {}

  observe(labels: Record<string, string>, seconds: number): void {
    const key = this.labelNames.map((n) => `${n}="${escape(String(labels[n] ?? ''))}"`).join(',');
    let b = this.buckets.get(key);
    if (!b) {
      b = { counts: new Array(this.boundaries.length).fill(0), sum: 0, count: 0 };
      this.buckets.set(key, b);
    }
    // 只给「第一个装得下的桶」+1，render 时再做累计。
    // 这里若对每个边界都判一次并自增，render 又累计一遍，会得到平方级膨胀
    // （实测 3 次请求累计到 6，正是踩过这个坑）。
    const idx = this.boundaries.findIndex((bound) => seconds <= bound);
    if (idx >= 0) b.counts[idx]++;
    b.sum += seconds;
    b.count++;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, b] of this.buckets) {
      let cumulative = 0;
      for (let i = 0; i < this.boundaries.length; i++) {
        cumulative += b.counts[i];
        const lbl = key ? `${key},le="${this.boundaries[i]}"` : `le="${this.boundaries[i]}"`;
        lines.push(`${this.name}_bucket{${lbl}} ${cumulative}`);
      }
      const infLbl = key ? `${key},le="+Inf"` : `le="+Inf"`;
      lines.push(`${this.name}_bucket{${infLbl}} ${b.count}`);
      lines.push(`${this.name}_sum${key ? `{${key}}` : ''} ${b.sum}`);
      lines.push(`${this.name}_count${key ? `{${key}}` : ''} ${b.count}`);
    }
    return lines.join('\n');
  }
}

function escape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ── 具体指标 ─────────────────────────────────────────────

export const httpRequestsTotal = new Counter(
  'kh_http_requests_total',
  'HTTP 请求数，按方法/路由/状态码切分',
  ['method', 'route', 'status'],
);

export const httpDuration = new Histogram(
  'kh_http_request_duration_seconds',
  'HTTP 请求耗时（秒）',
  ['route'],
);

export const llmCallsTotal = new Counter(
  'kh_llm_calls_total',
  '大模型调用次数，按结果切分',
  ['result'],
);

export const llmTokensTotal = new Counter(
  'kh_llm_tokens_total',
  '大模型 token 用量，按方向切分（input/output）',
  ['direction'],
);

export const retrievalTotal = new Counter(
  'kh_retrieval_total',
  '知识库检索次数，按评价结果切分（ok/insufficient）',
  ['verdict'],
);

export const chatRequestsInFlight = new Gauge(
  'kh_chat_inflight',
  '当前正在进行的问答请求数',
);

export const refreshInFlight = new Gauge('kh_refresh_inflight', '当前在途请求数');

export function renderAll(): string {
  return [
    httpRequestsTotal.render(),
    httpDuration.render(),
    llmCallsTotal.render(),
    llmTokensTotal.render(),
    retrievalTotal.render(),
    chatRequestsInFlight.render(),
    refreshInFlight.render(),
  ].join('\n\n');
}
