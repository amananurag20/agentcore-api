import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../common/auth/authenticated-request';
import {
  PRODUCT_ACCESS_KEY,
  type RequiredProductAccess,
} from '../common/auth/product-access.decorator';
import { IS_PUBLIC_KEY } from '../common/auth/public.decorator';
import { PolicyService } from './policy.service';

@Injectable()
export class ProductAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly policyService: PolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<RequiredProductAccess>(
      PRODUCT_ACCESS_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    await this.policyService.assertProductAccess(
      request.user,
      required.productKey,
      required.action,
    );
    return true;
  }
}
