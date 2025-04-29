import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length } from 'class-validator';

export class CreateChatDto {
  @ApiPropertyOptional({
    required: false,
    description: 'Topic ID or Consolation Id',
  })
  @IsOptional()
  @IsString()
  topicId?: string;

  @IsOptional()
  @IsString()
  type: string;

  @ApiPropertyOptional({
    required: false,
    description: 'User ID',
  })
  @IsString()
  consultationId?: string;
}

export class StopConsultationAndChatDto {
  @ApiPropertyOptional({
    required: false,
    description: 'File ID',
  })
  @IsString()
  @IsOptional()
  fileId?: string;

  @ApiPropertyOptional({
    required: false,
    description: 'Content of the chat',
  })
  @IsOptional()
  @IsString()
  @Length(1, 5000)
  content?: string;
}
