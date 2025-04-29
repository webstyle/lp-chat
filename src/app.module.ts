import { Module } from '@nestjs/common';
import { PrismaModule } from './modules/prisma/prisma.module';
import { ChatModule } from './modules/chat/chat.module';
import { BotModule } from './modules/bot/bot.module';
import { NestjsGrammyModule } from '@grammyjs/nestjs';
import { env } from './common/config/env.config';
import { FileModule } from './modules/file/file.module';
import { UserModule } from './modules/user/user.module';
import { ScheduleModule } from '@nestjs/schedule';
import { TopicModule } from './modules/topic/topic.module';
import { JwtModule } from '@nestjs/jwt';
import { AppService } from './app.service';
import { AppController } from './app.controller';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    ChatModule,
    BotModule,
    FileModule,
    NestjsGrammyModule.forRoot({
      token: env.BOT_TOKEN,
    }),

    JwtModule.register({
      global: true,
      secret: env.JWT_SECRET,
    }),
    UserModule,
    TopicModule,
  ],
  providers: [AppService],
  controllers: [AppController],
})
export class AppModule {}
