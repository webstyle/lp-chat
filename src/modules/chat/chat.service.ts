import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateChatDto } from './dto/chat.dto';
import { BotService } from '../bot/bot.service';
import {
  CreateDraftMessageDto,
  CreateMessageDto,
  CreatePaymentMessageDto,
  CreateRateMessageDto,
  GetMessagesByChatIdDto,
  PayTransactionDto,
} from './dto/message.dto';
import { CreateRatingDto } from './dto/create-rating.dto';
import { PaginationDto } from 'src/common/dto/pagination.dto';
import { objectId } from 'src/common/util/formate-message.util';
import { IUser } from 'src/common/interface/my-req.interface';
import { ConsultationStatus, ConsultationTransactionStatus, MessageTypeEnum } from './enum';
import { SocketGateway } from './socket.gateway';
import { existDoctorInfo, messagesQuery } from 'src/modules/prisma/query';

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly botService: BotService,
    private socket: SocketGateway,
  ) {}

  async test() {
    return this.socket.test();
  }

  async message(dto: CreateMessageDto, user: IUser) {
    const consultation = await this.prisma.consultation.findFirst({
      where: { id: dto.consultationId },
    });

    if (!consultation?.id) {
      throw new NotFoundException('Consultation not found');
    }

    let chat: any = await this.prisma.chat.findFirst({
      where: {
        clientId: user.id,
        status: { in: ['active', 'init'] },
        consultationId: dto.consultationId,
      },
      include: { messages: true },
    });

    if (!chat) {
      chat = await this.chatCreate(
        {
          consultationId: dto.consultationId,
          type: 'init',
        },
        user,
      );
    }

    for (const mes of dto?.messages) {
      // let file: any;
      // if (mes.fileId) {
      //   file = await this.prisma.file.findFirst({
      //     where: { id: mes.fileId },
      //   });
      //   if (!file) throw new NotFoundException('File not found');
      // }

      if (mes.type === MessageTypeEnum.Text && mes.content === '') {
        continue;
      }

      const message = await this.prisma.message.create({
        data: {
          authorId: user.id,
          chatId: chat.id,
          id: objectId(),
          content: mes.content,
          fileId: mes.fileId,
          type: mes.type,
          transactionId: mes.transactionId,
          rate: mes.rate || null,
          callDuration: mes.callDuration || null,
          repliedMessageId: mes.repliedMessageId,
          createdAt: mes.createdAt,
        },
        include: { chat: true },
      });

      if (chat.status == 'init') {
        const history: any = await this.getMessages({}, user);
        return history;
      }

      await this.botService.messageViaBot(message.id);
      await this.socket.sendMessageByClientViaSocket(dto.consultationId, mes);
    }

    return {
      success: true,
      chatId: chat.id,
      consultationId: chat.consultationId,
    };
  }

  async saveDraftMessage(dto: CreateDraftMessageDto, user: IUser) {
    const consultation = await this.prisma.consultation.findFirst({
      where: { id: dto.consultationId },
    });

    if (!consultation?.id) {
      throw new NotFoundException('Consultation not found');
    }

    let chat = await this.prisma.chat.findFirst({
      where: {
        id: consultation?.chatId,
        clientId: user.id,
        consultationId: dto.consultationId,
      },
      include: { messages: true },
    });

    if (!chat) {
      throw new NotFoundException('Chat not found');
    }

    const messages = [];
    for (const mes of dto?.messages) {
      let file: any;
      if (mes.fileId) {
        file = await this.prisma.file.findFirst({
          where: { id: mes.fileId },
        });
        if (!file) throw new NotFoundException('File not found');
      }

      messages.push({
        id: objectId(),
        authorId: user.id,
        chatId: chat.id,
        content: mes.content,
        fileId: mes.fileId,
        type: mes.type,
        transactionId: mes.transactionId,
        rate: mes.rate || null,
        repliedMessageId: mes.repliedMessageId,
        createdAt: mes.createdAt,
      });
    }

    await this.prisma.message.createMany({
      data: messages,
    });

    return {
      success: true,
      chatId: chat.id,
      consultationId: chat.consultationId,
    };
  }

  async startChatWithOperator(dto: CreateMessageDto, user: IUser, parentTrx = null) {
    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: dto.consultationId,
        status: ConsultationStatus.NEW,
        userId: user.userId,
        // operatorId: null,
        // chatId: null,
        // topicId: null,
      },
    });

    if (!consultation?.id) {
      throw new NotFoundException('Consultation not found');
    }

    const operator = await this.prisma.user.findFirst({
      where: {
        id: dto.operatorId,
        blockedAt: null,
        approvedAt: { not: null },
        telegramId: { not: null },
        shiftStatus: 'active',
        // operatorChats: { none: { status: 'active' } },
      },
      include: { rejectedChats: true },
    });

    if (!operator) {
      throw new NotFoundException('Operator not found');
    }

    return this.prisma.$transaction(async (trx) => {
      trx = parentTrx ? parentTrx : trx;

      let topic = await this.prisma.topic.findFirst({
        where: { name: 'other', isDeleted: false },
      });
      try {
        if (!topic) {
          topic = await trx.topic.create({
            data: {
              id: objectId(),
              name: 'other',
              description: 'other',
            },
          });
        }

        if (!topic) {
          throw new NotFoundException('Topic not found');
        }

        let chat: any;
        if (consultation?.chatId) {
          chat = await this.prisma.chat.findFirst({
            where: {
              id: consultation?.chatId,
              consultationId: consultation?.id,
              status: 'init',
            },
            include: { messages: true, topic: true, client: true },
          });

          if (!chat) {
            throw new NotFoundException('Chat not found');
          }

          await trx.chat.update({
            where: {
              id: chat?.id,
            },
            data: {
              operatorId: dto.operatorId,
              status: 'active',
            },
          });
        } else {
          chat = await trx.chat.create({
            data: {
              status: 'active',
              clientId: user.id,
              topicId: topic.id,
              consultationId: dto.consultationId,
              operatorId: operator?.id,
            },
            include: { messages: true, topic: true, client: true },
          });
        }

        let message: any = [
          {
            authorId: operator.id,
            chatId: chat.id,
            id: objectId(),
            content: 'Accept Operator',
            type: MessageTypeEnum.AcceptOperator,
            acceptDoctorId: operator?.doctorId,
          },
        ];

        for (const mes of dto.messages) {
          let file: any;
          if (mes.fileId) {
            file = await this.prisma.file.findFirst({
              where: { id: mes.fileId },
            });
            if (!file) throw new NotFoundException('File not found');
          }

          message.push({
            id: objectId(),
            authorId: user.id,
            chatId: chat.id,
            content: mes.content,
            fileId: mes.fileId,
            type: mes.type,
            transactionId: mes.transactionId,
            rate: mes.rate || null,
            repliedMessageId: mes.repliedMessageId,
            createdAt: mes.createdAt,
          });
        }

        await trx.message.createMany({
          data: message,
        });

        await trx.user.update({
          where: {
            id: operator.id,
          },
          data: {
            shiftStatus: 'inactive',
          },
        });

        await trx.consultation.update({
          where: {
            id: dto.consultationId,
          },
          data: {
            chatId: chat.id,
            operatorId: dto.operatorId,
            status: 1,
            // topicId: chat.topicId,
          },
        });

        // await this.botService.sendShowButton(operator, chat.client, chat.id, chat.topic.name);

        const existDoctorWithQuery: any = await existDoctorInfo(this.prisma, operator?.doctorId);

        if (!existDoctorWithQuery) {
          throw new NotFoundException('Doctor not found');
        }

        const sendMessage = {
          ...operator,
          specialties: existDoctorWithQuery?.specialties || null,
          sip: existDoctorWithQuery?.sip,
        };

        this.socket.sendMessageToAcceptOperator(chat?.consultationId, sendMessage);

        await this.botService.sendReceiveConversationButton(
          operator,
          chat.client,
          chat.id,
          chat.topic.name,
        );

        await this.getAllActiveOperators(trx);

        return {
          success: true,
          chatId: chat.id,
          consultationId: chat.consultationId,
        };
      } catch (error) {
        await this.prisma.$disconnect();
        throw error;
      }
    });
  }

  async payStartChatWithOperator(id: string, payload: PayTransactionDto, user: IUser) {
    const { paymentProvider, amount, transactionId } = payload;

    const transaction = await this.prisma.transactions.findFirst({
      where: { id: transactionId },
    });

    if (!transaction?.id && transaction.expiresAt <= new Date()) {
      throw new BadRequestException('Transaction expired');
    }

    return this.prisma.$transaction(async (trx) => {
      const consultation = await trx.consultation.update({
        where: { id },
        data: {
          isPayed: true,
          status: ConsultationStatus.IN_PROGRESS,
        },
      });

      const transaction = await trx.transactions.update({
        where: { id: transactionId },
        data: {
          status: ConsultationTransactionStatus.PAYED,
          payedAmount: amount,
          provider: paymentProvider,
        },
      });

      if (payload.startChat?.messages?.length >= 0) {
        payload.startChat.messages = [
          ...payload.startChat?.messages,
          {
            type: MessageTypeEnum.Payment,
            transactionId: payload.transactionId,
            content: 'Success payment',
          },
        ];
      }

      await this.startChatWithOperator(
        {
          ...payload.startChat,
          consultationId: id,
        },
        user,
        trx,
      );

      await this.getAllActiveOperators(trx);

      return { consultation, transaction };
    });
  }

  async savePaymentMessage(dto: CreatePaymentMessageDto, user: IUser) {
    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: dto.consultationId,
        status: ConsultationStatus.NEW,
        userId: user.userId,
        operatorId: null,
        chatId: null,
        // topicId: null,
      },
    });

    if (!consultation?.id) {
      throw new NotFoundException('Consultation not found');
    }

    let chat: any = await this.prisma.chat.findFirst({
      where: {
        clientId: user.id,
        status: { in: ['init'] },
        consultationId: dto.consultationId,
      },
      include: { messages: true },
    });

    let topic = await this.prisma.topic.findFirst({
      where: { name: 'other', isDeleted: false },
    });

    if (!topic) {
      topic = await this.prisma.topic.create({
        data: {
          name: 'other',
        },
      });
    }

    if (!chat) {
      chat = await this.prisma.chat.create({
        data: {
          id: objectId(),
          status: 'init',
          clientId: user.id,
          topicId: topic?.id,
          consultationId: dto.consultationId,
        },
      });
    }
    await this.prisma.consultation.update({
      where: {
        id: consultation.id,
      },
      data: {
        chatId: chat?.id,
        // topicId: topic?.id,
      },
    });

    return await this.prisma.message.create({
      data: {
        id: objectId(),
        authorId: user.id,
        chatId: chat.id,
        content: 'Accept payment',
        type: MessageTypeEnum.Payment,
        transactionId: dto.transactionId,
      },
      include: { chat: true },
    });
  }

  async saveRateMessage(dto: CreateRateMessageDto, user: IUser) {
    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: dto.consultationId,
        status: ConsultationStatus.IN_PROGRESS,
        userId: user.userId,
        operatorId: { not: null },
        chatId: { not: null },
        // topicId: { not: null },
      },
    });

    if (!consultation?.id) {
      throw new NotFoundException('Consultation not found');
    }

    let chat: any = await this.prisma.chat.findFirst({
      where: {
        clientId: user.id,
        status: { in: ['active'] },
        consultationId: dto.consultationId,
      },
      include: { messages: true },
    });

    return await this.prisma.message.create({
      data: {
        id: objectId(),
        authorId: user.id,
        chatId: chat.id,
        content: 'User rate',
        type: MessageTypeEnum.Rate,
        rate: dto.rate,
        rateComment: dto.comment,
      },
      include: { chat: true },
    });
  }

  async chatCreate(dto: CreateChatDto, user: IUser, trx = null) {
    trx = trx ? trx : this.prisma;

    if (dto.topicId) {
      const topic = await this.prisma.topic.findFirst({
        where: { id: dto.topicId, isDeleted: false },
      });
      if (!topic) throw new NotFoundException('Topic not found');
    } else {
      let topic = await this.prisma.topic.findFirst({
        where: { name: 'other', isDeleted: false },
      });
      if (!topic) {
        topic = await trx.topic.create({
          data: {
            id: objectId(),
            name: 'other',
            description: 'other',
          },
        });
      }
      dto.topicId = topic.id;
    }

    // if (dto.consultationId) {
    //   const consultation = await this.prisma.consultation.findFirst({
    //     where: { id: dto.consultationId },
    //   });

    //   if (!consultation?.id) throw new NotFoundException('Consultation not found');
    // }

    const chat = await this.prisma.chat.findFirst({
      where: {
        clientId: user.userId,
        consultationId: dto.consultationId,
        status: { in: ['active', 'init'] },
        isDeleted: false,
      },
      include: { messages: true, client: true, topic: true },
    });

    if (chat) return chat;

    return trx.chat.create({
      data: {
        id: objectId(),
        status: dto.type || 'init',
        clientId: user.id,
        topicId: dto.topicId,
        consultationId: dto.consultationId,
      },
      include: { messages: true, topic: true, client: true },
    });
  }

  async rate(dto: CreateRatingDto, user: IUser) {
    const chat = await this.prisma.chat.findFirst({
      where: { id: dto.chatId, clientId: user.id, isDeleted: false },
    });
    if (!chat) throw new NotFoundException('Chat not found');
    return this.prisma.rating.create({
      data: <any>{ ...dto, clientId: user.id },
    });
  }

  async getMessages(dto: PaginationDto, { id: clientId }: IUser) {
    const skip = ((dto.page || 1) - 1) * (dto.limit || 50);
    const activeChat = await this.prisma.chat.findMany({
      where: { clientId, status: { in: ['active', 'init'] }, isDeleted: false },
    });
    const messages = await this.prisma.message.findMany({
      where: { chat: { clientId }, isDeleted: false },
      include: {
        author: true,
        repliedMessage: { include: { file: true } },
        file: true,
        transaction: true,
        acceptDoctor: true,
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: dto.limit || 50,
    });
    return { activeChat, messages, success: true };
  }

  async getMessagesByChatId(dto: GetMessagesByChatIdDto) {
    const existConsultation = await this.prisma.consultation.findFirst({
      where: {
        id: dto?.consultationId,
      },
    });

    if (!existConsultation || !existConsultation?.chatId) {
      throw new NotFoundException('ChatId not found');
    }

    const getClient = await this.prisma.user.findFirst({
      where: {
        userId: existConsultation.userId,
      },
    });

    if (!getClient) {
      throw new NotFoundException('Consultation user not found');
    }

    const activeChat = await this.prisma.chat.findMany({
      select: {
        id: true,
        consultationId: true,
        status: true,
        clientId: true,
        operatorId: true,
        topicId: true,
      },
      where: {
        id: existConsultation.chatId,
        status: { in: ['active', 'init'] },
        isDeleted: false,
        OR: [
          {
            clientId: getClient.id,
          },
          {
            operatorId: existConsultation.operatorId,
          },
        ],
      },
    });

    // const messages = await this.prisma.message.findMany({
    //   select: {
    //     id: true,
    //     content: true,
    //     chatId: true,
    //     createdAt: true,
    //     updatedAt: true,
    //     type: true,
    //     rate: true,
    //     author: {
    //       select: {
    //         id: true,
    //         firstname: true,
    //         lastname: true,
    //         userId: true,
    //         doctorId: true,
    //       },
    //     },
    //     acceptDoctor: true,
    //     repliedMessage: {
    //       select: {
    //         id: true,
    //         chatId: true,
    //         file: true,
    //       },
    //     },
    //     file: true,
    //   },
    //   where: {
    //     chat: {
    //       OR: [
    //         {
    //           clientId: userId,
    //         },
    //         {
    //           operatorId: userId,
    //         },
    //       ],
    //     },
    //     isDeleted: false,
    //   },
    //   orderBy: [
    //     {
    //       createdAt: 'asc',
    //     },
    //   ],
    // });

    const messages = await messagesQuery(this.prisma, {
      clientId: getClient.id,
      operatorId: existConsultation.operatorId,
      consultationId: dto.consultationId,
    });

    return { activeChat, messages };
  }

  async getAllActiveOperators(trx = null) {
    trx = trx || this.prisma;
    const data: any[] = await trx.$queryRaw`
            SELECT chu.id,
                  chu.shift_status,
                  chu.user_id,
                  chu.doctor_id,
                  chu.firstname,
                  chu.lastname,
                  chu.phone
            FROM chat."user" AS chu
            WHERE chu.is_deleted IS FALSE
              AND chu.doctor_id IS NOT NULL
              AND chu.shift_status = 'active'
              AND NOT EXISTS (SELECT 1
                              FROM consultation.transactions AS ct
                              WHERE ct.operator_id = chu.id
                                AND ct.status = 0
                                AND ct.expires_at >= NOW())
            ORDER BY chu.last_chat_accept_date DESC;

    `;

    this.socket.sendActiveOperatorsViaSocket(data || []);

    return data;
  }

  // *** Методы аналитики ***

  async getChatStatistics() {
    const totalChats = await this.prisma.chat.count();
    const activeChats = await this.prisma.chat.count({
      where: { status: 'active', isDeleted: false },
    });
    const closedChats = await this.prisma.chat.count({
      where: { status: 'done', isDeleted: false },
    });
    const initiatedChats = await this.prisma.chat.count({
      where: { status: 'init', isDeleted: false },
    });
    const totalMessages = await this.prisma.message.count({
      where: { isDeleted: false },
    });

    return {
      totalChats,
      activeChats,
      closedChats,
      initiatedChats,
      totalMessages,
    };
  }

  async getMessageStatistics() {
    const clientMessages = await this.prisma.message.count({
      where: { author: { telegramId: null, isDeleted: false } },
    });
    const operatorMessages = await this.prisma.message.count({
      where: {
        author: { NOT: { telegramId: null } },
        isDeleted: false,
      },
    });

    return {
      totalMessages: clientMessages + operatorMessages,
      clientMessages,
      operatorMessages,
    };
  }

  async getOperatorAnalytics() {
    const activeOperators = await this.prisma.user.findMany({
      where: {
        shiftStatus: 'active',
        blockedAt: null,
        approvedAt: { not: null },
        isDeleted: false,
      },
      include: {
        operatorChats: {
          where: { status: 'active' },
        },
        rejectedChats: true,
      },
    });

    return activeOperators.map((operator) => ({
      operatorId: operator.id,
      name: `${operator?.firstname} ${operator?.lastname}`,
      activeChats: operator.operatorChats.length,
      rejectedChats: operator.rejectedChats.length,
    }));
  }

  async getAverageResponseTime() {
    const chatsWithMessages = await this.prisma.chat.findMany({
      where: {
        OR: [{ status: 'active' }, { status: 'done' }],
        isDeleted: false,
      },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { author: true },
        },
      },
    });

    let totalResponseTime = 0;
    let responseCount = 0;

    chatsWithMessages.forEach((chat) => {
      const firstClientMessage = chat.messages.find((msg) => msg.author.telegramId == null);
      const firstOperatorMessage = chat.messages.find((msg) => msg.author.telegramId != null);

      if (firstClientMessage && firstOperatorMessage) {
        const responseTime =
          firstOperatorMessage.createdAt.getTime() - firstClientMessage.createdAt.getTime();
        totalResponseTime += responseTime;
        responseCount++;
      }
    });

    const averageResponseTime = responseCount ? totalResponseTime / responseCount : 0;
    return { averageResponseTime };
  }

  async getRatingAnalytics() {
    const totalRatings = await this.prisma.rating.count({
      where: { isDeleted: false },
    });
    const averageRating = await this.prisma.rating.aggregate({
      _avg: {
        rate: true,
      },
    });

    return {
      totalRatings,
      averageRating: averageRating._avg.rate,
    };
  }

  async getRejectedChatAnalytics() {
    const rejectedChats = await this.prisma.rejectedChat.count({
      where: { isDeleted: false },
    });
    const rejectedChatsByOperator = await this.prisma.rejectedChat.groupBy({
      where: { isDeleted: false },
      by: ['operatorId'],
      _count: {
        operatorId: true,
      },
      orderBy: {
        _count: {
          operatorId: 'desc',
        },
      },
    });

    return {
      totalRejectedChats: rejectedChats,
      rejectedChatsByOperator,
    };
  }

  checkingMessageType(data: { fileId?: string; content?: string }, file?: any): string | null {
    const { fileId, content } = data;

    if (content && !fileId && !file?.id) {
      return MessageTypeEnum.Text;
    } else if (fileId && file?.id) {
      if (file?.type.includes('image')) {
        return MessageTypeEnum.Photo;
      } else return MessageTypeEnum.Document;
    }

    return null;
  }
}
