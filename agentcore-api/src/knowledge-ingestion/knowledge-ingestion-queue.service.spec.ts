import {
  KNOWLEDGE_INGESTION_JOB,
  KNOWLEDGE_INGESTION_QUEUE,
} from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import { KnowledgeIngestionQueueService } from './knowledge-ingestion-queue.service';

describe('KnowledgeIngestionQueueService', () => {
  it('uses a BullMQ-safe custom job id', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(123456789);
    const add = jest.fn().mockResolvedValue({ id: 'job' });
    const queueService = {
      add,
      isEnabled: jest.fn().mockReturnValue(true),
    } as unknown as QueueService;
    const service = new KnowledgeIngestionQueueService(queueService);

    await service.enqueue({
      organizationId: 'org_demo',
      sourceId: '7628083b-69a1-4886-a186-54b9a65c6f32',
      reason: 'source_created',
    });

    expect(add).toHaveBeenCalledWith(
      KNOWLEDGE_INGESTION_QUEUE,
      KNOWLEDGE_INGESTION_JOB,
      {
        organizationId: 'org_demo',
        sourceId: '7628083b-69a1-4886-a186-54b9a65c6f32',
        reason: 'source_created',
      },
      {
        jobId: '7628083b-69a1-4886-a186-54b9a65c6f32-source_created-123456789',
      },
    );
    jest.restoreAllMocks();
  });
});
