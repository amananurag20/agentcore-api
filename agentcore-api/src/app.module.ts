import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { AIProvidersModule } from './ai-providers/ai-providers.module';
import { AppointmentBookingModule } from './appointment-booking/appointment-booking.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { RequestLoggingInterceptor } from './common/logging/request-logging.interceptor';
import { validateEnv } from './config/env.validation';
import { CustomerChatModule } from './customer-chat/customer-chat.module';
import { HealthModule } from './health/health.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ObservabilityModule } from './observability/observability.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { ProductsModule } from './products/products.module';
import { PolicyModule } from './policy/policy.module';
import { CustomRolesModule } from './custom-roles/custom-roles.module';
import { ProductAccessGuard } from './policy/product-access.guard';
import { UsersModule } from './users/users.module';
import { VoiceReceptionistModule } from './voice-receptionist/voice-receptionist.module';
import { WhatsAppAssistantModule } from './whatsapp-assistant/whatsapp-assistant.module';
import { ServicePrincipalsModule } from './service-principals/service-principals.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    AIProvidersModule,
    AppointmentBookingModule,
    AuditModule,
    AuthModule,
    CustomerChatModule,
    HealthModule,
    KnowledgeModule,
    ObservabilityModule,
    OrganizationsModule,
    ProductsModule,
    PolicyModule,
    CustomRolesModule,
    UsersModule,
    ServicePrincipalsModule,
    VoiceReceptionistModule,
    WhatsAppAssistantModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_INTERCEPTOR,
      useClass: RequestLoggingInterceptor,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ProductAccessGuard,
    },
  ],
})
export class AppModule {}
