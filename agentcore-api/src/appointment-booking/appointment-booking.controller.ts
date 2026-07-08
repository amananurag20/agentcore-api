import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
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
import { AppointmentBookingService } from './appointment-booking.service';
import {
  CancelAppointmentBookingDto,
  CreateAppointmentBookingDto,
  CreateAppointmentServiceDto,
  CreateAppointmentStaffDto,
  CreateStaffTimeOffDto,
  ListAppointmentBookingsDto,
  ListAvailabilityDto,
  PublicCreateAppointmentBookingDto,
  PublicListAppointmentServicesDto,
  PublicListAvailabilityDto,
  RescheduleAppointmentBookingDto,
  SetStaffAvailabilityDto,
  UpdateAppointmentBookingStatusDto,
  UpdateAppointmentServiceDto,
  UpdateAppointmentStaffDto,
} from './dto/appointment-booking.dto';
import {
  AppointmentAvailabilityResponseDto,
  AppointmentBookingListResponseDto,
  AppointmentBookingResponseDto,
  AppointmentServiceResponseDto,
  AppointmentSlotResponseDto,
  AppointmentStaffResponseDto,
  AppointmentTimeOffResponseDto,
} from './dto/appointment-booking-response.dto';

@ApiTags('Appointment Booking')
@ApiBearerAuth('bearer')
@Controller('appointment-booking')
@Roles('super_admin', 'org_admin', 'agent')
export class AppointmentBookingController {
  constructor(
    private readonly appointmentBookingService: AppointmentBookingService,
  ) {}

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
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Create an appointment service' })
  @ApiCreatedResponse({ type: AppointmentServiceResponseDto })
  createService(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentServiceDto,
  ) {
    return this.appointmentBookingService.createService(user, body);
  }

  @Patch('services/:id')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Update an appointment service' })
  @ApiOkResponse({ type: AppointmentServiceResponseDto })
  updateService(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: UpdateAppointmentServiceDto,
  ) {
    return this.appointmentBookingService.updateService(user, id, body);
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

  @Post('staff')
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Create appointment staff/resource' })
  @ApiCreatedResponse({ type: AppointmentStaffResponseDto })
  createStaff(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: CreateAppointmentStaffDto,
  ) {
    return this.appointmentBookingService.createStaff(user, body);
  }

  @Patch('staff/:id')
  @Roles('super_admin', 'org_admin')
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
  @Roles('super_admin', 'org_admin')
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
  @Roles('super_admin', 'org_admin')
  @ApiOperation({ summary: 'Create staff time off/blockout' })
  @ApiCreatedResponse({ type: AppointmentTimeOffResponseDto })
  createStaffTimeOff(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: CreateStaffTimeOffDto,
  ) {
    return this.appointmentBookingService.createStaffTimeOff(user, id, body);
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
}

@ApiTags('Appointment Booking Public')
@Controller('appointment-booking/public')
export class PublicAppointmentBookingController {
  constructor(
    private readonly appointmentBookingService: AppointmentBookingService,
  ) {}

  @Public()
  @Get('services')
  @ApiOperation({ summary: 'List public appointment services' })
  @ApiOkResponse({ type: AppointmentServiceResponseDto, isArray: true })
  listPublicServices(@Query() query: PublicListAppointmentServicesDto) {
    return this.appointmentBookingService.listPublicServices(query);
  }

  @Public()
  @Get('availability')
  @ApiOperation({ summary: 'List public appointment availability' })
  @ApiOkResponse({ type: AppointmentSlotResponseDto, isArray: true })
  listPublicAvailability(@Query() query: PublicListAvailabilityDto) {
    return this.appointmentBookingService.listPublicAvailability(query);
  }

  @Public()
  @Post('bookings')
  @ApiOperation({ summary: 'Create a public appointment booking' })
  @ApiCreatedResponse({ type: AppointmentBookingResponseDto })
  createPublicBooking(@Body() body: PublicCreateAppointmentBookingDto) {
    return this.appointmentBookingService.createPublicBooking(body);
  }
}
