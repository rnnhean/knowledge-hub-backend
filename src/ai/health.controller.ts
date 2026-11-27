import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatLongMemoryService } from './chat-long-memory.service';

/**
 * 健康检查。
 *
 * **为什么要报记忆状态**：长期记忆的写入是外部服务（Mem0），
 * 它可能因为额度、网络、key 失效而不工作，而业务主流程会静默降级
 * （catch 住只打 warning）。不做成可见的，就等于"看起来在跑，其实记忆没写进去"——
 * 这类静默失效比直接报错危险得多。
 *
 * 只报**配置与能力**，不做真实外部调用：健康检查被探针高频调用，
 * 每次都打一次第三方 API 会拖慢探针并消耗对方配额。
 */
@Controller()
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly longMemory: ChatLongMemoryService,
  ) {}

  @Get('health')
  health() {
    const mem0Key = this.config.get<string>('MEM0_API_KEY') || '';
    return {
      ok: true,
      uptime: Math.floor(process.uptime()),
      memory: {
        // 是否配了 key（不代表能写）
        configured: Boolean(mem0Key),
        // 客户端是否成功初始化
        clientReady: this.longMemory.enabled,
        // 写入受限说明：Mem0 免费额度用完后，写操作需要绑自己的 LLM key。
        // 这里只描述能力缺口，不暴露任何凭据。
        writeHint: mem0Key
          ? '写入依赖 Mem0 侧额度/LLM 配置；额度用尽时写入会失败但检索仍可用'
          : '未配置 MEM0_API_KEY，长期记忆整体跳过',
      },
    };
  }
}
