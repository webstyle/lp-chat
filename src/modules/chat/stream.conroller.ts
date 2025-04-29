import { Controller, Get, Param } from '@nestjs/common';
import { StreamService } from './getstream';
import { ApiOperation, ApiParam } from '@nestjs/swagger';
import { CoreApiResponse } from 'src/common/response-class/core-api.response';

@Controller('stream')
export class StreamController {
  constructor(private readonly streamService: StreamService) {}

  @Get('token/:userId')
  @ApiOperation({ summary: 'Generate user token' })
  @ApiParam({ name: 'userId', required: true, description: 'ID of the user' })
  async generateUserToken(@Param('userId') userId: string) {
    const data = this.streamService.generateUserToken(userId);
    return CoreApiResponse.success(data);
  }
}
