import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { UpdateUserDto } from './dto/update-user.dto';
import { PrismaService } from '../prisma/prisma.service';
import { user } from '@prisma/client';
import { CoreApiResponse } from 'src/common/response-class/core-api.response';
import { env } from 'process';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class UserService {
  constructor(
    private readonly prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async findAll() {
    return this.prisma.$queryRaw`
      with my_user as (
        select id as user_id, first_name, last_name, role::text, null as doctor_id
        from auth.users as au
        where au.is_deleted is false
          and au.is_verified is true
        union
        select null as user_id, first_name, last_name, role::text, id as doctor_id
        from doctor.doctors as dd
        where dd.is_deleted is false
          and dd.is_verified is true
      )
      select cu.id,
             cu.user_id,
             cu.doctor_id,
             mu.role,
             cu.firstname,
             cu.lastname,
             cu.shift_status,
             cu.telegram_id,
             cu.username,
             cu.email,
             cu.phone,
             cu.approved_at,
             cu.blocked_at
      from my_user as mu
      join chat."user" as cu on (cu.doctor_id = mu.doctor_id or cu.user_id = mu.user_id)
      where cu.is_deleted is false;
    `;
  }

  async update(id: string, dto: UpdateUserDto) {
    const operator = await this.prisma.user.findFirst({
      where: { id, telegramId: { not: null } },
    });
    if (!operator) throw new NotFoundException('Operator not found');
    await this.prisma.user.update({
      where: { id },
      data: {
        approvedAt: dto.approve ? new Date() : null,
        blockedAt: dto.block ? new Date() : null,
      },
    });
  }

  async validate(token: any) {
    try {
      const content: any = await this.verifyTokenAndSetUser(token);

      const dataFromJwt = {
        email: content.email,
        phone: content.phone_number,
        firstname: content.first_name,
        lastname: content.last_name,
        username: content?.username,
        userId: content?.userType === 'user' ? content?.id : null,
        doctorId: content?.userType === 'doctor' ? content?.id : null,
      };

      if (!dataFromJwt.userId && !dataFromJwt.doctorId)
        throw new NotFoundException('User not found');

      // Check if a user already exists based on userId or doctorId
      let existingUser: any;

      if (content?.userType === 'doctor') {
        existingUser = await this.prisma.user.findMany({
          where: {
            doctorId: content.id,
            userId: null,
            phone: content.phone_number,
            isDeleted: false,
          },
        });
      } else if (content?.userType === 'user') {
        existingUser = await this.prisma.user.findMany({
          where: {
            userId: content.id,
            doctorId: null,
            isDeleted: false,
            phone: content.phone_number,
          },
        });
      }

      if (!existingUser) {
        // Create a new user
        existingUser = await this.prisma.user.create({
          data: {
            ...dataFromJwt,
          },
        });
      }

      if (existingUser?.length > 1) {
        throw new ConflictException('More than two users found with the same phone number');
      }

      const data: user = { ...content, ...existingUser[0] };
      return CoreApiResponse.success(data);
    } catch (error) {
      return CoreApiResponse.error(error);
    }
  }

  private async verifyTokenAndSetUser(token: string): Promise<'user' | 'doctor'> {
    try {
      token = this.extractTokenFromHeader(token);

      const payload = await this.jwtService.verifyAsync(token, {
        secret: env.JWT_SECRET,
      });
      return { ...payload, userId: payload?.id, userType: 'user' };
    } catch {
      try {
        const payload = await this.jwtService.verifyAsync(token, {
          secret: env.JWT_SECRET_DOCTOR,
        });
        return { ...payload, doctorId: payload?.id, userType: 'doctor' };
      } catch {
        throw new UnauthorizedException('Invalid token');
      }
    }
  }

  async getShifts(id: string) {
    return this.prisma.shift.findMany({
      where: { operatorId: id, isDeleted: false },
      orderBy: { createdAt: 'desc' },
    });
  }

  private extractTokenFromHeader(authToken: string): string | undefined {
    const [type, token] = authToken.split(' ') ?? [];
    return type === 'Bearer' ? token.trim() : undefined;
  }
}
