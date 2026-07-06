import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Organization, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrganizationDto } from './dto/create-organization.dto';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@Injectable()
export class OrganizationsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateOrganizationDto): Promise<Organization> {
    try {
      return await this.prisma.organization.create({
        data: {
          name: input.name,
          slug: input.slug ?? this.slugify(input.name),
          plan: input.plan ?? 'free',
          deploymentMode: input.deploymentMode ?? 'saas',
        },
      });
    } catch (error) {
      this.handleKnownError(error);
      throw error;
    }
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
  ): Promise<Organization> {
    try {
      return await this.prisma.organization.update({
        where: { id },
        data: {
          name: input.name,
          slug: input.slug,
          status: input.status,
          plan: input.plan,
          deploymentMode: input.deploymentMode,
        },
      });
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
