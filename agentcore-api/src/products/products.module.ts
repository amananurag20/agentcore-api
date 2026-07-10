import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { PrismaModule } from '../prisma/prisma.module';
import {
  OrganizationProductsController,
  PlatformOrganizationProductsController,
  ProductsController,
} from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuditModule, PrismaModule],
  controllers: [
    ProductsController,
    OrganizationProductsController,
    PlatformOrganizationProductsController,
  ],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
