import WebSocket from 'ws';
import { VoiceConversationRelayGateway } from './voice-conversation-relay.gateway';

type TestableGateway = {
  streamText(
    socket: { readyState: number; send: jest.Mock },
    content: string,
    language?: string,
  ): Promise<void>;
  handleMessage(
    socket: {
      readyState: number;
      send: jest.Mock;
      close: jest.Mock;
    },
    session: {
      config: object;
      authorization: { expectedCallSid: string };
      connectionId: string;
      callSid?: string;
      generation: number;
      durationTimer: NodeJS.Timeout;
      activePrompt?: { controller: AbortController; generation: number };
      closed: boolean;
    },
    data: Buffer,
  ): Promise<void>;
};

describe('VoiceConversationRelayGateway', () => {
  it('streams interruptible text tokens and marks the final token', async () => {
    const gateway = new VoiceConversationRelayGateway(
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableGateway;
    const socket = { readyState: WebSocket.OPEN, send: jest.fn() };

    await gateway.streamText(socket, 'Hello there', 'en-US');

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

  it('waits for the outbound WebSocket buffer to drain before sending', async () => {
    const gateway = new VoiceConversationRelayGateway(
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'VOICE_WS_MAX_BUFFERED_BYTES' ? 100 : fallback,
        ),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableGateway;
    let bufferedAmount = 200;
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      get bufferedAmount() {
        return bufferedAmount;
      },
    };
    setTimeout(() => {
      bufferedAmount = 0;
    }, 20);

    await gateway.streamText(socket, 'Hello');
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('closes a relay whose outbound buffer remains stalled', async () => {
    const gateway = new VoiceConversationRelayGateway(
      {
        get: jest.fn((key: string, fallback?: unknown) => {
          if (key === 'VOICE_WS_MAX_BUFFERED_BYTES') return 100;
          if (key === 'VOICE_WS_BACKPRESSURE_TIMEOUT_MS') return 20;
          return fallback;
        }),
      } as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableGateway;
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 200,
      send: jest.fn(),
      close: jest.fn(),
    };

    await expect(gateway.streamText(socket, 'Hello')).rejects.toThrow(
      'outbound buffer stalled',
    );
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(1013, 'Outbound buffer stalled');
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
      authorization: { expectedCallSid: 'CA123' },
      connectionId: 'socket-1',
      callSid: 'CA123',
      generation: 0,
      durationTimer: setTimeout(() => undefined, 60_000),
      closed: false,
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

  it('rejects setup when Twilio presents a CallSid not bound to the ticket', async () => {
    const gateway = new VoiceConversationRelayGateway(
      { get: jest.fn() } as never,
      {} as never,
      {} as never,
      {} as never,
    ) as unknown as TestableGateway;
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn(),
    };
    const session = {
      config: { id: 'config-1' },
      authorization: { expectedCallSid: 'CA-expected' },
      connectionId: 'socket-1',
      generation: 0,
      durationTimer: setTimeout(() => undefined, 60_000),
      closed: false,
    };

    await gateway.handleMessage(
      socket,
      session,
      Buffer.from(
        JSON.stringify({
          type: 'setup',
          sessionId: 'VX123',
          callSid: 'CA-attacker',
        }),
      ),
    );
    clearTimeout(session.durationTimer);
    expect(socket.close).toHaveBeenCalledWith(1008, 'Invalid setup');
  });

  it('forwards model deltas immediately and then marks the talk cycle final', async () => {
    const voiceService = {
      handleConversationRelayPrompt: jest.fn(async (...args: unknown[]) => {
        const callbacks = args[5] as {
          onDelta: (delta: string) => Promise<void>;
        };
        await callbacks.onDelta('Hello ');
        await callbacks.onDelta('there');
        return { type: 'text', content: 'Hello there' };
      }),
    };
    const gateway = new VoiceConversationRelayGateway(
      { get: jest.fn() } as never,
      {} as never,
      voiceService as never,
      { touch: jest.fn(), publish: jest.fn() } as never,
    ) as unknown as TestableGateway;
    const socket = {
      readyState: WebSocket.OPEN,
      send: jest.fn(),
      close: jest.fn(),
    };
    const session = {
      config: { organizationId: 'org-1' },
      authorization: { expectedCallSid: 'CA123' },
      connectionId: 'socket-1',
      callSid: 'CA123',
      generation: 0,
      durationTimer: setTimeout(() => undefined, 60_000),
      closed: false,
    };

    await gateway.handleMessage(
      socket,
      session,
      Buffer.from(
        JSON.stringify({
          type: 'prompt',
          voicePrompt: 'Hi',
          lang: 'en-US',
          last: true,
        }),
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));
    clearTimeout(session.durationTimer);
    const sent = (socket.send.mock.calls as Array<[string]>).map(
      ([raw]) => JSON.parse(raw) as Record<string, unknown>,
    );
    expect(sent).toEqual([
      expect.objectContaining({ token: 'Hello ', last: false }),
      expect.objectContaining({ token: 'there', last: false }),
      expect.objectContaining({ token: '', last: true }),
    ]);
  });
});
