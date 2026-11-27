import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { ValidationPipe } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { startLangfuseTracing, shutdownLangfuseTracing } from './observability/langfuse';
import { httpDuration, httpRequestsTotal, refreshInFlight } from './observability/metrics';

/** 在途请求数。放在模块顶层，避免中间件里出现 TDZ。 */
let inFlight = 0;

/**
 * HTTP 指标中间件。
 *
 * route 优先取 express 的路由模板（`/documents/:id`），而不是真实 path。
 * 否则每个 id 都是一条新的时间序列，指标基数会爆炸——Prometheus 最怕这个。
 * 路由还没匹配上时（比如 404）退回路径第一段。
 */
function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (req.path === '/metrics') {
    next();
    return;
  }
  const startedAt = process.hrtime.bigint();
  inFlight += 1;
  refreshInFlight.set(inFlight);

  res.on('finish', () => {
    inFlight = Math.max(0, inFlight - 1);
    refreshInFlight.set(inFlight);

    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    // 有路由模板就用模板（/documents/:id）；匹配不上（404）时取前两段路径，
    // 而不是第一段——否则所有 404 都会挤在 route="/api" 上，指标失去分辨力。
    let route = (req.route?.path as string) || req.baseUrl || '';
    if (!route || route === '/') {
      const segs = req.path.split('/').filter(Boolean).slice(0, 2);
      route = segs.length ? `/${segs.join('/')}` : '/';
    } else if (!route.startsWith('/')) {
      route = `/${route}`;
    }
    httpRequestsTotal.inc({
      method: req.method,
      route,
      status: String(res.statusCode),
    });
    httpDuration.observe({ route }, seconds);
  });
  next();
}

async function bootstrap() {
  startLangfuseTracing();
  // bufferLogs：启动阶段（模块初始化、连接数据库）的日志先缓存，
  // 等 useLogger 挂上 pino 之后再一次性输出——否则启动日志会是
  // 前半段文本、后半段 JSON，混在一起。
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(metricsMiddleware);
  app.enableShutdownHooks();
  process.once('beforeExit', () => {
    shutdownLangfuseTracing();
  });
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
