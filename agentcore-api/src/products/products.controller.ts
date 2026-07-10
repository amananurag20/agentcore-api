import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/auth/current-user.decorator';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { Roles } from '../common/auth/roles.decorator';
import { Public } from '../common/auth/public.decorator';
import { OrganizationProductResponseDto } from './dto/organization-product-response.dto';
import { ProductResponseDto } from './dto/product-response.dto';
import { UpdateOrganizationProductDto } from './dto/update-organization-product.dto';
import { ProductsService } from './products.service';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: 'List the platform product catalog' })
  @ApiOkResponse({ type: ProductResponseDto, isArray: true })
  listProducts() {
    return this.productsService.listProducts();
  }
}

@ApiTags('Organization Products')
@ApiBearerAuth('bearer')
@Controller('organizations/me/products')
export class OrganizationProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  @ApiOperation({
    summary: "List the current organization's product entitlements",
  })
  @ApiOkResponse({ type: OrganizationProductResponseDto, isArray: true })
  listCurrentOrganizationProducts(@CurrentUser() user: AuthenticatedUser) {
    return this.productsService.listOrganizationProducts(user);
  }

  @Patch(':productKey')
  @Roles('super_admin')
  @ApiOperation({
    summary: "Enable or disable a product for the current user's organization",
  })
  @ApiOkResponse({ type: OrganizationProductResponseDto })
  updateCurrentOrganizationProduct(
    @CurrentUser() user: AuthenticatedUser,
    @Param('productKey')
    productKey:
      | 'customer_chat'
      | 'appointment_booking'
      | 'whatsapp_assistant'
      | 'voice_receptionist',
    @Body() body: UpdateOrganizationProductDto,
  ) {
    return this.productsService.updateCurrentOrganizationProduct(
      user,
      productKey,
      body,
    );
  }
}

@ApiTags('Platform Organization Products')
@ApiBearerAuth('bearer')
@Controller('organizations/:organizationId/products')
@Roles('super_admin')
export class PlatformOrganizationProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  list(@Param('organizationId') organizationId: string) {
    return this.productsService.listOrganizationProductsById(organizationId);
  }

  @Patch(':productKey')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId') organizationId: string,
    @Param('productKey')
    productKey:
      | 'customer_chat'
      | 'appointment_booking'
      | 'whatsapp_assistant'
      | 'voice_receptionist',
    @Body() body: UpdateOrganizationProductDto,
  ) {
    return this.productsService.updateOrganizationProduct(
      user,
      organizationId,
      productKey,
      body,
    );
  }
}
