import { WhatsAppAssistantConfig, WhatsAppMessage } from '@prisma/client';
import { createHash } from 'crypto';
import { WhatsAppMediaService } from './whatsapp-media.service';

describe('WhatsAppMediaService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('retrieves the media URL, downloads with auth, scans, stores, and describes it', async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43]);
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/1',
            mime_type: 'image/jpeg',
            file_size: bytes.length,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(bytes, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(bytes.length),
          },
        }),
      );
    let updatedData: unknown;
    const update = jest.fn((input: { data: unknown }) => {
      updatedData = input.data;
      return Promise.resolve({});
    });
    const service = new WhatsAppMediaService(
      {
        describeImage: jest.fn().mockResolvedValue('A photographed receipt'),
      } as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      { decrypt: () => 'access-token' } as never,
      {} as never,
      { scan: jest.fn().mockResolvedValue({ status: 'clean' }) } as never,
      { whatsAppMessage: { update } } as never,
      {
        uploadWhatsAppMedia: jest.fn().mockResolvedValue({
          provider: 's3',
          bucket: 'bucket',
          key: 'whatsapp/org/image.jpg',
          sizeBytes: bytes.length,
          checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        }),
      } as never,
    );
    const config = {
      id: 'config-1',
      accessTokenEncrypted: 'encrypted',
      phoneNumberId: 'phone-1',
    } as WhatsAppAssistantConfig;
    const message = {
      id: 'message-1',
      organizationId: 'org-1',
      type: 'image',
      content: 'My receipt',
      mediaMimeType: 'image/jpeg',
      mediaSha256: createHash('sha256').update(bytes).digest('base64'),
      metadata: { mediaId: 'media-1', mediaFilename: 'receipt.jpg' },
    } as WhatsAppMessage;

    await expect(
      service.downloadStoreAndDescribe({ config, message }),
    ).resolves.toBe('A photographed receipt');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({
      Authorization: 'Bearer access-token',
    });
    expect(update).toHaveBeenCalled();
    expect(updatedData).toEqual(
      expect.objectContaining({
        mediaStorageBucket: 'bucket',
        mediaStorageKey: 'whatsapp/org/image.jpg',
      }),
    );
  });

  it('rejects a Meta CDN redirect to a non-Meta host before following it', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/1',
            mime_type: 'image/jpeg',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data' },
        }),
      );
    const service = new WhatsAppMediaService(
      {} as never,
      { get: (_key: string, fallback: unknown) => fallback } as never,
      { decrypt: () => 'access-token' } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      service.downloadStoreAndDescribe({
        config: {
          accessTokenEncrypted: 'encrypted',
          phoneNumberId: 'phone-1',
        } as WhatsAppAssistantConfig,
        message: {
          id: 'message-1',
          organizationId: 'org-1',
          type: 'image',
          metadata: { mediaId: 'media-1' },
        } as WhatsAppMessage,
      }),
    ).rejects.toThrow('invalid media URL');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
