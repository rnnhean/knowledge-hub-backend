import { randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MongooseModule } from '@nestjs/mongoose';
import { MailerModule } from '@nestjs-modules/mailer';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { DocumentModule } from './document/document.module';
import { DocumentEntity } from './document/entities/document.entity';
import { DocumentReviewEntity } from './document/entities/document-review.entity';
import { AuthModule } from './auth/auth.module';
import { UserEntity } from './user/entities/user.entity';
import { RoleEntity } from './user/entities/role.entity';
import { UserRoleEntity } from './user/entities/user-role.entity';
import { PermissionEntity } from './user/entities/permission.entity';
import { RolePermissionEntity } from './user/entities/role-permission.entity';
import { UserPermissionEntity } from './user/entities/user-permission.entity';
import { TeamEntity } from './team/entities/team.entity';
import { TeamMemberEntity } from './team/entities/team-member.entity';
import { TeamModule } from './team/team.module';
import { RedisModule } from './redis/redis.module';
import { MqModule } from './mq/mq.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { StorageModule } from './storage/storage.module';
import { SearchModule } from './search/search.module';
import { AiModule } from './ai/ai.module';
import { GraphModule } from './graph/graph.module';
import { AiSessionEntity } from './ai/entities/ai-session.entity';
import { AiMessageEntity } from './ai/entities/ai-message.entity';
import { CategoryEntity } from './document/entities/category.entity';
import { CommentEntity } from './document/entities/comment.entity';
import { DocumentLikeEntity } from './document/entities/document-like.entity';
import { DocumentFavoriteEntity } from './document/entities/document-favorite.entity';
import { DocumentShareEntity } from './document/entities/document-share.entity';
import { DocumentVersionEntity } from './document/entities/document-version.entity';
import { NotificationEntity } from './notification/notification.entity';
import { NotificationModule } from './notification/notification.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // ── 结构化日志 ──
    //
    // 为什么换掉 Nest 内置 logger：它输出的是给人看的文本
    // （`[Nest] 38916 - 2026/11/27 16:29:37 LOG [Xxx] ...`），
    // 灌进 ES 后没法按字段过滤，也没法做「只看某次请求的全部日志」这种排除法。
    //
    // 用 pino 是因为它是 Node 生态事实标准，且 pino-http 自带请求级日志，
    // 不用自己写 interceptor 去记录每个请求的耗时和状态码。
    LoggerModule.forRoot({
      pinoHttp: {
        // 输出到 stdout + 文件。
        //   stdout：容器部署时由 Docker / Filebeat 采；
        //   文件：本地裸进程跑时没有容器日志可采，只能靠文件。
        // 两个都写，同一份代码两种环境都不用改。
        transport: {
          targets: [
            { target: 'pino/file', options: { destination: 1 } },
            ...(process.env.LOG_FILE
              ? [
                  {
                    target: 'pino/file' as const,
                    options: { destination: process.env.LOG_FILE, mkdir: true },
                  },
                ]
              : []),
          ],
        },
        // 复用请求头里的 trace id：网关和 Agent 都在传 X-Trace-Id，
        // 日志里带上它才能把一次请求在多个服务间的日志串起来。
        // pino-http 要求 ReqId 必定有值（不能 undefined），
        // 所以没有透传时自己生成一个——否则 reqId 字段时有时无，
        // ES 里按 reqId 聚合会对不齐。
        genReqId: (req: { headers: Record<string, unknown> }) =>
          (req.headers['x-trace-id'] as string) || randomUUID(),
        customProps: () => ({ service: 'knowledge-hub' }),
        // 时间统一成 ts（ISO 8601），和 gateway 的 slog 输出对齐。
        // 不这样做的后果：@timestamp 只能取采集时间，和业务时间差几毫秒，
        // 跨服务对时间线时会错位。
        //
        // 注意：这里**不能**用 formatters.level 把 level 转成字符串。
        // pino 有硬限制——同时使用 transport（双写 stdout + 文件）时，
        // 自定义 level formatter 会抛
        // `option.transport.targets do not allow custom level formatters`
        // （实测直接把服务启动搞挂）。level 数字到文字的转换放在 Filebeat 侧做。
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        // 默认 serializer 会把整个 req（含 headers、cookie）打出来，
        // token 就混在 authorization 头里。只保留排查必需的字段。
        serializers: {
          req: (req: { method: string; url: string; remoteAddress: string }) => ({
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
          }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        // 健康检查每秒一次，记了只会淹没真正的业务请求
        autoLogging: {
          ignore: (req: { headers: Record<string, unknown>; url?: string }) => {
            const url = req.url ?? '';
            return url === '/metrics' || url === '/health' || url === '/';
          },
        },
      },
    }),
    RedisModule,
    MailerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        transport: {
          host: configService.get<string>('MAIL_HOST'),
          port: Number(configService.get<string>('MAIL_PORT')),
          secure: configService.get<string>('MAIL_SECURE') === 'true',
          auth: {
            user: configService.get<string>('MAIL_USER'),
            pass: configService.get<string>('MAIL_PASS'),
          },
        },
        defaults: {
          from: configService.get<string>('MAIL_FROM'),
        },
      }),
    }),
    PipelineModule,
    MqModule,
    StorageModule,
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        host: config.get<string>('POSTGRES_HOST', 'localhost'),
        port: config.get<number>('POSTGRES_PORT', 5432),
        username: config.get<string>('POSTGRES_USER', 'user'),
        password: config.get<string>('POSTGRES_PASSWORD', '123456'),
        database: config.get<string>('POSTGRES_DB', 'knowledge_hub'),
        entities: [
          DocumentEntity,
          DocumentReviewEntity,
          UserEntity,
          RoleEntity,
          UserRoleEntity,
          PermissionEntity,
          RolePermissionEntity,
          UserPermissionEntity,
          TeamEntity,
          TeamMemberEntity,
          AiSessionEntity,
          AiMessageEntity,
          CategoryEntity,
          CommentEntity,
          DocumentLikeEntity,
          DocumentFavoriteEntity,
          DocumentShareEntity,
          DocumentVersionEntity,
          NotificationEntity,
        ],
        synchronize: false,
      }),
    }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.get<string>(
          'MONGO_URI',
          'mongodb://mongo_user:mongo_pass123@localhost:27017/knowledge_hub?authSource=admin',
        ),
      }),
    }),
    NotificationModule,
    DocumentModule,
    AuthModule,
    TeamModule,
    SearchModule,
    AiModule,
    GraphModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
