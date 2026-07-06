import { PrismaClient } from '@prisma/client';
import { hash } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  await prisma.organization.upsert({
    where: { id: 'org_demo' },
    create: {
      id: 'org_demo',
      name: 'Demo Organization',
      slug: 'demo-organization',
      status: 'active',
      plan: 'free',
      deploymentMode: 'saas',
    },
    update: {
      name: 'Demo Organization',
      slug: 'demo-organization',
      status: 'active',
      plan: 'free',
      deploymentMode: 'saas',
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
      isActive: true,
    },
    update: {
      orgId: 'org_demo',
      name: 'AgentCore Admin',
      roles: ['super_admin', 'org_admin'],
      isActive: true,
    },
  });
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
