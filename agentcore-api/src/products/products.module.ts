import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import {
  OrganizationProductsController,
  ProductsController,
} from './products.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [PrismaModule],
  controllers: [ProductsController, OrganizationProductsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
