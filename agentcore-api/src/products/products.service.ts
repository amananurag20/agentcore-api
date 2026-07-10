import { Injectable, NotFoundException } from '@nestjs/common';
import {
  OrganizationProduct,
  Prisma,
  Product,
  ProductKey,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateOrganizationProductDto } from './dto/update-organization-product.dto';

type ProductWithEntitlement = OrganizationProduct & {
  product: Product;
};

@Injectable()
export class ProductsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async listProducts(): Promise<Product[]> {
    return this.prisma.product.findMany({
      orderBy: { name: 'asc' },
    });
  }

  async listOrganizationProducts(
    currentUser: AuthenticatedUser,
  ): Promise<ProductWithEntitlement[]> {
    return this.listOrganizationProductsById(currentUser.orgId);
  }

  async listOrganizationProductsById(
    organizationId: string,
  ): Promise<ProductWithEntitlement[]> {
    return this.prisma.organizationProduct.findMany({
      where: { organizationId },
      include: { product: true },
      orderBy: { product: { name: 'asc' } },
    });
  }

  async updateCurrentOrganizationProduct(
    currentUser: AuthenticatedUser,
    productKey: ProductKey,
    input: UpdateOrganizationProductDto,
  ): Promise<ProductWithEntitlement> {
    return this.updateOrganizationProduct(
      currentUser,
      currentUser.orgId,
      productKey,
      input,
    );
  }

  async updateOrganizationProduct(
    currentUser: AuthenticatedUser,
    organizationId: string,
    productKey: ProductKey,
    input: UpdateOrganizationProductDto,
  ): Promise<ProductWithEntitlement> {
    const product = await this.prisma.product.findUnique({
      where: { key: productKey },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    const entitlement = await this.prisma.organizationProduct.upsert({
      where: {
        organizationId_productId: {
          organizationId,
          productId: product.id,
        },
      },
      create: {
        organizationId,
        productId: product.id,
        status: input.status,
        config: this.toJsonObject(input.config),
      },
      update: {
        status: input.status,
        config: input.config ? this.toJsonObject(input.config) : undefined,
      },
      include: { product: true },
    });

    await this.auditService.record({
      actor: currentUser,
      organizationId,
      action: 'organization_product.updated',
      entityType: 'organization_product',
      entityId: entitlement.id,
      metadata: {
        productKey,
        status: entitlement.status,
      },
    });

    return entitlement;
  }

  private toJsonObject(
    value: Record<string, unknown> | undefined,
  ): Prisma.InputJsonObject {
    return (value ?? {}) as Prisma.InputJsonObject;
  }
}
