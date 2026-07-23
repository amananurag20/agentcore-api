import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { CryptoModule } from '../crypto/crypto.module';
import { PrismaModule } from '../prisma/prisma.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadOperationsService } from './lead-operations.service';

@Module({
  imports: [AuditModule, CryptoModule, PrismaModule],
  controllers: [LeadsController],
  providers: [LeadOperationsService, LeadsService],
  exports: [LeadOperationsService, LeadsService],
})
export class LeadsModule {}
