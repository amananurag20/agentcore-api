import { Global, Module } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PrismaModule } from '../prisma/prisma.module';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
