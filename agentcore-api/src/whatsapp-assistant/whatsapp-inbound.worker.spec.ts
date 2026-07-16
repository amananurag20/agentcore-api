import type { Job } from 'bullmq';
import { WHATSAPP_INBOUND_JOB } from '../queue/queue.constants';
import { WhatsAppInboundWorker } from './whatsapp-inbound.worker';
import type { WhatsAppInboundJobData } from './whatsapp-inbound-queue.service';

describe('WhatsAppInboundWorker', () => {
  function createWorker(service: {
    processInboundMessage: jest.Mock<Promise<void>, [string]>;
    recoverInboundFailure: jest.Mock<Promise<void>, [string, unknown]>;
  }) {
    return new WhatsAppInboundWorker(
      { get: jest.fn() } as never,
      service as never,
    ) as unknown as {
      process(job: Job<WhatsAppInboundJobData>): Promise<void>;
    };
  }

  function createJob(attemptsMade: number) {
    return {
      name: WHATSAPP_INBOUND_JOB,
      data: { messageId: 'message-1' },
      attemptsMade,
      opts: { attempts: 3 },
    } as Job<WhatsAppInboundJobData>;
  }

  it('retries transient failures without handing off early', async () => {
    const error = new Error('temporary failure');
    const service = {
      processInboundMessage: jest.fn().mockRejectedValue(error),
      recoverInboundFailure: jest.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker(service);

    await expect(worker.process(createJob(1))).rejects.toBe(error);
    expect(service.recoverInboundFailure).not.toHaveBeenCalled();
  });

  it('recovers with human handoff after the final failed attempt', async () => {
    const error = new Error('persistent failure');
    const service = {
      processInboundMessage: jest.fn().mockRejectedValue(error),
      recoverInboundFailure: jest.fn().mockResolvedValue(undefined),
    };
    const worker = createWorker(service);

    await expect(worker.process(createJob(2))).resolves.toBeUndefined();
    expect(service.recoverInboundFailure).toHaveBeenCalledWith(
      'message-1',
      error,
    );
  });
});
