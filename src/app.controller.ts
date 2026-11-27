import { Controller, Get, Header } from '@nestjs/common';
import { AppService } from './app.service';
import { Public } from './auth/decorators/public.decorator';
import { renderAll } from './observability/metrics';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  /**
   * Prometheus 抓取口。
   *
   * 不加鉴权，和 loyalty-console 的网关保持一致：Prometheus 用服务账号抓，
   * 多一层 token 只会多一个会过期的配置项。生产上靠网络隔离
   * （只开在容器网段，nginx 不转发这个路径）。
   */
  @Public()
  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return renderAll();
  }
}
