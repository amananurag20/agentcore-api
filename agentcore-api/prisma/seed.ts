import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

const products = [
  {
    key: 'customer_chat',
    name: 'Customer Chat',
    description: 'AI-powered customer chat with grounded answers and handoff.',
  },
  {
    key: 'appointment_booking',
    name: 'Appointment Booking',
    description:
      'Calendar-aware booking, rescheduling, reminders, and availability.',
  },
  {
    key: 'whatsapp_assistant',
    name: 'WhatsApp Assistant',
    description:
      'WhatsApp Business assistant with media support and human handoff.',
  },
  {
    key: 'voice_receptionist',
    name: 'Voice Receptionist',
    description:
      'AI voice receptionist for calls, routing, transcripts, and voicemail.',
  },
] as const;

async function main() {
  await prisma.organization.upsert({
    where: { id: 'org_demo' },
    create: {
      id: 'org_demo',
      name: 'Platform Test Workspace',
      slug: 'platform-test-workspace',
      status: 'active',
      plan: 'free',
      deploymentMode: 'saas',
      isSystem: true,
    },
    update: {
      name: 'Platform Test Workspace',
      slug: 'platform-test-workspace',
      status: 'active',
      plan: 'free',
      deploymentMode: 'saas',
      isSystem: true,
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@agentcore.local' },
    create: {
      orgId: 'org_demo',
      email: 'admin@agentcore.local',
      name: 'AgentCore Admin',
      passwordHash: await hash('Admin@12345', 12),
      roles: ['super_admin', 'org_admin'],
      clearanceLevel: 4,
      isActive: true,
    },
    update: {
      orgId: 'org_demo',
      name: 'AgentCore Admin',
      roles: ['super_admin', 'org_admin'],
      clearanceLevel: 4,
      isActive: true,
    },
  });

  for (const product of products) {
    const savedProduct = await prisma.product.upsert({
      where: { key: product.key },
      create: {
        key: product.key,
        name: product.name,
        description: product.description,
        status: 'active',
      },
      update: {
        name: product.name,
        description: product.description,
        status: 'active',
      },
    });

    await prisma.organizationProduct.upsert({
      where: {
        organizationId_productId: {
          organizationId: 'org_demo',
          productId: savedProduct.id,
        },
      },
      create: {
        organizationId: 'org_demo',
        productId: savedProduct.id,
        status: 'enabled',
      },
      update: { status: 'enabled' },
    });
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
