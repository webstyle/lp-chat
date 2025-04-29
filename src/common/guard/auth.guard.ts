import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';
import { PrismaService } from 'src/modules/prisma/prisma.service';
import { env } from '../config/env.config';

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const token = this.extractTokenFromHeader(request);

    if (!token) throw new UnauthorizedException();

    try {
      // Verify token and determine user type
      const user = await this.verifyTokenAndSetUser(request, token);

      // Ensure profile exists for the user/doctor
      await this.ensureProfileExists(request, user);

      request['token'] = token;
      return true;
    } catch (error) {
      console.log(error);

      return false;
    }
  }

  private async verifyTokenAndSetUser(request: any, token: string): Promise<'user' | 'doctor'> {
    try {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: env.JWT_SECRET,
      });
      return { ...payload, userType: 'user' };
    } catch {
      const payload = await this.jwtService.verifyAsync(token, {
        secret: env.JWT_SECRET_DOCTOR,
      });
      return { ...payload, userType: 'doctor' };
    }
  }

  private async ensureProfileExists(request: any, user: any) {
    const { id, userType, fist_name, last_name, phone_number } = user;
    const profileKey = userType === 'user' ? 'userId' : 'doctorId';

    let profile = await this.prisma.user.findFirst({
      where: {
        [profileKey]: id,
        isDeleted: false,
      },
    });

    if (!profile) {
      profile = await this.prisma.user.create({
        data: {
          id,
          [profileKey]: id,
          createdBy: id,
          firstname: fist_name,
          lastname: last_name,
          phone: phone_number,
        },
      });
    }

    request['user'] = { ...profile, userType };
  }

  private extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request?.headers?.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token.trim() : undefined;
  }
}
