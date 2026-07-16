import { Module } from '@nestjs/common';
import { ProviderEndpointPolicyService } from './provider-endpoint-policy.service';

@Module({
  providers: [ProviderEndpointPolicyService],
  exports: [ProviderEndpointPolicyService],
})
export class ProviderEndpointPolicyModule {}
