export const PRODUCT_KEYS = [
  'customer_chat',
  'appointment_booking',
  'whatsapp_assistant',
  'voice_receptionist',
] as const;

export type ProductKey = (typeof PRODUCT_KEYS)[number];

export interface ProductAccessGrant {
  productKey: ProductKey;
  canUse: boolean;
  canConfigure: boolean;
  canManageAgents: boolean;
}

export type ProductAction = 'use' | 'configure' | 'manage_agents';
