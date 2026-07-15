import {
  KNOWLEDGE_INGESTION_JOB,
  KNOWLEDGE_INGESTION_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';

function setup(existing: unknown = null) {
  const add = jest.fn().mockResolvedValue({ id: 'job' });
  const remove = jest.fn().mockResolvedValue(undefined);
  const queueService = {
    add,
    remove,
    isEnabled: jest.fn().mockReturnValue(true),
  } as unknown as QueueService;
  const run = {
    id: 'run-123',
    sourceId: 'source-123',
    organizationId: 'org-demo',
    status: 'queued',
    queueJobId: 'knowledge-run-123',
  };
  const knowledgeIngestionRun = {
    findFirst: jest.fn().mockResolvedValue(existing),
    create: jest.fn().mockResolvedValue(run),
    update: jest.fn().mockResolvedValue(run),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    findMany: jest.fn().mockResolvedValue([run]),
  };
  const service = new KnowledgeIngestionQueueService(queueService, {
    knowledgeIngestionRun,
  } as never);
  return { service, add, remove, knowledgeIngestionRun, run };
}

describe('KnowledgeIngestionQueueService', () => {
  it('persists a run and uses a BullMQ-safe id derived from it', async () => {
    const { service, add } = setup();
    await service.enqueue({
      organizationId: 'org-demo',
      sourceId: 'source-123',
      reason: 'source_created',
    });
    expect(add).toHaveBeenCalledWith(
      KNOWLEDGE_INGESTION_QUEUE,
      KNOWLEDGE_INGESTION_JOB,
      expect.objectContaining({ runId: 'run-123' }),
      { jobId: 'knowledge-run-123' },
    );
  });

  it('does not enqueue duplicate active work for a source', async () => {
    const active = { id: 'active-run', status: 'processing' };
    const { service, add, knowledgeIngestionRun } = setup(active);
    await expect(
      service.enqueue({
        organizationId: 'org-demo',
        sourceId: 'source-123',
        reason: 'manual_retry',
      }),
    ).resolves.toBe(active);
    expect(add).not.toHaveBeenCalled();
    expect(knowledgeIngestionRun.create).not.toHaveBeenCalled();
  });

  it('removes queued work and marks its durable run cancelled', async () => {
    const { service, remove, knowledgeIngestionRun } = setup();
    await expect(service.requestCancellation('source-123')).resolves.toBe(1);
    expect(remove).toHaveBeenCalledWith(
      KNOWLEDGE_INGESTION_QUEUE,
      'knowledge-run-123',
    );
    expect(knowledgeIngestionRun.update).toHaveBeenCalled();
    expect(JSON.stringify(knowledgeIngestionRun.update.mock.calls)).toContain(
      '"status":"cancelled"',
    );
  });
});
