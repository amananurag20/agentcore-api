import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { UsersModule } from '../users/users.module';
import {
  InternalAuthController,
  ServicePrincipalsController,
} from './service-principals.controller';
import { ServicePrincipalsService } from './service-principals.service';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
      }),
    }),
    AuditModule,
    PrismaModule,
    UsersModule,
  ],
  controllers: [ServicePrincipalsController, InternalAuthController],
  providers: [ServicePrincipalsService],
})
export class ServicePrincipalsModule {}
