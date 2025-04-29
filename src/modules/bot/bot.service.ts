import { InjectBot } from '@grammyjs/nestjs';
import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Bot, Context, InputFile, Keyboard } from 'grammy';
import { PrismaService } from '../prisma/prisma.service';
import { chatstatus, file, shiftStatus, user } from '@prisma/client';
import { FileService } from '../file/file.service';
import { extname } from 'path';
import { getFileUrl } from 'src/common/util/get-tg-file-url.util';
import axios from 'axios';
import { BufferedFile } from 'src/common/interface/buffered-file.interface';
import { pathToStatic } from 'src/common/var/index.var';
import { formatMessage, objectId } from 'src/common/util/formate-message.util';
import { usersWithChats } from 'src/common/type/usersWithChats.type';
import { SocketGateway } from '../chat/socket.gateway';
import { ConsultationStatus, MessageTypeEnum } from '../chat/enum';
import { existDoctorInfo } from '../prisma/query';
import { ChatService } from '../chat/chat.service';
import * as moment from 'moment';

@Injectable()
export class BotService {
  constructor(
    @InjectBot() private readonly bot: Bot<Context>,
    private readonly prisma: PrismaService,
    private readonly fileService: FileService,
    private readonly socketGateWay: SocketGateway,
    @Inject(forwardRef(() => ChatService))
    private chatService: ChatService,
  ) {}

  async onStart(ctx: Context): Promise<void> {
    const commands = [
      { command: 'start', description: 'Start the bot 🚀' },
      { command: 'online', description: "I'm ready to get a new client ✅" },
      { command: 'offline', description: "I'm not available for new clients ❌" },
      { command: 'queue', description: 'Connecting to a client in the queue 🚶‍♂️🚶‍♀️' },
      { command: 'getbooking', description: 'Get your booking details 📅' },
    ];
    await this.bot.api.setMyCommands(commands);
    ctx.reply(`Hey, ${ctx.from.first_name}. I'm ${this.bot.botInfo.first_name}`, {
      reply_markup: {
        inline_keyboard: [
          [{ callback_data: 'register', text: 'Register' }],
          [{ callback_data: 'online', text: 'Online' }],
          [{ callback_data: 'offline', text: 'Offline' }],
          [{ callback_data: 'stopdialog', text: 'Stop Dialog' }],
        ],
      },
    });
  }

  async commandStart(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        isDeleted: false,
      },
    });

    if (!operator) {
      return ctx.reply('Please /register and (or) wait administrator to approve');
    }

    const chat = await this.prisma.chat.findFirst({
      where: {
        operatorId: operator.id,
        status: chatstatus.active,
      },
    });

    if (chat) {
      return ctx.reply('You have active chat');
    }

    const getNotAssignBookingClient = await this.prisma.consultationBooking.findFirst({
      where: {
        operatorId: null,
        status: 'new',
      },
      orderBy: {
        startTime: 'asc',
      },
    });

    const existBooking = await this.checkOperatorBookingTime(operator);

    if (existBooking) {
      await this.prisma.user.update({
        where: { id: operator.id },
        data: { shiftStatus: shiftStatus.inactive },
      });

      return ctx.reply(`You have a booking at ${existBooking.start_time}. Please be prepared.`, {
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
      });
    }

    return this.prisma.$transaction(async (trx) => {
      if (getNotAssignBookingClient?.id && !existBooking) {
        await trx.consultationBooking.update({
          where: { id: getNotAssignBookingClient.id },
          data: {
            operatorId: operator.id,
          },
        });

        const existBooking = await this.checkOperatorBookingTime(operator, trx);

        if (existBooking) {
          await this.prisma.user.update({
            where: { id: operator.id },
            data: { shiftStatus: shiftStatus.inactive },
          });

          return ctx.reply(
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
        }
      }

      if (operator.shiftStatus == shiftStatus.active) {
        ctx.reply(`You've already activated your status`);
        return;
      }

      await trx.shift.create({
        data: { status: shiftStatus.active, operatorId: operator.id },
      });

      await trx.user.update({
        where: { id: operator.id, isDeleted: false },
        data: { shiftStatus: shiftStatus.active },
      });

      this.chatService.getAllActiveOperators(trx);

      return await ctx.reply(`You've activated your status`);
    });
  }

  async commandEnd(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        isDeleted: false,
      },
    });

    if (!operator) {
      return ctx.reply('Please /register and (or) wait administrator to approve');
    }

    const chat = await this.prisma.chat.findFirst({
      where: {
        operatorId: operator.id,
        status: 'active',
      },
    });

    if (chat) {
      return ctx.reply(`You don't have an active chat. Can't stop it`);
    }

    await this.prisma.user.update({
      where: { id: operator.id, isDeleted: false },
      data: { shiftStatus: shiftStatus.inactive },
    });

    const existBooking = await this.checkOperatorBookingTime(operator);

    if (existBooking) {
      return ctx.reply(`You have a booking at ${existBooking.start_time}. Please be prepared.`, {
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
      });
    }

    this.chatService.getAllActiveOperators();

    return await ctx.reply(`You've inactivated your status`);
  }

  async commandQueue(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        blockedAt: null,
        approvedAt: { not: null },
        // operatorChats: { none: { status: 'active' } },
      },
      include: { rejectedChats: true },
    });

    if (!operator?.id) {
      return ctx.reply('Please /register and(or) wait for the administrator to approve');
    }

    if (operator.shiftStatus !== shiftStatus.active) {
      return ctx.reply('You are not active. Please activate your status first.');
    }

    const existBooking = await this.checkOperatorBookingTime(operator);

    if (existBooking) {
      return ctx.reply(`You have a booking at ${existBooking.start_time}. Please be prepared.`, {
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
      });
    }

    const nextQueueConsultation = await this.prisma.consultationOrder.findFirst({
      where: { status: 'waiting', operatorId: null },
      orderBy: { order: 'asc' },
      select: { id: true, consultationId: true },
    });

    if (!nextQueueConsultation) {
      return ctx.reply('No waiting orders are available.');
    }

    const nextOrderConsultation = await this.prisma.consultation.findFirst({
      where: { id: nextQueueConsultation.consultationId, chatId: { not: null } },
    });

    if (!nextOrderConsultation) {
      return ctx.reply('Consultation data is missing or invalid.');
    }

    const operatorRecentActiveChat = await this.prisma.chat.findFirst({
      where: {
        status: 'active',
        isDeleted: false,
        operatorId: operator.id,
      },
      include: { client: true, topic: true },
    });

    if (operatorRecentActiveChat) {
      return ctx.reply(`Cannot get a new client dialog open`);
    }

    const getClient = await this.prisma.user.findFirst({
      where: { userId: nextOrderConsultation.userId, isDeleted: false, doctorId: null },
    });

    if (!getClient) {
      return ctx.reply('Client not found or already deleted');
    }

    const nextOrderConsultationChat = await this.prisma.chat.findFirst({
      where: {
        id: nextOrderConsultation?.chatId,
        consultationId: nextOrderConsultation.id,
        isDeleted: false,
      },
      include: { client: true, topic: true },
    });

    if (!nextOrderConsultationChat) {
      return ctx.reply('Chat data is missing or invalid.');
    }

    // next chat assign to this operator and update status
    await this.prisma.chat.update({
      where: {
        id: nextOrderConsultationChat.id,
      },
      data: {
        status: 'active',
        operatorId: operator?.id,
      },
    });

    // Update queue consultation status and assign this operator
    await this.prisma.consultationOrder.update({
      where: { id: nextQueueConsultation.id },
      data: {
        status: 'active',
        operatorId: operator?.id,
      },
    });

    const existDoctorWithQuery: any = await existDoctorInfo(this.prisma, operator?.doctorId);

    if (!existDoctorWithQuery) {
      throw new NotFoundException('Doctor not found');
    }

    await this.sendReceiveConversationButton(
      operator,
      getClient,
      nextOrderConsultationChat.id,
      nextOrderConsultationChat.topic.name,
    );

    const sendMessage = {
      ...operator,
      specialties: existDoctorWithQuery?.specialties || null,
      sip: existDoctorWithQuery?.sip,
    };

    return this.socketGateWay.sendMessageToAcceptOperator(nextOrderConsultation.id, sendMessage);
  }

  async takeNextClient(ctx: Context, trx = null) {
    trx = trx || this.prisma;
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        blockedAt: null,
        approvedAt: { not: null },
        shiftStatus: shiftStatus.inactive,
      },
      include: { rejectedChats: true },
    });

    if (!operator?.id) {
      return ctx.reply('You are not in the active status');
    }

    // This logic get next order client
    const order = await this.prisma.consultationOrder.findFirst({
      where: { status: 'waiting', operatorId: null },
      orderBy: { order: 'asc' },
      select: { id: true, consultationId: true },
    });

    if (!order) {
      return ctx.reply('No waiting orders are available. You can change your status to active');
    }

    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: order.consultationId,
        chatId: { not: null },
        status: ConsultationStatus.NEW,
      },
    });

    if (!consultation) {
      return ctx.reply('Consultation data is missing or invalid.');
    }

    const getClient = await this.prisma.user.findFirst({
      where: { userId: consultation.userId, isDeleted: false, doctorId: null },
    });

    if (!getClient) {
      return ctx.reply('Queue user not found');
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
      return ctx.reply('Chat data is missing or invalid.');
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

    return this.sendReceiveConversationButton(operator, getClient, chat.id, chat?.topic?.name);
  }

  async commandStop(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        isDeleted: false,
      },
    });
    if (!operator) {
      return ctx.reply('Please /register and(or) wait administrator to approve');
    }
    const chat = await this.prisma.chat.findFirst({
      where: {
        operatorId: operator.id,
        status: 'active',
        isDeleted: false,
        consultationId: { not: null },
      },
    });

    if (chat) {
      return ctx.reply(`Cannot leave dialog open`);
    }

    if (operator.shiftStatus == 'inactive' || operator.shiftStatus == null) {
      return ctx.reply(`You've already deactivated your status`);
    }

    await this.prisma.shift.create({
      data: { status: 'inactive', operatorId: operator.id },
    });

    await this.prisma.user.update({
      where: { id: operator.id, isDeleted: false },
      data: { shiftStatus: 'inactive' },
    });

    return ctx.reply(`You've deactivated your status`);
  }

  async register(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: { telegramId: ctx.from.id.toString(), isDeleted: false },
    });

    if (operator) {
      return ctx.reply('Application already saved. Please wait for administrator to approve');
    }

    const contactButton = Keyboard.requestContact('Share Contact');
    return await ctx.reply('Send your contact', {
      reply_markup: {
        one_time_keyboard: true,
        keyboard: [[contactButton]],
        resize_keyboard: true,
      },
    });
  }

  async contact(ctx: Context, contact: any) {
    contact.phone_number = contact.phone_number.replace('+', '');
    const [exitDoc]: any = await this.prisma.$queryRaw`
        select *
        from doctor.doctors as d
        where d.is_deleted is false
          and d.is_verified is true
          and d.role = 'operator'
          and d.phone_number = ${contact.phone_number}
        limit 1;
      `;

    if (!exitDoc) {
      return ctx.reply('Your number is not registered as an operator on the davoai.uz platform.', {
        reply_markup: { remove_keyboard: true },
      });
    }

    const operator = await this.prisma.user.findFirst({
      where: {
        OR: [{ telegramId: ctx.from.id.toString() }, { phone: contact.phone_number }],
        isDeleted: false,
      },
    });

    if (operator) {
      await this.prisma.user.update({
        where: {
          id: operator.id,
        },
        data: {
          firstname: exitDoc.first_name,
          lastname: exitDoc.last_name,
          phone: contact.phone_number,
          telegramId: ctx.from.id.toString(),
          username: ctx.from.username,
          doctorId: exitDoc?.id,
          createdBy: exitDoc.id,
          email: exitDoc.email,
        },
      });
      return ctx.reply('If you want to change your phone number, please contact administration', {
        reply_markup: { remove_keyboard: true },
      });
    }

    await this.prisma.user.create({
      data: {
        firstname: exitDoc.first_name,
        lastname: exitDoc.last_name,
        phone: contact.phone_number,
        telegramId: ctx.from.id.toString(),
        username: ctx.from.username,
        doctorId: exitDoc?.id,
        createdBy: exitDoc.id,
        email: exitDoc.email,
      },
    });
    ctx.reply('Application successfully saved. Please wait for administrator to approve', {
      reply_markup: { remove_keyboard: true },
    });
  }

  async sendReceiveConversationButton(
    operator: usersWithChats,
    client: user,
    chatId: string,
    topic: string,
  ) {
    return this.bot.api.sendMessage(
      operator.telegramId,
      `From: *${client?.firstname} ${client?.lastname}*\nTopic: _${topic}_
        `,
      {
        reply_markup: {
          inline_keyboard: [[{ text: 'Show client messages', callback_data: `receive$${chatId}` }]],
          one_time_keyboard: true,
        },
        parse_mode: 'MarkdownV2',
      },
    );
  }

  async sendShowButton(operator: usersWithChats, client: user, chatId: string, topic: string) {
    await this.bot.api.sendMessage(
      operator.telegramId,
      `From: *${client?.firstname} ${client?.lastname}*\nTopic: _${topic}_
        `,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Show client messages', callback_data: `receive$${chatId}` }],
            // [{ text: 'Reject', callback_data: `reject$${chatId}` }],
          ],
          one_time_keyboard: true,
        },
        parse_mode: 'MarkdownV2',
      },
    );

    return {
      success: true,
    };
  }

  async receive(ctx: Context, chatId: string) {
    const chat = await this.prisma.chat.findFirst({
      where: {
        id: chatId,
        operatorId: null,
        isDeleted: false,
      },
      include: { topic: true },
    });

    if (!chat) {
      return ctx.editMessageText('Chat already started with other operator');
    }

    if (!chat?.consultationId) {
      return ctx.editMessageText('User consultation not found');
    }

    const operator = await this.prisma.user.findFirst({
      where: { telegramId: ctx.from.id.toString(), isDeleted: false },
    });

    await this.prisma.chat.update({
      where: { id: chat.id },
      data: { operatorId: operator.id, status: 'active' },
    });
    const { firstname, lastname } = await this.prisma.user.findFirst({
      where: { id: chat.clientId, isDeleted: false },
    });
    const messages = await this.prisma.message.findMany({
      where: { chatId: chat.id, isDeleted: false },
      include: { file: true },
      orderBy: { createdAt: 'asc' },
    });
    const editedMsgText = `Chat started with *${firstname} ${lastname}*`;
    await ctx.editMessageText(editedMsgText, { parse_mode: 'MarkdownV2' });

    if (!chat.consultationId) {
      throw new NotFoundException('Consultation not found');
    }

    await this.prisma.$transaction(async (trx) => {
      await trx.consultation.update({
        where: { id: chat.consultationId },
        data: {
          chatId: chat.id,
          operatorId: operator.id,
          // topicId: chat.topicId,
          chatStartedAt: new Date(),
          status: ConsultationStatus.IN_PROGRESS,
        },
      });

      for (const message of messages) {
        const formattedMessage = formatMessage({
          firstname,
          lastname,
          topic: chat.topic.name,
          message: message.content,
        });
        if (message.file) {
          await this.fileToBot(ctx.from.id, message.file, formattedMessage, null);
          continue;
        }

        await ctx.reply(formattedMessage, { parse_mode: 'MarkdownV2' });
        this.socketGateWay.sendMessageToAcceptOperator(chat?.consultationId, operator);
      }

      await trx.user.update({
        where: { id: operator?.id },
        data: {
          shiftStatus: 'inactive',
        },
      });
    });
  }

  async showMessageButton(ctx: Context, chatId: string) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        doctorId: { not: null },
        blockedAt: null,
        isDeleted: false,
      },
    });

    if (!operator) {
      return ctx.reply('You have no right');
    }

    const chat = await this.prisma.chat.findFirst({
      where: {
        id: chatId,
        status: 'active',
        isDeleted: false,
        consultationId: { not: null },
        operatorId: { not: null },
      },
      include: { topic: true },
    });

    if (!chat) {
      return ctx.editMessageText('Chat already started with other operator');
    }

    const { firstname, lastname } = await this.prisma.user.findFirst({
      where: { id: chat.clientId, isDeleted: false },
    });

    const messages = await this.prisma.message.findMany({
      where: { chatId: chat.id, isDeleted: false },
      include: { file: true },
      orderBy: { createdAt: 'asc' },
    });

    const editedMsgText = `Chat started with *${firstname} ${lastname}*`;
    await ctx.editMessageText(editedMsgText, { parse_mode: 'MarkdownV2' });

    return this.prisma.$transaction(async (trx) => {
      // Update operator inactive
      await this.prisma.user.update({
        where: { id: operator?.id },
        data: {
          shiftStatus: 'inactive',
        },
      });

      // Update consultation status
      await trx.consultation.update({
        where: { id: chat.consultationId },
        data: {
          chatId: chat.id,
          operatorId: operator.id,
          chatStartedAt: new Date(),
          status: ConsultationStatus.IN_PROGRESS,
        },
      });

      // This message add this logic
      await trx.message.create({
        data: {
          authorId: operator.id,
          chatId: chat.id,
          id: objectId(),
          content: 'Accept Operator',
          type: MessageTypeEnum.AcceptOperator,
          acceptDoctorId: operator?.doctorId,
        },
      });

      for (const message of messages) {
        const formattedMessage = formatMessage({
          firstname,
          lastname,
          topic: chat.topic.name,
          message: message.content,
        });
        if (message.file) {
          await this.fileToBot(ctx.from.id, message.file, formattedMessage, null);
          continue;
        }

        await ctx.reply(formattedMessage, { parse_mode: 'MarkdownV2' });
      }
    });
  }

  async handleMessage(ctx: Context, file?: { fileId: string; mimetype: string }, caption?: string) {
    let messageType = null;

    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        blockedAt: null,
        isDeleted: false,
      },
    });

    if (!operator) return ctx.reply('You have no right');

    const activeChat = await this.prisma.chat.findFirst({
      where: {
        status: 'active',
        operatorId: operator.id,
        isDeleted: false,
      },
    });

    if (!activeChat) {
      return ctx.reply('No active chats');
    }

    if (!activeChat?.consultationId) {
      return ctx.reply('Client consultation not found');
    }

    const consultation = await this.prisma.consultation.findFirst({
      where: {
        id: activeChat.consultationId,
        chatId: activeChat?.id,
        status: { in: [ConsultationStatus.NEW, ConsultationStatus.IN_PROGRESS] },
      },
    });

    if (!consultation) {
      throw new NotFoundException('Active or new consultation not found');
    }

    const tgMessageId = ctx.update?.message?.message_id;
    // let repliedMessageId: string;

    // const repliedMessageTgId = ctx.update?.message?.reply_to_message?.message_id;
    // if (repliedMessageTgId) {
    //   const repliedMessage = await this.prisma.message.findFirst({
    //     where: { tgMsgId: repliedMessageTgId.toString(), isDeleted: false },
    //   });
    //   repliedMessageId = repliedMessage?.id || null;
    // }

    const content = ctx.message?.text || caption || null;

    if (content && !file?.fileId) {
      messageType = MessageTypeEnum.Text;
    } else if (file?.fileId && file?.mimetype && file?.mimetype?.includes('image')) {
      messageType = MessageTypeEnum.Photo;
    } else if (file?.fileId && file?.mimetype && file?.mimetype?.includes('telegram')) {
      messageType = MessageTypeEnum.Document;
    }

    const message = await this.prisma.message.create({
      data: {
        authorId: operator.id,
        chatId: activeChat.id,
        content,
        fileId: file?.fileId,
        // repliedMessageId,
        tgMsgId: tgMessageId.toString(),
        type: messageType,
      },
      select: {
        id: true,
        content: true,
        chatId: true,
        createdAt: true,
        updatedAt: true,
        type: true,
        author: {
          select: {
            id: true,
            firstname: true,
            lastname: true,
          },
        },
        repliedMessage: {
          select: {
            id: true,
            chatId: true,
            file: true,
          },
        },
        file: true,
      },
    });

    return this.socketGateWay.sendMessageByOperatorViaSocket(consultation?.id, message);
  }

  async fileToAPI(ctx: Context): Promise<{ fileId: string; caption: string; mimetype: string }> {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        blockedAt: null,
        isDeleted: false,
      },
    });

    const file = await ctx.getFile();
    const caption = ctx.update.message.caption;
    const url = getFileUrl(file.file_path);
    const res = await axios.get(url, { responseType: 'arraybuffer' });

    const mimetype = file.file_path.includes('photo')
      ? `image/${extname(file?.file_path).replace('.', '')}`
      : 'telegram/file';

    const uploadingData: BufferedFile = {
      buffer: res.data,
      fieldName: file.file_id,
      mimetype,
      encoding: null,
      originalname: file.file_path.split('/')[1],
      size: file.file_size,
    };

    const uploadedFile = await this.fileService.upload(uploadingData, {
      id: operator.id,
      userId: operator.userId,
      doctorId: operator.doctorId,
    });
    return { fileId: uploadedFile.id, caption, mimetype };
  }

  async fileToBot(tgUserId: number, file: file, content: string, replyParams: any) {
    await this.fileService.downloadToStatic(file.id);
    const filename = `${file.id}${extname(file.name)}`;
    const inputFile = new InputFile(pathToStatic + filename);

    await this.bot.api.sendDocument(tgUserId, inputFile, {
      reply_parameters: replyParams,
      caption: content,
      parse_mode: 'MarkdownV2',
    });
    await this.fileService.deleteFromStatic(pathToStatic + filename);
  }

  async messageViaBot(messageId: string, trx = null) {
    trx = trx || this.prisma;
    const message = await trx.message.findFirst({
      where: {
        id: messageId,
      },
      include: {
        chat: { include: { operator: true, topic: true } },
        file: true,
        author: true,
        repliedMessage: true,
      },
    });

    const operator = message.chat.operator;
    const { firstname, lastname } = message.author;
    const topic = message.chat.topic;
    const formattedMessage = formatMessage({
      firstname,
      lastname,
      message: message.content,
      topic: topic.name,
    });
    const replyParameters = message.repliedMessageId
      ? { message_id: +message.repliedMessage.tgMsgId }
      : null;
    if (message.fileId) {
      return await this.fileToBot(
        +operator.telegramId,
        message.file,
        formattedMessage,
        replyParameters,
      );
    }
    const messageFromTg = await this.bot.api.sendMessage(+operator.telegramId, formattedMessage, {
      parse_mode: 'MarkdownV2',
      reply_parameters: replyParameters,
    });

    await trx.message.update({
      where: { id: message.id },
      data: { tgMsgId: messageFromTg.message_id.toString() },
    });
  }

  async stopDialog(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        shiftStatus: 'inactive',
      },
    });

    if (!operator) return;
    const chat = await this.prisma.chat.findFirst({
      where: { operatorId: operator.id, status: 'active' },
      include: { client: true },
    });
    if (!chat) return ctx.reply('No active chats');
    this.socketGateWay.disconnectChatMembers(chat.id);

    await this.prisma.chat.update({
      where: { id: chat.id },
      data: { status: 'done' },
    });

    if (chat?.consultationId) {
      const data = await this.prisma.consultation.update({
        where: {
          id: chat?.consultationId,
        },
        data: {
          status: ConsultationStatus.FINISHED,
        },
      });
      this.socketGateWay.sendStopActionToClientViaSocket(chat?.consultationId, data);
    }

    await this.prisma.user.update({
      where: {
        id: operator?.id,
      },
      data: {
        shiftStatus: 'active',
      },
    });

    const text = `Dialog with *${chat?.client?.firstname} ${chat?.client?.lastname}* stopped`;
    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
    await this.commandQueue(ctx);
  }

  async stopDialogAndTakeNextQueue(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
        // shiftStatus: 'inactive',
      },
    });

    if (!operator) return;

    const recentChat = await this.prisma.chat.findFirst({
      where: {
        operatorId: operator.id,
        status: 'active',
        consultationId: { not: null },
      },
      include: { client: true },
    });

    if (!recentChat?.consultationId) {
      return ctx.reply('No active chats');
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

      this.socketGateWay.sendStopActionToClientViaSocket(recentChat?.consultationId, data);

      const text = `Dialog with *${recentChat?.client?.firstname} ${recentChat?.client?.lastname}* stopped`;

      await ctx.reply(text, { parse_mode: 'MarkdownV2' });

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

      const existBooking = await this.checkOperatorBookingTime(operator);

      // This logic get next order client
      const nextOrderClient = await this.prisma.consultationOrder.findFirst({
        where: { status: 'waiting', operatorId: null },
        orderBy: { order: 'asc' },
        select: { id: true, consultationId: true },
      });
      if (existBooking) {
        ctx.reply(`You have a booking at ${existBooking.start_time}. Please be prepared.`, {
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
        });
      } else if (nextOrderClient && !existBooking) {
        await ctx.reply('Have next order client', {
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

  async commandGetBooking(ctx: Context) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        approvedAt: { not: null },
      },
    });

    if (!operator) return;

    const existBooking = await this.checkOperatorBookingTime(operator);

    if (existBooking) {
      return ctx.reply(`You have a booking at ${existBooking.start_time}. Please be prepared.`, {
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
      });
    }

    return ctx.reply('It is not yet time for your booking or not have your booking');
  }

  async reject(ctx: Context, chatId: string) {
    const operator = await this.prisma.user.findFirst({
      where: { telegramId: ctx.from.id.toString() },
    });
    const chat = await this.prisma.chat.findFirst({
      where: { id: chatId },
    });
    if (!chat || chat.status === 'active' || chat.status === 'done') {
      return ctx.reply('This chat is already active with another operator or closed.');
    }
    await this.prisma.rejectedChat.create({
      data: {
        chatId: chatId,
        operatorId: operator.id,
      },
    });
    return await ctx.editMessageReplyMarkup({
      reply_markup: {
        inline_keyboard: [[{ text: 'Show client messages', callback_data: `receive$${chatId}` }]],
      },
    });
  }

  async checkOperatorBookingTime(operator: user, trx = null) {
    trx = trx || this.prisma;
    const [operatorBooking]: {
      booking_id: string;
      user_id: string;
      chat_id: string;
      start_time: Date;
      chat_status: string;
      consultation_status: string;
      booking_status: string;
      priority: number;
      type: string;
    }[] = await this.prisma.$queryRaw`
          select 
            cb.id as booking_id,
            cb.user_id,
            chat_id,
            cb.start_time,
            cb.slot,
            ch.status as chat_status,
            c.status  as consultation_status,
            cb.status as booking_status,
            1         as priority,
            'booking'    type
          from consultation.consultation_booking as cb
              join consultation.consultations as c on c.id = cb.consultation_id
              join chat.chat as ch on ch.id = c.chat_id and ch.is_deleted is false
          where cb.status = 'new'
          and cb.operator_id = ${operator.id}
          and ((cb.start_time - NOW() <= INTERVAL '30 minutes') or cb.start_time <= NOW())
          
          -- and cb.start_time - NOW() <= INTERVAL '30 minutes'
          -- AND cb.start_time >= NOW()
          order by cb.start_time asc
          limit 1;`;

    if (!operatorBooking) {
      return null;
    }

    return operatorBooking;

    // return ctx.reply(`You have a booking at ${operatorBooking.start_time}. Please be prepared.`);
  }

  async callbackGetBookingButton(ctx: Context, bookingId: string) {
    const operator = await this.prisma.user.findFirst({
      where: {
        telegramId: ctx.from.id.toString(),
        blockedAt: null,
        approvedAt: { not: null },
      },
      include: { rejectedChats: true },
    });

    if (!operator) {
      return ctx.reply('Please /register and (or) wait for the administrator to approve');
    }

    const activeConsultationAndChat = await this.prisma.consultation.findFirst({
      where: {
        operatorId: operator.id,
        status: ConsultationStatus.IN_PROGRESS,
        chatId: { not: null },
      },
      include: { chat: true },
    });

    if (activeConsultationAndChat?.chat?.status == chatstatus.active) {
      return ctx.reply('You already have an active chat. You cannot take this booking.');
    }

    const booking = await this.prisma.consultationBooking.findFirst({
      where: { id: bookingId, operatorId: operator.id, status: 'new' },
      select: { id: true, consultationId: true, startTime: true, status: true },
    });

    if (!booking) {
      return ctx.reply('Booking not found');
    }

    const consultation = await this.prisma.consultation.findFirst({
      where: { id: booking?.consultationId, status: ConsultationStatus.NEW, chatId: { not: null } },
    });

    if (!consultation) {
      return ctx.reply('Consultation data is missing or invalid.');
    }

    const getClient = await this.prisma.user.findFirst({
      where: { userId: consultation.userId, isDeleted: false, doctorId: null },
      include: {
        userChats: {
          where: { status: chatstatus.active, isDeleted: false, operatorId: null },
        },
      },
    });

    if (!getClient) {
      return ctx.reply('Client not found or already deleted');
    }

    const chat = await this.prisma.chat.findFirst({
      where: { id: consultation?.chatId },
      include: { client: true, topic: true },
    });

    if (!chat) {
      return ctx.reply(`Booking chat not found`);
    }

    const now = new Date();
    const bookingStartTime = booking.startTime!;
    if (bookingStartTime >= now) {
      const timeDifference = bookingStartTime.getTime() - now.getTime();
      const hoursLeft = Math.floor(timeDifference / (1000 * 60 * 60));
      const minutesLeft = Math.floor((timeDifference % (1000 * 60 * 60)) / (1000 * 60));

      const timeMessage =
        hoursLeft > 0
          ? `Booking starts in ${hoursLeft} hour(s) and ${minutesLeft} minute(s).`
          : `Booking starts in ${minutesLeft} minute(s).`;

      // Create inline keyboard for user interaction
      const inlineKeyboard = {
        inline_keyboard: [
          [
            {
              text: "I'm Ready",
              callback_data: `get_booking$${booking.id}`,
            },
          ],
        ],
      };

      return ctx.reply(
        `You have a booking scheduled at ${moment(booking.startTime).zone(5)}. ${timeMessage}`,
        {
          reply_markup: inlineKeyboard,
        },
      );
    }

    const existDoctorWithQuery: any = await existDoctorInfo(this.prisma, operator?.doctorId);

    if (!existDoctorWithQuery) {
      throw new NotFoundException('Doctor not found');
    }

    const sendMessage = {
      ...operator,
      specialties: existDoctorWithQuery?.specialties || null,
      sip: existDoctorWithQuery?.sip,
    };

    await this.socketGateWay.sendMessageToAcceptOperator(chat?.consultationId, sendMessage);

    await this.prisma.$transaction(async (trx) => {
      // Proceed with activating the booking if it's ready to start
      await trx.consultation.update({
        where: { id: consultation.id },
        data: { chatId: chat.id, status: ConsultationStatus.IN_PROGRESS },
      });

      await trx.chat.update({
        where: { id: chat.id },
        data: {
          status: 'active',
          operatorId: operator?.id,
        },
      });

      await trx.consultationBooking.update({
        where: { id: booking.id },
        data: {
          status: 'active',
          operatorId: operator?.id,
        },
      });
      // Notify the operator and client
      return this.sendReceiveConversationButton(operator, getClient, chat.id, chat.topic.name);
    });
  }
}
