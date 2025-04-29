import { InjectBot } from '@grammyjs/nestjs';
import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Bot, Context } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { SocketGateway } from '../chat/socket.gateway';
import { ConsultationStatus, MessageTypeEnum } from '../chat/enum';
import { existDoctorInfo } from '../prisma/query';
import { ChatService } from '../chat/chat.service';
import { BotService } from './bot.service';
import { IUser } from 'src/common/interface/my-req.interface';
import { StopConsultationAndChatDto } from '../chat/dto/chat.dto';
import { objectId } from 'src/common/util/formate-message.util';
import { Cron } from '@nestjs/schedule';

@Injectable()
export class BotHttpService {
  constructor(
    @InjectBot() private readonly bot: Bot<Context>,
    private readonly prisma: PrismaService,
    private readonly socketGateWay: SocketGateway,
    private readonly botService: BotService,

    @Inject(forwardRef(() => ChatService))
    private chatService: ChatService,
  ) {}

  async takeNextClient(operatorTelegramId: string, operator: any, order: any, trx: any) {
    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: order.consultationId,
        chatId: { not: null },
        status: ConsultationStatus.NEW,
      },
    });

    if (!consultation) {
      return this.bot.api.sendMessage(
        operatorTelegramId,
        'Consultation data is missing or invalid.',
      );
    }

    const getClient = await this.prisma.user.findFirst({
      where: { userId: consultation.userId, isDeleted: false, doctorId: null },
    });

    if (!getClient) {
      return this.bot.api.sendMessage(operatorTelegramId, 'Queue user not found');
    }

    // Update next chat status
    const chat = await trx.chat.update({
      where: {
        id: consultation.chatId,
      },
      data: {
        operatorId: operator.id,
        status: 'active',
      },
    });

    if (!chat) {
      return this.bot.api.sendMessage(operatorTelegramId, 'Chat data is missing or invalid.');
    }

    // Update next consultation status
    await trx.consultation.update({
      where: { id: consultation.id },
      data: {
        // update consultation
        chatId: chat.id,
        status: ConsultationStatus.IN_PROGRESS,
        operatorId: operator.id,
        chatStartedAt: new Date(),
      },
    });

    // Update next consultation order status
    await trx.consultationOrder.update({
      where: {
        id: order.id,
      },
      data: {
        operatorId: operator.id,
        status: 'active',
      },
    });

    // Send message waiting client
    const existDoctorWithQuery: any = await existDoctorInfo(trx, operator?.doctorId);

    if (!existDoctorWithQuery) {
      throw new NotFoundException('Doctor not found');
    }

    const sendMessage = {
      ...operator,
      specialties: existDoctorWithQuery?.specialties || null,
      sip: existDoctorWithQuery?.sip,
    };

    this.socketGateWay.sendMessageToAcceptOperator(chat?.consultationId, sendMessage);

    return this.botService.sendReceiveConversationButton(
      operator,
      getClient,
      chat.id,
      chat?.topic?.name,
    );
  }

  async stopDialogHttp(dto: StopConsultationAndChatDto, user: IUser) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: { not: null },
        approvedAt: { not: null },
        doctorId: user.doctorId,
        // shiftStatus: 'inactive',
      },
    });

    if (!operator) {
      throw new NotFoundException('Not found operator with telegramId');
    }

    const operatorTelegramId = operator.telegramId;

    const recentChat = await this.prisma.chat.findFirst({
      where: {
        operatorId: operator.id,
        status: 'active',
        consultationId: { not: null },
      },
      include: { client: true },
    });

    if (!recentChat?.consultationId) {
      return this.bot.api.sendMessage(operatorTelegramId, 'No active chats');
    }

    const recentConsultationOrder = await this.prisma.consultationOrder.findFirst({
      where: {
        consultationId: recentChat?.consultationId,
        status: 'active',
      },
    });

    const recentConsultationBooking = await this.prisma.consultationBooking.findFirst({
      where: {
        consultationId: recentChat.consultationId,
        status: 'active',
      },
    });

    // Return all socket client information about active operators
    await this.chatService.getAllActiveOperators();

    return this.prisma.$transaction(async (trx) => {
      // Recent chat status done
      await trx.chat.update({
        where: { id: recentChat.id },
        data: { status: 'done' },
      });

      // Recent chat consultation status finished
      const data = await trx.consultation.update({
        where: {
          id: recentChat?.consultationId,
        },
        data: {
          status: ConsultationStatus.FINISHED,
          chatId: recentChat?.id,
        },
      });

      if (dto.fileId || dto.content) {
        // This logic last message this is doctor recommend
        const message = await trx.message.create({
          data: {
            id: objectId(),
            authorId: user.id,
            chatId: recentChat.id,
            content: dto.content,
            fileId: dto.fileId,
            type: MessageTypeEnum.RecommendDoctor,
          },
          include: {
            chat: { include: { operator: true, topic: true } },
            file: true,
            author: true,
            repliedMessage: true,
          },
        });

        if (message) {
          this.socketGateWay.sendMessageByOperatorViaSocket(recentChat?.consultationId, message);
        }

        await this.botService.messageViaBot(message.id, trx);
      }

      this.socketGateWay.sendStopActionToClientViaSocket(recentChat?.consultationId, data);

      const text = `Dialog with *${recentChat?.client?.firstname} ${recentChat?.client?.lastname}* stopped`;
      await this.bot.api.sendMessage(operatorTelegramId, text, { parse_mode: 'MarkdownV2' });

      if (recentConsultationOrder?.id) {
        // Recent active consultation finished
        await trx.consultationOrder.update({
          where: {
            id: recentConsultationOrder?.id,
          },
          data: {
            status: 'done',
          },
        });
      }

      if (recentConsultationBooking?.id) {
        // Recent active consultation booking finished
        await trx.consultationBooking.update({
          where: {
            id: recentConsultationBooking?.id,
          },
          data: {
            status: 'done',
          },
        });
      }

      const existBooking = await this.botService.checkOperatorBookingTime(operator);

      // This logic get next order client
      const nextOrderClient = await this.prisma.consultationOrder.findFirst({
        where: { status: 'waiting', operatorId: null },
        orderBy: { order: 'asc' },
        select: { id: true, consultationId: true },
      });

      if (existBooking) {
        await this.bot.api.sendMessage(
          operatorTelegramId,
          `You have a booking at ${existBooking.start_time}. Please be prepared.`,
          {
            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text: "I'm Ready",
                    callback_data: `get_booking$${existBooking.booking_id}`,
                  },
                ],
              ],
            },
          },
        );
      } else if (nextOrderClient && !existBooking) {
        await this.bot.api.sendMessage(operatorTelegramId, 'Have next order client', {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "I'm ready take next client",
                  callback_data: `take_next_client$${nextOrderClient.consultationId}`,
                },
              ],
            ],
          },
        });
      } else if (!nextOrderClient && !existBooking) {
        // If not have client in queue update operator status
        await trx.user.update({
          where: { id: operator?.id },
          data: {
            shiftStatus: 'active',
          },
        });
      }

      this.socketGateWay.sendRestoreCalculateOrderTimeViaSocket({ operatorId: operator.id });
      return this.socketGateWay.disconnectChatMembers(recentChat?.consultationId);
    });
  }

  async checkAndNotifyInactiveChats() {
    const activeChats = await this.prisma.chat.findMany({
      where: {
        status: 'active',
      },
      include: {
        operator: {
          select: {
            telegramId: true,
          },
          where: {
            telegramId: { not: null },
            doctorId: { not: null },
            approvedAt: { not: null },
          },
        },
        client: true,
      },
    });

    const operatorIds = activeChats.map((chat) => chat.operator?.telegramId);

    for (const chat of activeChats) {
      if (chat.operator?.telegramId) {
        await this.bot.api.sendMessage(
          chat.operator.telegramId,
          `You have an active chat with ${chat?.client?.firstname} ${chat?.client?.lastname}. Please respond promptly and conclude the conversation to update your status to inactive.`,
        );
      }
    }

    return operatorIds;
  }

  @Cron('0 0/5 13-18,0-3 * * *', {
    timeZone: 'Asia/Tashkent',
  })
  async handleCron() {
    await this.checkAndNotifyInactiveChats();
  }
}
