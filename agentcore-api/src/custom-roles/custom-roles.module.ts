import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import { CustomRolesController } from './custom-roles.controller';
import { CustomRolesService } from './custom-roles.service';

@Module({
  imports: [AuditModule, PrismaModule],
  controllers: [CustomRolesController],
  providers: [CustomRolesService],
  exports: [CustomRolesService],
})
export class CustomRolesModule {}
