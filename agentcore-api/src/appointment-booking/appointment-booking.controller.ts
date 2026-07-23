import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthenticatedUser } from '../common/auth/authenticated-request';
import { CurrentUser } from '../common/auth/current-user.decorator';
import { Public } from '../common/auth/public.decorator';
import { Roles } from '../common/auth/roles.decorator';
import { RequireProductAccess } from '../common/auth/product-access.decorator';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { AppointmentBookingService } from './appointment-booking.service';
import {
  CancelAppointmentBookingDto,
  CreateAppointmentBookingDto,
  CreateAppointmentResourceDto,
  CreateAppointmentServiceDto,
  CreateAppointmentStaffDto,
  CreateStaffTimeOffDto,
  ListAppointmentBookingsDto,
  ListAvailabilityDto,
  PublicCreateAppointmentBookingDto,
  PublicCancelAppointmentBookingDto,
  PublicListAppointmentServicesDto,
  PublicListAvailabilityDto,
  PublicRescheduleAppointmentBookingDto,
  RescheduleAppointmentBookingDto,
  SetServiceResourceDto,
  SetStaffAvailabilityDto,
  UpdateAppointmentBookingStatusDto,
  UpdateAppointmentServiceDto,
  UpdateAppointmentResourceDto,
  UpdateAppointmentStaffDto,
} from './dto/appointment-booking.dto';
import {
  AppointmentCalendarProviderDto,
  ConnectAppointmentCalendarDto,
  ListAppointmentCalendarConnectionsDto,
} from './dto/appointment-calendar.dto';
import {
  AppointmentAvailabilityResponseDto,
  AppointmentBookingListResponseDto,
  AppointmentBookingResponseDto,
  AppointmentEligibleUserResponseDto,
  AppointmentResourceResponseDto,
  AppointmentServiceResponseDto,
  AppointmentSlotResponseDto,
  AppointmentStaffResponseDto,
  AppointmentTimeOffResponseDto,
} from './dto/appointment-booking-response.dto';
import { AppointmentActionDto } from './dto/appointment-action.dto';
import { AppointmentCalendarService } from './appointment-calendar.service';
import {
  AppointmentReminderOptOutDto,
  CancelAppointmentSeriesDto,
  CheckInAppointmentDto,
  ClaimAppointmentWaitlistDto,
  CreateAppointmentBlackoutDto,
  JoinAppointmentWaitlistDto,
  ListAppointmentScheduleDto,
  ListWaitlistDto,
  PublicCancelAppointmentSeriesDto,
  UpdateAppointmentPolicyDto,
} from './dto/appointment-features.dto';
import type { Response } from 'express';

@ApiTags('Appointment Booking')
@ApiBearerAuth('bearer')
@Controller('appointment-booking')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent', 'user')
@RequireProductAccess('appointment_booking')
export class AppointmentBookingController {
  constructor(
    private readonly appointmentBookingService: AppointmentBookingService,
  ) {}

  @Get('policy')
  @Roles('super_admin', 'org_admin', 'product_admin')
  getPolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.getPolicy(user, organizationId);
  }

  @Patch('policy')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  updatePolicy(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId: string | undefined,
    @Body() body: UpdateAppointmentPolicyDto,
  ) {
    return this.appointmentBookingService.updatePolicy(
      user,
      organizationId,
      body,
    );
  }

  @Get('blackouts')
  listBlackouts(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listBlackouts(user, organizationId);
  }

  @Post('blackouts')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  createBlackout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentBlackoutDto,
  ) {
    return this.appointmentBookingService.createBlackout(user, body);
  }

  @Delete('blackouts/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  deleteBlackout(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.deleteBlackout(user, id);
  }

  @Post('actions/execute')
  @ApiOperation({
    summary: 'Execute a structured appointment action from an AI channel',
  })
  executeAction(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: AppointmentActionDto,
  ) {
    return this.appointmentBookingService.executeAction(user.orgId, body);
  }

  @Get('services')
  @ApiOperation({ summary: 'List appointment services' })
  @ApiOkResponse({ type: AppointmentServiceResponseDto, isArray: true })
  listServices(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listServices(user, organizationId);
  }

  @Post('services')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Create an appointment service' })
  @ApiCreatedResponse({ type: AppointmentServiceResponseDto })
  createService(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentServiceDto,
  ) {
    return this.appointmentBookingService.createService(user, body);
  }

  @Patch('services/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Update an appointment service' })
  @ApiOkResponse({ type: AppointmentServiceResponseDto })
  updateService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAppointmentServiceDto,
  ) {
    return this.appointmentBookingService.updateService(user, id, body);
  }

  @Delete('services/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({
    summary: 'Permanently delete an appointment service with no history',
  })
  deleteService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.deleteService(user, id);
  }

  @Post('services/:id/resources')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Add or update a required resource for a service' })
  setServiceResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetServiceResourceDto,
  ) {
    return this.appointmentBookingService.setServiceResource(user, id, body);
  }

  @Get('services/:id/resources')
  @ApiOperation({ summary: 'List required resources for a service' })
  listServiceResources(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.listServiceResources(user, id);
  }

  @Delete('services/:serviceId/resources/:resourceId')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Remove a required resource from a service' })
  removeServiceResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('serviceId') serviceId: string,
    @Param('resourceId') resourceId: string,
  ) {
    return this.appointmentBookingService.removeServiceResource(
      user,
      serviceId,
      resourceId,
    );
  }

  @Get('resources')
  @ApiOkResponse({ type: AppointmentResourceResponseDto, isArray: true })
  listResources(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listResources(user, organizationId);
  }

  @Post('resources')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiCreatedResponse({ type: AppointmentResourceResponseDto })
  createResource(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentResourceDto,
  ) {
    return this.appointmentBookingService.createResource(user, body);
  }

  @Patch('resources/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  updateResource(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAppointmentResourceDto,
  ) {
    return this.appointmentBookingService.updateResource(user, id, body);
  }

  @Post('resources/:id/time-off')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  createResourceTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CreateStaffTimeOffDto,
  ) {
    return this.appointmentBookingService.createResourceTimeOff(user, id, body);
  }

  @Get('resources/:id/time-off')
  listResourceTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.listResourceTimeOff(user, id);
  }

  @Delete('resources/:resourceId/time-off/:timeOffId')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  deleteResourceTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('resourceId') resourceId: string,
    @Param('timeOffId') timeOffId: string,
  ) {
    return this.appointmentBookingService.deleteResourceTimeOff(
      user,
      resourceId,
      timeOffId,
    );
  }

  @Get('staff')
  @ApiOperation({ summary: 'List appointment staff/resources' })
  @ApiOkResponse({ type: AppointmentStaffResponseDto, isArray: true })
  listStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listStaff(user, organizationId);
  }

  @Get('staff/eligible-users')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({
    summary:
      'List active workspace users eligible for appointment staff profiles',
  })
  @ApiOkResponse({ type: AppointmentEligibleUserResponseDto, isArray: true })
  listEligibleStaffUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listEligibleStaffUsers(
      user,
      organizationId,
    );
  }

  @Post('staff')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Create appointment staff/resource' })
  @ApiCreatedResponse({ type: AppointmentStaffResponseDto })
  createStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentStaffDto,
  ) {
    return this.appointmentBookingService.createStaff(user, body);
  }

  @Patch('staff/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Update appointment staff/resource' })
  @ApiOkResponse({ type: AppointmentStaffResponseDto })
  updateStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAppointmentStaffDto,
  ) {
    return this.appointmentBookingService.updateStaff(user, id, body);
  }

  @Get('staff/:id/availability')
  @ApiOperation({ summary: 'List weekly availability for appointment staff' })
  @ApiOkResponse({ type: AppointmentAvailabilityResponseDto, isArray: true })
  listStaffAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.listStaffAvailability(user, id);
  }

  @Post('staff/:id/availability')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Create a weekly availability window' })
  @ApiCreatedResponse({ type: AppointmentAvailabilityResponseDto })
  createStaffAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: SetStaffAvailabilityDto,
  ) {
    return this.appointmentBookingService.createStaffAvailability(
      user,
      id,
      body,
    );
  }

  @Delete('staff/:staffId/availability/:availabilityId')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  deleteStaffAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Param('staffId') staffId: string,
    @Param('availabilityId') availabilityId: string,
  ) {
    return this.appointmentBookingService.deleteStaffAvailability(
      user,
      staffId,
      availabilityId,
    );
  }

  @Get('staff/:id/time-off')
  @ApiOperation({ summary: 'List staff time off/blockouts' })
  @ApiOkResponse({ type: AppointmentTimeOffResponseDto, isArray: true })
  listStaffTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.listStaffTimeOff(user, id);
  }

  @Post('staff/:id/time-off')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  @ApiOperation({ summary: 'Create staff time off/blockout' })
  @ApiCreatedResponse({ type: AppointmentTimeOffResponseDto })
  createStaffTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CreateStaffTimeOffDto,
  ) {
    return this.appointmentBookingService.createStaffTimeOff(user, id, body);
  }

  @Delete('staff/:staffId/time-off/:timeOffId')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  deleteStaffTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('staffId') staffId: string,
    @Param('timeOffId') timeOffId: string,
  ) {
    return this.appointmentBookingService.deleteStaffTimeOff(
      user,
      staffId,
      timeOffId,
    );
  }

  @Get('availability')
  @ApiOperation({ summary: 'List available appointment slots' })
  @ApiOkResponse({ type: AppointmentSlotResponseDto, isArray: true })
  listAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAvailabilityDto,
  ) {
    return this.appointmentBookingService.listAvailability(user, query);
  }

  @Get('bookings')
  @ApiOperation({ summary: 'List appointment bookings' })
  @ApiOkResponse({ type: AppointmentBookingListResponseDto })
  listBookings(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAppointmentBookingsDto,
  ) {
    return this.appointmentBookingService.listBookings(user, query);
  }

  @Get('schedule')
  @ApiOperation({ summary: 'List the unified appointment schedule' })
  listSchedule(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAppointmentScheduleDto,
  ) {
    return this.appointmentBookingService.listSchedule(user, query);
  }

  @Post('bookings')
  @ApiOperation({ summary: 'Create an appointment booking' })
  @ApiCreatedResponse({ type: AppointmentBookingResponseDto })
  createBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentBookingDto,
  ) {
    return this.appointmentBookingService.createBooking(user, body);
  }

  @Patch('bookings/:id/reschedule')
  @ApiOperation({ summary: 'Reschedule an appointment booking' })
  @ApiOkResponse({ type: AppointmentBookingResponseDto })
  rescheduleBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: RescheduleAppointmentBookingDto,
  ) {
    return this.appointmentBookingService.rescheduleBooking(user, id, body);
  }

  @Patch('bookings/:id/cancel')
  @ApiOperation({ summary: 'Cancel an appointment booking' })
  @ApiOkResponse({ type: AppointmentBookingResponseDto })
  cancelBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CancelAppointmentBookingDto,
  ) {
    return this.appointmentBookingService.cancelBooking(user, id, body);
  }

  @Patch('bookings/:id/status')
  @ApiOperation({ summary: 'Update appointment booking status' })
  @ApiOkResponse({ type: AppointmentBookingResponseDto })
  updateBookingStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAppointmentBookingStatusDto,
  ) {
    return this.appointmentBookingService.updateBookingStatus(user, id, body);
  }

  @Patch('bookings/:id/check-in')
  @ApiOperation({ summary: 'Mark a booking as attended/check-in' })
  checkInBooking(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CheckInAppointmentDto,
  ) {
    return this.appointmentBookingService.checkInBooking(user, id, body);
  }

  @Get('waitlist')
  listWaitlist(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListWaitlistDto,
  ) {
    return this.appointmentBookingService.listWaitlist(user, query);
  }

  @Get('operations/dead-letters')
  @Roles('super_admin', 'org_admin', 'product_admin')
  listDeadLetters(
    @CurrentUser() user: AuthenticatedUser,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.appointmentBookingService.listDeadLetters(user, organizationId);
  }

  @Post('operations/reminders/:id/retry')
  @Roles('super_admin', 'org_admin', 'product_admin')
  retryReminderDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.retryReminderDeadLetter(user, id);
  }

  @Post('operations/calendars/:id/retry')
  @Roles('super_admin', 'org_admin', 'product_admin')
  retryCalendarDeadLetter(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.appointmentBookingService.retryCalendarDeadLetter(user, id);
  }

  @Patch('series/:id/cancel')
  cancelSeries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CancelAppointmentSeriesDto,
  ) {
    return this.appointmentBookingService.cancelSeries(user, id, body);
  }
}

@ApiTags('Appointment Calendar Sync')
@ApiBearerAuth('bearer')
@Controller('appointment-booking/calendars')
@Roles('super_admin', 'org_admin', 'product_admin', 'agent', 'user')
@RequireProductAccess('appointment_booking')
export class AppointmentCalendarController {
  constructor(private readonly calendarService: AppointmentCalendarService) {}

  @Get('connections')
  listConnections(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAppointmentCalendarConnectionsDto,
  ) {
    return this.calendarService.listConnections(user, query);
  }

  @Post('connections')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  connect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ConnectAppointmentCalendarDto,
  ) {
    return this.calendarService.beginConnection(user, body);
  }

  @Delete('connections/:id')
  @Roles('super_admin', 'org_admin', 'product_admin')
  @RequireProductAccess('appointment_booking', 'configure')
  disconnect(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.calendarService.disconnect(user, id);
  }
}

@ApiTags('Appointment Calendar OAuth')
@Controller('appointment-booking/calendar')
export class AppointmentCalendarOAuthController {
  constructor(
    private readonly calendarService: AppointmentCalendarService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @Get('oauth/:provider/callback')
  async callback(
    @Param('provider') provider: AppointmentCalendarProviderDto,
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ) {
    const successUrl =
      this.configService.get<string>(
        'APPOINTMENT_CALENDAR_OAUTH_SUCCESS_URL',
      ) ?? 'http://localhost:3000/?tab=appointments&calendar=connected';
    try {
      await this.calendarService.completeConnection(provider, code, state);
      response.redirect(successUrl);
    } catch {
      const errorUrl = new URL(successUrl);
      errorUrl.searchParams.set('calendar', 'error');
      response.redirect(errorUrl.toString());
    }
  }
}

@ApiTags('Appointment Booking Public')
@Controller('appointment-booking/public')
export class PublicAppointmentBookingController {
  constructor(
    private readonly appointmentBookingService: AppointmentBookingService,
    private readonly configService: ConfigService,
    private readonly rateLimitService: RateLimitService,
  ) {}

  @Public()
  @Get('services')
  @ApiOperation({ summary: 'List public appointment services' })
  @ApiOkResponse({ type: AppointmentServiceResponseDto, isArray: true })
  async listPublicServices(
    @Query() query: PublicListAppointmentServicesDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, query.organizationId, 'read');
    return this.appointmentBookingService.listPublicServices(query);
  }

  @Public()
  @Get('availability')
  @ApiOperation({ summary: 'List public appointment availability' })
  @ApiOkResponse({ type: AppointmentSlotResponseDto, isArray: true })
  async listPublicAvailability(
    @Query() query: PublicListAvailabilityDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, query.organizationId, 'read');
    return this.appointmentBookingService.listPublicAvailability(query);
  }

  @Public()
  @Get('waitlist-sessions')
  async listPublicWaitlistSessions(
    @Query() query: PublicListAvailabilityDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, query.organizationId, 'read');
    return this.appointmentBookingService.listPublicWaitlistSessions(query);
  }

  @Public()
  @Post('bookings')
  @ApiOperation({ summary: 'Create a public appointment booking' })
  @ApiCreatedResponse({ type: AppointmentBookingResponseDto })
  async createPublicBooking(
    @Body() body: PublicCreateAppointmentBookingDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.createPublicBooking(body);
  }

  @Public()
  @Post('waitlist')
  async joinWaitlist(
    @Body() body: JoinAppointmentWaitlistDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.joinWaitlist(body);
  }

  @Public()
  @Post('waitlist/claim')
  async claimWaitlist(
    @Body() body: ClaimAppointmentWaitlistDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.claimWaitlist(body);
  }

  @Public()
  @Post('reminders/opt-out')
  async optOutReminders(
    @Body() body: AppointmentReminderOptOutDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.optOutReminders(body);
  }

  @Public()
  @Patch('series/:id/cancel')
  async cancelPublicSeries(
    @Param('id') id: string,
    @Body() body: PublicCancelAppointmentSeriesDto,
    @Req() request: Request,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.cancelPublicSeries(id, body);
  }

  @Public()
  @Patch('bookings/:id/reschedule')
  @ApiOperation({
    summary: 'Reschedule a public booking using its management token',
  })
  @ApiOkResponse({ type: AppointmentBookingResponseDto })
  reschedulePublicBooking(
    @Param('id') id: string,
    @Body() body: PublicRescheduleAppointmentBookingDto,
    @Req() request: Request,
  ) {
    return this.limitAndReschedule(request, id, body);
  }

  @Public()
  @Patch('bookings/:id/cancel')
  @ApiOperation({
    summary: 'Cancel a public booking using its management token',
  })
  @ApiOkResponse({ type: AppointmentBookingResponseDto })
  cancelPublicBooking(
    @Param('id') id: string,
    @Body() body: PublicCancelAppointmentBookingDto,
    @Req() request: Request,
  ) {
    return this.limitAndCancel(request, id, body);
  }

  private async limitAndReschedule(
    request: Request,
    id: string,
    body: PublicRescheduleAppointmentBookingDto,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.reschedulePublicBooking(id, body);
  }

  private async limitAndCancel(
    request: Request,
    id: string,
    body: PublicCancelAppointmentBookingDto,
  ) {
    await this.limitPublicRequest(request, body.organizationId, 'write');
    return this.appointmentBookingService.cancelPublicBooking(id, body);
  }

  private async limitPublicRequest(
    request: Request,
    organizationId: string,
    action: 'read' | 'write',
  ) {
    const windowSeconds = this.configService.get<number>(
      'PUBLIC_APPOINTMENT_RATE_LIMIT_WINDOW_SECONDS',
      60,
    );
    const limit = this.configService.get<number>(
      action === 'read'
        ? 'PUBLIC_APPOINTMENT_MAX_READS_PER_WINDOW'
        : 'PUBLIC_APPOINTMENT_MAX_WRITES_PER_WINDOW',
      action === 'read' ? 120 : 10,
    );
    await this.rateLimitService.consume(
      `public-appointment:${action}:ip:${request.ip ?? 'unknown'}`,
      limit,
      windowSeconds,
    );
    await this.rateLimitService.consume(
      `public-appointment:${action}:org:${organizationId}`,
      limit * 10,
      windowSeconds,
    );
  }
}
