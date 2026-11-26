/**
 * 检索指标测试：Recall@K / MRR / NDCG@K。
 *
 * 这三个指标是「评测能不能指导优化」的关键：没有它们，改 rerank 只能靠感觉。
 * 测试重点不是公式本身，而是**边界**：空金标不算分、无召回记 0、排序敏感。
 */
import { mrr, ndcgAtK, recallAtK } from './evaluators';
import type { ChatEvalSnapshot } from './eval.types';

/** 造一个最小的 eval 入参 */
function args(titles: string[], gold?: string[]): Parameters<typeof mrr>[0] {
  const output = {
    rawHits: titles.map((t, i) => ({
      index: i,
      documentId: `doc-${i}`,
      documentTitle: t,
      heading: null,
    })),
  } as unknown as ChatEvalSnapshot;
  return {
    input: { question: 'q' },
    output,
    expectedOutput: gold ? { relevantDocTitles: gold } : undefined,
  } as unknown as Parameters<typeof mrr>[0];
}

describe('recallAtK', () => {
    const recall5 = recallAtK(5);

    it('金标全在 Top-K 内 → 1', async () => {
        const r = await recall5(args(['差旅报销制度', '报销流程', '无关'], ['差旅', '报销流程']));
        expect(r.name).toBe('recall_at_5');
        expect(r.value).toBe(1);
    });

    it('部分召回 → 比例', async () => {
        const r = await recall5(args(['差旅报销制度', '无关1', '无关2'], ['差旅', '培训制度']));
        expect(r.value).toBe(0.5);
    });

    it('完全没召回 → 0（不是 null）', async () => {
        const r = await recall5(args(['无关'], ['差旅']));
        expect(r.value).toBe(0);
    });

    it('金标为空 → null 跳过（不参与均值）', async () => {
        const r = await recall5(args(['差旅']));
        expect(r.value).toBeNull();
        expect(r.comment).toContain('无相关文档金标');
    });

    it('金标超出 K 的文档不计入', async () => {
        const recall2 = recallAtK(2);
        const r = await recall2(args(['无关1', '无关2', '差旅报销制度'], ['差旅']));
        expect(r.value).toBe(0);
    });
});

describe('mrr', () => {
    it('首个命中排第 1 → 1', async () => {
        const r = await mrr(args(['差旅制度', '无关'], ['差旅']));
        expect(r.value).toBe(1);
    });

    it('首个命中排第 3 → 1/3', async () => {
        const r = await mrr(args(['a', 'b', '差旅制度'], ['差旅']));
        expect(r.value).toBe(0.3333);
    });

    it('未命中 → 0', async () => {
        const r = await mrr(args(['a', 'b'], ['差旅']));
        expect(r.value).toBe(0);
    });

    it('空金标 → null', async () => {
        expect((await mrr(args(['a']))).value).toBeNull();
    });
});

describe('ndcgAtK', () => {
    const ndcg5 = ndcgAtK(5);

    it('理想排序（命中在最前）→ 1', async () => {
        const r = await ndcg5(args(['差旅制度'], ['差旅']));
        expect(r.value).toBe(1);
    });

    it('排序越靠后得分越低（对数折损）', async () => {
        const first = await ndcg5(args(['差旅制度', 'x'], ['差旅']));
        const second = await ndcg5(args(['x', '差旅制度'], ['差旅']));
        expect(first.value!).toBeGreaterThan(second.value!);
        expect(second.value!).toBeCloseTo(1 / Math.log2(3), 3);
    });

    it('未命中 → 0', async () => {
        expect((await ndcg5(args(['x'], ['差旅']))).value).toBe(0);
    });

    it('空金标 → null', async () => {
        expect((await ndcg5(args(['x']))).value).toBeNull();
    });

    it('多条金标时，捞回越多得分越高', async () => {
        const one = await ndcg5(args(['差旅', 'x', 'x'], ['差旅', '培训']));
        const two = await ndcg5(args(['差旅', '培训', 'x'], ['差旅', '培训']));
        expect(two.value!).toBeGreaterThan(one.value!);
    });
});
