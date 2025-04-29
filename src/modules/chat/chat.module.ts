import { forwardRef, Module } from '@nestjs/common';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { SocketGateway } from './socket.gateway';
import { UserModule } from '../user/user.module';
import { BotModule } from '../bot/bot.module';
import { StreamService } from './getstream';
import { StreamController } from './stream.conroller';

@Module({
  imports: [PrismaModule, UserModule, forwardRef(() => BotModule)],
  controllers: [ChatController, StreamController],
  providers: [SocketGateway, ChatService, StreamService],
  exports: [ChatService, SocketGateway],
})
export class ChatModule {}
