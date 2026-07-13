import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Organization, Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { AuditService } from '../audit/audit.service';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly auditService: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async create(input: CreateOrganizationDto, actor?: AuthenticatedUser) {
    try {
      const passwordHash = await hash(input.firstAdmin.password, 12);
      const email = input.firstAdmin.email.trim().toLowerCase();

      const result = await this.prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: {
            name: input.name,
            slug: input.slug ?? this.slugify(input.name),
            contactEmail: input.contactEmail?.trim().toLowerCase(),
            contactPhone: input.contactPhone?.trim(),
            plan: input.plan ?? 'free',
            deploymentMode: input.deploymentMode ?? 'saas',
          },
        });

        const firstAdmin = await tx.user.create({
          data: {
            orgId: organization.id,
            email,
            name: input.firstAdmin.name,
            passwordHash,
            roles: ['org_admin'],
            clearanceLevel: 4,
          },
        });

        const products = await tx.product.findMany({
          where: { status: 'active' },
        });
        const enabledProducts = new Set(input.enabledProducts ?? []);
        await tx.organizationProduct.createMany({
          data: products.map((product) => ({
            organizationId: organization.id,
            productId: product.id,
            status: enabledProducts.has(product.key)
              ? ('enabled' as const)
              : ('disabled' as const),
          })),
        });

        return { organization, firstAdmin };
      });

      await this.auditService.record({
        actor,
        organizationId: result.organization.id,
        action: 'organization.created',
        entityType: 'organization',
        entityId: result.organization.id,
        metadata: {
          name: result.organization.name,
          plan: result.organization.plan,
          firstAdminId: result.firstAdmin.id,
          firstAdminEmail: result.firstAdmin.email,
          enabledProducts: input.enabledProducts ?? [],
        },
      });

      return {
        ...result.organization,
        firstAdmin: {
          id: result.firstAdmin.id,
          name: result.firstAdmin.name,
          email: result.firstAdmin.email,
        },
      };
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
  }

  async list() {
    return this.prisma.organization.findMany({
      where: { isSystem: false },
      include: {
        users: {
          where: { roles: { has: 'org_admin' } },
          select: { id: true, name: true, email: true, isActive: true },
          orderBy: { createdAt: 'asc' },
        },
        _count: { select: { users: true, products: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string): Promise<Organization> {
    const organization = await this.prisma.organization.findUnique({
      where: { id },
    });

    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    return organization;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    return this.prisma.organization.findUnique({ where: { slug } });
  }

  async update(
    id: string,
    input: UpdateOrganizationDto,
    actor?: AuthenticatedUser,
  ): Promise<Organization> {
    try {
      const organization = await this.prisma.organization.update({
        where: { id },
        data: {
          name: input.name,
          contactEmail: input.contactEmail?.trim().toLowerCase(),
          contactPhone: input.contactPhone?.trim(),
          slug: input.slug,
          status: input.status,
          plan: input.plan,
          deploymentMode: input.deploymentMode,
        },
      });

      await this.auditService.record({
        actor,
        organizationId: organization.id,
        action: 'organization.updated',
        entityType: 'organization',
        entityId: organization.id,
        metadata: this.removeUndefined({
          name: input.name,
          contactEmail: input.contactEmail,
          contactPhone: input.contactPhone,
          slug: input.slug,
          status: input.status,
          plan: input.plan,
          deploymentMode: input.deploymentMode,
        }),
      });

      return organization;
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
  }

  private slugify(value: string): string {
    const slug = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug || `org-${Date.now()}`;
  }

  private removeUndefined(
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entry]) => entry !== undefined),
    );
  }

  private handleKnownError(error: unknown) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError)) {
      return;
    }

    if (error.code === 'P2002') {
      throw new ConflictException('Organization slug already exists');
    }

    if (error.code === 'P2025') {
      throw new NotFoundException('Organization not found');
    }
  }
}
