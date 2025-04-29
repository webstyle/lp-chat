import { forwardRef, Module } from '@nestjs/common';
import { BotService } from './bot.service';
import { BotController } from './bot.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { FileModule } from '../file/file.module';
import { ChatModule } from '../chat/chat.module';
import { BotHttpService } from './bot-http.service';

@Module({
  imports: [PrismaModule, FileModule, forwardRef(() => ChatModule)],
  providers: [BotController, BotService, BotHttpService],
  exports: [BotService, BotHttpService],
})
export class BotModule {}
