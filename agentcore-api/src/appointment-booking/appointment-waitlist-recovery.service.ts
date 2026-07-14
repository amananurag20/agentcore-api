import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppointmentBookingService } from './appointment-booking.service';

@Injectable()
export class AppointmentWaitlistRecoveryService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentWaitlistRecoveryService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly bookingService: AppointmentBookingService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    void this.recover();
    const interval = this.configService.get<number>(
      'APPOINTMENT_WAITLIST_RECOVERY_INTERVAL_MS',
      60_000,
    );
    this.timer = setInterval(() => void this.recover(), interval);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async recover() {
    try {
      await this.bookingService.recoverExpiredWaitlistOffers();
    } catch (error) {
      this.logger.error('Appointment waitlist recovery failed', error);
    }
  }
}
