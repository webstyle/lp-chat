import { Injectable } from '@nestjs/common';
import { StreamClient } from '@stream-io/node-sdk';
import * as dotenv from 'dotenv';
import { env } from 'src/common/config/env.config';

dotenv.config();

@Injectable()
export class StreamService {
  private client: StreamClient;

  constructor() {
    const apiKey = env.STREAM_API_KEY || 'yazkey39jvhy';
    const secret =
      env.STREAM_SECRET || '236hq65ucbfxkp9k496mmc8k37y7qanvv692a7wh32v2tffaq9mc8m22e8gpf943';
    this.client = new StreamClient(apiKey, secret);
  }

  async createUser(userId: string, role: string, name?: string, image?: string, custom?: object) {
    try {
      const newUser = { id: userId, role, name, image, custom };
      await this.client.upsertUsers([newUser]);
      return { message: 'User created successfully', user: newUser };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  generateUserToken(userId: string) {
    try {
      return {
        token: this.client.generateUserToken({ user_id: userId }),
      };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async createCall(
    callType: string,
    callId: string,
    createdBy: string,
    members: any[],
    custom?: object,
  ) {
    try {
      const call = this.client.video.call(callType, callId);
      await call.create({ data: { created_by_id: createdBy, members, custom } });
      return { message: 'Call created successfully', callId };
    } catch (error) {
      throw new Error(error.message);
    }
  }

  async updateCallMembers(callId: string, update_members?: any[], remove_members?: string[]) {
    try {
      const call = this.client.video.call('default', callId);
      await call.updateCallMembers({ update_members, remove_members });
      return { message: 'Call members updated successfully' };
    } catch (error) {
      throw new Error(error.message);
    }
  }
}
