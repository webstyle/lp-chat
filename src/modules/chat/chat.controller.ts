import {
  Body,
  Controller,
  forwardRef,
  Get,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { User } from 'src/common/decorator/user.decorator';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  CreateDraftMessageDto,
  CreateMessageDto,
  CreatePaymentMessageDto,
  CreateRateMessageDto,
  GetMessagesByChatIdDto,
  PayTransactionDto,
} from './dto/message.dto';
import { IUser } from 'src/common/interface/my-req.interface';
import { CoreApiResponse } from 'src/common/response-class/core-api.response';
import { AuthGuard } from 'src/common/guard/auth.guard';
import { findOperatorsCronId } from '../../common/var/index.var';
import { Cron } from '@nestjs/schedule';
import { env } from '../../common/config/env.config';
import { CreateChatDto, StopConsultationAndChatDto } from './dto/chat.dto';
import { BotHttpService } from '../bot/bot-http.service';

@ApiTags('Chat')
@Controller('chat')
@UseGuards(AuthGuard)
@ApiBearerAuth('authorization')
export class ChatController {
  constructor(
    private readonly chatService: ChatService,

    @Inject(forwardRef(() => BotHttpService))
    private botHttpService: BotHttpService,
  ) {}

  @Get('test')
  @ApiOperation({ summary: 'Socket listen (test) return test' })
  sendMessage() {
    return this.chatService.test();
  }

  @Post('create')
  async chat(@Body() dto: CreateChatDto, @User() user: IUser) {
    const data = await this.chatService.chatCreate(dto, user);
    return CoreApiResponse.success(data);
  }

  @Post('save-draft-messages')
  @ApiOperation({
    summary: 'Save draft messages',
  })
  async saveDraftMessage(@Body() dto: CreateDraftMessageDto, @User() user: IUser) {
    const data = await this.chatService.saveDraftMessage(dto, user);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({
    summary: 'Start chat new logic',
  })
  @Post('start')
  async startChatWithOperator(@Body() dto: CreateMessageDto, @User() user: IUser) {
    const data = await this.chatService.startChatWithOperator(dto, user);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({
    summary: 'Start chat and pay method',
  })
  @Post('pay/:consultationId')
  async payTransaction(
    @Body() payload: PayTransactionDto,
    @Param('consultationId') consultationId: string,
    @User() user: IUser,
  ) {
    const data = await this.chatService.payStartChatWithOperator(consultationId, payload, user);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({
    summary: 'This api saved payment message',
  })
  @Post('payment-message')
  async savePaymentMessage(@Body() dto: CreatePaymentMessageDto, @User() user: IUser) {
    const data = await this.chatService.savePaymentMessage(dto, user);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({
    summary: 'This api saved rate message',
  })
  @Post('rate-message')
  async saveRateMessage(@Body() dto: CreateRateMessageDto, @User() user: IUser) {
    const data = await this.chatService.saveRateMessage(dto, user);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({ summary: 'Get messages with chatId (client, operator)' })
  @Get('message-by-chat')
  async messageByChaId(@Query() dto: GetMessagesByChatIdDto) {
    const data = await this.chatService.getMessagesByChatId(dto);
    return CoreApiResponse.success(data);
  }

  @ApiOperation({
    summary: 'Get all active operators list',
  })
  @Get('all-active-operators')
  async getAllActiveOperators() {
    const data = await this.chatService.getAllActiveOperators();
    return CoreApiResponse.success(data);
  }

  @Cron(env.FIND_FREE_OPERATORS_CRON_PATTERN, { name: findOperatorsCronId })
  async handleCronSendActiveOperators() {
    return this.chatService.getAllActiveOperators();
  }

  @ApiOperation({
    summary: 'Stop current chat and start new chat in queue',
  })
  @Post('stop-and-start-new-chat')
  async stopCurrentChatAndStartNewChatInQueue(
    @Body() dto: StopConsultationAndChatDto,
    @User() user: IUser,
  ) {
    const data = await this.botHttpService.stopDialogHttp(dto, user);
    return CoreApiResponse.success(data);
  }
}
