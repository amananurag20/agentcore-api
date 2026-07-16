import WebSocket from 'ws';
import { VoiceConversationRelayGateway } from './voice-conversation-relay.gateway';

type TestableGateway = {
  streamText(
    socket: { readyState: number; send: jest.Mock },
    content: string,
    language?: string,
  ): void;
  handleMessage(
    socket: {
      readyState: number;
      send: jest.Mock;
      close: jest.Mock;
    },
    session: {
      config: object;
      callSid?: string;
      generation: number;
      durationTimer: NodeJS.Timeout;
    },
    data: Buffer,
  ): Promise<void>;
};

describe('VoiceConversationRelayGateway', () => {
  it('streams interruptible text tokens and marks the final token', () => {
    const gateway = new VoiceConversationRelayGateway(
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableGateway;
    const socket = { readyState: WebSocket.OPEN, send: jest.fn() };

    gateway.streamText(socket, 'Hello there', 'en-US');

    const messages: Array<Record<string, unknown>> = [];
    for (const [value] of socket.send.mock.calls as Array<[string]>) {
      messages.push(JSON.parse(value) as Record<string, unknown>);
    }
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      type: 'text',
      token: 'Hello ',
      last: false,
      interruptible: true,
      preemptible: true,
      lang: 'en-US',
    });
    expect(messages[1]).toMatchObject({ token: 'there', last: true });
  });

  it('invalidates an in-flight AI reply when the caller interrupts', async () => {
    let resolvePrompt: (value: {
      type: 'text';
      content: string;
    }) => void = () => undefined;
    const promptResult = new Promise<{ type: 'text'; content: string }>(
      (resolve) => {
        resolvePrompt = resolve;
      },
    );
    const voiceService = {
      handleConversationRelayPrompt: jest.fn(() => promptResult),
      handleConversationRelayInterrupt: jest.fn().mockResolvedValue(undefined),
    };
    const gateway = new VoiceConversationRelayGateway(
      { get: jest.fn() } as never,
      {} as never,
      voiceService as never,
      {
        touch: jest.fn(),
        publish: jest.fn(),
      } as never,
    ) as unknown as TestableGateway;
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn(),
    };
    const session = {
      config: {},
      callSid: 'CA123',
      generation: 0,
      durationTimer: setTimeout(() => undefined, 60_000),
    };

    const pendingPrompt = gateway.handleMessage(
      socket,
      session,
      Buffer.from(
        JSON.stringify({
          type: 'prompt',
          voicePrompt: 'Please help',
          last: true,
        }),
      ),
    );
    await Promise.resolve();
    await gateway.handleMessage(
      socket,
      session,
      Buffer.from(JSON.stringify({ type: 'interrupt' })),
    );
    resolvePrompt({ type: 'text', content: 'Stale answer' });
    await pendingPrompt;
    clearTimeout(session.durationTimer);

    expect(voiceService.handleConversationRelayInterrupt).toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
  });
});
