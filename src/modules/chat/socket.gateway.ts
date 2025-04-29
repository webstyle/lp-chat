import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import {
  BadRequestException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { CoreApiResponse } from 'src/common/response-class/core-api.response';
import { UserService } from '../user/user.service';
import { ChatService } from './chat.service';
import { ConsultationStatus } from './enum';
import { CreateMessageDto } from './dto/message.dto';

@Injectable()
@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class SocketGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    @Inject(forwardRef(() => ChatService))
    private chatService: ChatService,
  ) {}

  @WebSocketServer() server: Server = new Server();

  test() {
    return this.server.emit('test', 'test');
  }

  async handleConnection(socket: Socket) {
    try {
      const consultationId = socket?.handshake?.query?.consultationId?.toString();
      const jwt = socket?.handshake?.headers?.authorization;

      if (!consultationId || !jwt) {
        throw new BadRequestException(
          !consultationId
            ? '"consultationId" in params not found'
            : 'Authorization token should be provided',
        );
      }

      const result = await this.userService.validate(jwt);
      if (!result?.success) throw new UnauthorizedException();

      const exitConsultation = await this.prisma.consultation.findFirst({
        where: { id: consultationId },
        select: { id: true, chatId: true },
      });

      if (!exitConsultation)
        throw new NotFoundException('Consultation not found or already closed');

      Object.assign(socket, {
        user: result.data,
        chatId: exitConsultation.chatId,
        consultationId,
      });

      this.server.in(socket.id).socketsJoin(consultationId.toString());
      console.log('join', socket.id);
    } catch (error) {
      console.error('Error in handleConnection:', error.message);
      const errResponse = CoreApiResponse.error(
        error instanceof HttpException ? error.getResponse() : 'Internal server error',
      );
      this.server.to(socket.id).emit('error', errResponse);
      socket.disconnect();
    }
  }

  async handleDisconnect(socket: Socket): Promise<void> {
    console.log(`Socket disconnected: ${socket.id}`);
  }

  sendMessageByOperatorViaSocket(consultationId: string, message: any) {
    this.server.to(consultationId).emit('sendMessageByOperator', CoreApiResponse.success(message));
  }

  sendMessageByClientViaSocket(consultationId: string, message: any) {
    this.server.to(consultationId).emit('sendMessageByClient', CoreApiResponse.success(message));
  }

  sendMessageToAcceptOperator(consultationId: string, message: any) {
    return this.server.to(consultationId).emit('accepted', CoreApiResponse.success(message));
  }

  disconnectChatMembers(consultationId: string) {
    try {
      const room = this.server.sockets.adapter.rooms.get(consultationId.toString());
      if (!room) throw 'Room not found';
      room.forEach((socketId) => {
        const client = this.server.sockets.sockets.get(socketId);
        if (!client) throw 'There is no client';
        client.disconnect();
        // console.log(`members of chat ${consultationId} disconnected`);
      });
    } catch (error) {
      console.log(error);
    }
  }

  sendActiveOperatorsViaSocket(message: any) {
    return this.server.emit('getActiveOperator', CoreApiResponse.success(message));
  }

  sendStopActionToClientViaSocket(consultationId: string, message: any) {
    return this.server
      .to(consultationId)
      .emit('stopConsultation', CoreApiResponse.success(message));
  }

  sendCallIn(
    consultationId: string,
    clientId: string,
    data: {
      roomId?: string;
      type: 'audio' | 'video';
      event: 'calling' | 'accept' | 'decline';
    },
  ) {
    return this.server
      .to(consultationId)
      .except(clientId) // Exclude the sender
      .emit('listingCall', CoreApiResponse.success(data));
  }

  sendRestoreCalculateOrderTimeViaSocket(message: any) {
    return this.server.emit('resetCalculateOrderTime', CoreApiResponse.success(message));
  }

  @SubscribeMessage('message')
  async sendMessageHandle(@MessageBody() data: CreateMessageDto, @ConnectedSocket() client: any) {
    if (!client?.consultationId) {
      const error = new NotFoundException('Consultation not found or already closed');
      const data = CoreApiResponse.error(error.getResponse());
      this.server.to(client.id).emit('error', data);
      return client.disconnect();
    }

    const existConsultation = await this.prisma.consultation.findFirst({
      where: {
        id: client?.consultationId,
      },
    });

    if (!existConsultation) {
      throw new BadRequestException('Consultation not found or already closed');
    }

    if (existConsultation.status === ConsultationStatus.NEW) {
      throw new BadRequestException('Can not send message');
    }

    return this.chatService.message(data, client.user);
  }

  @SubscribeMessage('call')
  async handleCallEvent(
    @MessageBody()
    data: {
      roomId?: string;
      consultationId: string;
      type: 'audio' | 'video';
      event: 'calling' | 'accept' | 'decline';
    },
    @ConnectedSocket() client: Socket | any,
  ) {
    const consultationId = data.consultationId || client?.consultationId;

    if (!consultationId) {
      const error = new NotFoundException('Consultation not found or already closed');
      const response = CoreApiResponse.error(error.getResponse());
      this.server.to(client.id).emit('error', response);
      return client.disconnect();
    }

    // if (!data?.roomId) {
    //   const error = new NotFoundException('Room ID not provided');
    //   const response = CoreApiResponse.error(error.getResponse());
    //   this.server.to(client.id).emit('error', response);
    //   return client.disconnect();
    // }

    const existConsultation = await this.prisma.consultation.findFirst({
      where: {
        id: client.consultationId,
      },
    });

    if (!existConsultation) {
      throw new BadRequestException('Consultation not found or already closed');
    }

    if (existConsultation.status !== ConsultationStatus.IN_PROGRESS) {
      throw new BadRequestException('Consultation is not active');
    }

    return this.sendCallIn(consultationId, client.id, data);
  }
}
