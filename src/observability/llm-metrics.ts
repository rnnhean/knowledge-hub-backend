/**
 * 大模型调用的指标埋点。
 *
 * 挂法和 Langfuse 一样走 LangChain 的 callback —— 同一处钩子，两种用途：
 * Langfuse 存「这一次调用的输入输出」，Prometheus 只存「调用了几次、用了多少 token」。
 *
 * 为什么不直接用 Langfuse 的用量数据算指标：
 *   Langfuse 是抽样/批量的、且可能有采样率；Prometheus 要的是**每次调用都精确计数**。
 *   两者口径不同，不能互相替代——前者答「这次为什么慢」，后者答「今天花了多少」。
 */
import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';

import { llmCallsTotal, llmTokensTotal } from './metrics';

type TokenUsage = {
    promptTokens?: number;
    completionTokens?: number;
    input_tokens?: number;
    output_tokens?: number;
};

export class LlmMetricsHandler extends BaseCallbackHandler {
    name = 'kh-llm-metrics';

    handleLLMEnd(output: LLMResult): void {
        llmCallsTotal.inc({ result: 'ok' });

        // 用量有三个可能的落脚点，按可靠性排序：
        //   1) generations[].message.usage_metadata —— LangChain 标准字段，最可靠；
        //   2) llmOutput.tokenUsage —— 老版本 ChatOpenAI 放这里；
        //   3) llmOutput.usage_metadata —— 部分供应商适配层。
        // 流式调用要拿到第 1 种，模型必须开 streamUsage（见 ai-stream.service.ts），
        // 否则响应里根本没有 usage 字段——踩过：指标里 calls 有、tokens 恒为 0。
        const fromGeneration = (output.generations ?? [])
            .flat()
            .map((g) => {
                const msg = (g as { message?: { usage_metadata?: TokenUsage } }).message;
                return msg?.usage_metadata;
            })
            .find((u): u is TokenUsage => Boolean(u));

        const raw = (output.llmOutput ?? {}) as {
            tokenUsage?: TokenUsage;
            usage_metadata?: TokenUsage;
        };
        const usage = fromGeneration ?? raw.tokenUsage ?? raw.usage_metadata;
        if (!usage) return;

        const input = usage.promptTokens ?? usage.input_tokens ?? 0;
        const outputTok = usage.completionTokens ?? usage.output_tokens ?? 0;
        if (input > 0) llmTokensTotal.inc({ direction: 'input' }, input);
        if (outputTok > 0) llmTokensTotal.inc({ direction: 'output' }, outputTok);
    }

    handleLLMError(): void {
        llmCallsTotal.inc({ result: 'error' });
    }
}
