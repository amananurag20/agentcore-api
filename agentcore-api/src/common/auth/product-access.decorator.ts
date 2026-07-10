import { SetMetadata } from '@nestjs/common';
import type { ProductAction, ProductKey } from './product-access.types';

export const PRODUCT_ACCESS_KEY = 'product_access';

export interface RequiredProductAccess {
  productKey: ProductKey;
  action: ProductAction;
}

export const RequireProductAccess = (
  productKey: ProductKey,
  action: ProductAction = 'use',
) => SetMetadata(PRODUCT_ACCESS_KEY, { productKey, action });
