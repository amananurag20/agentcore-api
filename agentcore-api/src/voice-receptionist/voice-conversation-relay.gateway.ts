import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { VoiceReceptionistConfig } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import {
  AuthorizedConversationRelay,
  VoiceReceptionistService,
} from './voice-receptionist.service';
import { VoiceRuntimeService } from './voice-runtime.service';

type RelayMessage = {
  type?: string;
  sessionId?: string;
  callSid?: string;
  from?: string;
  to?: string;
  voicePrompt?: string;
  lang?: string;
  last?: boolean;
  digit?: string;
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
  customParameters?: Record<string, string>;
};

type RelaySession = {
  authorization: AuthorizedConversationRelay;
  config: VoiceReceptionistConfig;
  connectionId: string;
  callSid?: string;
  generation: number;
  durationTimer: NodeJS.Timeout;
  queue: Promise<void>;
  pendingMessages: number;
  activePrompt?: { controller: AbortController; generation: number };
  dtmfBuffer: string;
  dtmfTimer?: NodeJS.Timeout;
  closed: boolean;
};

@Injectable()
export class VoiceConversationRelayGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VoiceConversationRelayGateway.name);
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
    perMessageDeflate: false,
  });
  private readonly activeByConfig = new Map<string, number>();
  private readonly outboundQueues = new WeakMap<WebSocket, Promise<void>>();
  private pendingUpgrades = 0;
  private httpServer?: Server;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly voiceService: VoiceReceptionistService,
    private readonly runtimeService: VoiceRuntimeService,
  ) {}

  onApplicationBootstrap(): void {
    this.httpServer =
      this.httpAdapterHost.httpAdapter.getHttpServer() as Server;
    this.httpServer.on('upgrade', this.handleUpgrade);
  }

  onApplicationShutdown(): void {
    this.httpServer?.off('upgrade', this.handleUpgrade);
    for (const client of this.server.clients) client.terminate();
    this.server.close();
  }

  private readonly handleUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const parsed = new URL(request.url ?? '/', 'http://voice.local');
    const match = parsed.pathname.match(
      /^\/api\/v1\/voice-receptionist\/stream\/([^/]+)$/,
    );
    if (!match) return;
    const configId = decodeURIComponent(match[1]);
    void this.acceptUpgrade(
      configId,
      parsed.searchParams.get('relayToken') ?? undefined,
      request,
      socket,
      head,
    );
  };

  private async acceptUpgrade(
    configId: string,
    relayToken: string | undefined,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const maxConnections = this.configService.get<number>(
      'VOICE_WS_MAX_CONNECTIONS',
      250,
    );
    const maxPerConfig = this.configService.get<number>(
      'VOICE_WS_MAX_CONNECTIONS_PER_CONFIG',
      50,
    );
    if (
      this.server.clients.size + this.pendingUpgrades >= maxConnections ||
      (this.activeByConfig.get(configId) ?? 0) >= maxPerConfig
    ) {
      this.rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }

    const connectionId = randomUUID();
    const distributedSlot = await this.runtimeService.acquireWebSocketSlot(
      configId,
      connectionId,
    );
    if (!distributedSlot) {
      this.rejectUpgrade(socket, 429, 'Too Many Requests');
      return;
    }
    let upgraded = false;
    this.pendingUpgrades += 1;
    try {
      const authorization = await this.voiceService.authorizeConversationRelay(
        configId,
        relayToken,
        connectionId,
        this.header(request, 'x-twilio-signature'),
        this.publicRequestUrl(request),
      );
      if (
        this.server.clients.size >= maxConnections ||
        (this.activeByConfig.get(configId) ?? 0) >= maxPerConfig
      ) {
        await this.voiceService.releaseConversationRelay(
          authorization.ticketId,
          connectionId,
        );
        this.rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
      }
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        upgraded = true;
        this.openSession(webSocket, authorization);
      });
    } catch (error) {
      this.logger.warn(
        `Rejected ConversationRelay WebSocket for config=${configId}: ${error instanceof Error ? error.message : 'authorization failed'}`,
      );
      this.rejectUpgrade(socket, 403, 'Forbidden');
    } finally {
      this.pendingUpgrades = Math.max(0, this.pendingUpgrades - 1);
      if (!upgraded) {
        await this.runtimeService.releaseWebSocketSlot(configId, connectionId);
      }
    }
  }

  private openSession(
    webSocket: WebSocket,
    authorization: AuthorizedConversationRelay,
  ): void {
    const config = authorization.config;
    this.activeByConfig.set(
      config.id,
      (this.activeByConfig.get(config.id) ?? 0) + 1,
    );
    const maxDurationSeconds = this.configService.get<number>(
      'VOICE_MAX_CALL_DURATION_SECONDS',
      1800,
    );
    const session: RelaySession = {
      authorization,
      config,
      connectionId: authorization.connectionId,
      generation: 0,
      durationTimer: setTimeout(() => {
        session.activePrompt?.controller.abort('max-duration');
        void this.send(webSocket, {
          type: 'end',
          handoffData: JSON.stringify({
            action: 'close',
            reason: 'max-duration',
          }),
        });
      }, maxDurationSeconds * 1000),
      queue: Promise.resolve(),
      pendingMessages: 0,
      dtmfBuffer: '',
      closed: false,
    };
    webSocket.on('message', (data) => this.enqueue(webSocket, session, data));
    webSocket.on('close', () => void this.closeSession(session));
    webSocket.on('error', (error) => {
      this.logger.warn(`ConversationRelay WebSocket error: ${error.message}`);
    });
  }

  private enqueue(
    webSocket: WebSocket,
    session: RelaySession,
    data: RawData,
  ): void {
    const maxPending = this.configService.get<number>(
      'VOICE_WS_MAX_PENDING_MESSAGES',
      32,
    );
    if (session.pendingMessages >= maxPending) {
      webSocket.close(1013, 'Message backlog exceeded');
      return;
    }
    session.pendingMessages += 1;
    session.queue = session.queue
      .then(() => this.handleMessage(webSocket, session, data))
      .catch(async (error) => {
        this.logger.error(
          `ConversationRelay message failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        await this.streamText(
          webSocket,
          'I am sorry, I am having trouble answering right now. Please try again.',
        );
      })
      .finally(() => {
        session.pendingMessages = Math.max(0, session.pendingMessages - 1);
      });
  }

  private async handleMessage(
    webSocket: WebSocket,
    session: RelaySession,
    data: RawData,
  ): Promise<void> {
    const message = this.parseMessage(data);
    if (!message) {
      webSocket.close(1007, 'Invalid JSON');
      return;
    }

    if (message.type === 'setup') {
      if (
        session.callSid ||
        !message.callSid ||
        !message.sessionId ||
        message.callSid !== session.authorization.expectedCallSid ||
        (message.customParameters?.configId &&
          message.customParameters.configId !== session.config.id)
      ) {
        webSocket.close(1008, 'Invalid setup');
        return;
      }
      session.callSid = message.callSid;
      this.runtimeService.registerSession(
        session.config,
        message.callSid,
        session.connectionId,
        (content, language) => this.streamText(webSocket, content, language),
        () => webSocket.close(1012, 'Session replaced'),
      );
      await this.voiceService.handleConversationRelaySetup(session.config, {
        sessionId: message.sessionId,
        callSid: message.callSid,
        from: message.from,
        to: message.to,
      });
      this.runtimeService.publish({
        type: 'call.updated',
        organizationId: session.config.organizationId,
        providerCallId: message.callSid,
      });
      return;
    }

    if (!session.callSid) {
      webSocket.close(1008, 'Setup required');
      return;
    }
    this.runtimeService.touch(session.callSid, session.connectionId);

    if (message.type === 'interrupt') {
      session.generation += 1;
      session.activePrompt?.controller.abort('caller-interrupt');
      session.activePrompt = undefined;
      await this.voiceService.handleConversationRelayInterrupt(
        session.config,
        session.callSid,
        message.utteranceUntilInterrupt,
        message.durationUntilInterruptMs,
      );
      this.publishCallUpdate(session);
      return;
    }

    if (message.type === 'prompt' && message.last === true) {
      const content = message.voicePrompt?.trim();
      if (content)
        this.beginPrompt(webSocket, session, content, undefined, message.lang);
      return;
    }

    if (message.type === 'dtmf' && message.digit) {
      session.dtmfBuffer = `${session.dtmfBuffer}${message.digit}`.slice(-16);
      if (session.dtmfTimer) clearTimeout(session.dtmfTimer);
      const interDigitMs = this.configService.get<number>(
        'VOICE_DTMF_INTER_DIGIT_TIMEOUT_MS',
        800,
      );
      session.dtmfTimer = setTimeout(() => {
        const digits = session.dtmfBuffer;
        session.dtmfBuffer = '';
        session.dtmfTimer = undefined;
        if (digits && !session.closed) {
          this.beginPrompt(webSocket, session, digits, digits, message.lang);
        }
      }, interDigitMs);
      session.dtmfTimer.unref();
    }
  }

  private beginPrompt(
    webSocket: WebSocket,
    session: RelaySession,
    content: string,
    digit?: string,
    language?: string,
  ): void {
    session.activePrompt?.controller.abort('new-prompt');
    const controller = new AbortController();
    const generation = ++session.generation;
    session.activePrompt = { controller, generation };
    let streamed = false;
    void this.voiceService
      .handleConversationRelayPrompt(
        session.config,
        session.callSid!,
        content,
        digit,
        language,
        {
          signal: controller.signal,
          onDelta: async (delta) => {
            if (
              controller.signal.aborted ||
              generation !== session.generation ||
              !delta
            ) {
              return;
            }
            streamed = true;
            await this.streamDelta(webSocket, delta, language, false);
          },
          onReplace: async (replacement) => {
            if (generation !== session.generation) return;
            streamed = Boolean(replacement);
            if (replacement) {
              await this.streamDelta(webSocket, replacement, language, false);
            }
          },
        },
      )
      .then(async (result) => {
        this.publishCallUpdate(session);
        if (
          controller.signal.aborted ||
          generation !== session.generation ||
          session.closed
        ) {
          return;
        }
        if (result.type === 'end') {
          await this.send(webSocket, result);
        } else if (streamed) {
          await this.streamDelta(
            webSocket,
            '',
            result.language ?? language,
            true,
          );
        } else {
          await this.streamText(
            webSocket,
            result.content,
            result.language ?? language,
          );
        }
      })
      .catch(async (error) => {
        if (controller.signal.aborted || this.isAbortError(error)) return;
        this.logger.error(
          `ConversationRelay prompt failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        if (generation === session.generation) {
          await this.streamText(
            webSocket,
            'I am sorry, I am having trouble answering right now. Please try again.',
            language,
          );
        }
      })
      .finally(() => {
        if (session.activePrompt?.generation === generation) {
          session.activePrompt = undefined;
        }
      });
  }

  private async closeSession(session: RelaySession): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.durationTimer);
    if (session.dtmfTimer) clearTimeout(session.dtmfTimer);
    session.activePrompt?.controller.abort('socket-closed');
    this.runtimeService.unregisterSession(
      session.callSid,
      session.connectionId,
    );
    this.activeByConfig.set(
      session.config.id,
      Math.max(0, (this.activeByConfig.get(session.config.id) ?? 1) - 1),
    );
    if ((this.activeByConfig.get(session.config.id) ?? 0) === 0) {
      this.activeByConfig.delete(session.config.id);
    }
    await this.voiceService
      .releaseConversationRelay(
        session.authorization.ticketId,
        session.connectionId,
      )
      .catch(() => undefined);
    await this.runtimeService.releaseWebSocketSlot(
      session.config.id,
      session.connectionId,
    );
  }

  private publishCallUpdate(session: RelaySession): void {
    this.runtimeService.publish({
      type: 'call.updated',
      organizationId: session.config.organizationId,
      providerCallId: session.callSid,
    });
  }

  private parseMessage(data: RawData): RelayMessage | undefined {
    try {
      const payload = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(new Uint8Array(data)).toString('utf8');
      return JSON.parse(payload) as RelayMessage;
    } catch {
      return undefined;
    }
  }

  private async streamText(
    webSocket: WebSocket,
    content: string,
    language?: string,
  ): Promise<void> {
    const tokens = content.match(/\S+\s*/g) ?? [content];
    for (const [index, token] of tokens.entries()) {
      await this.streamDelta(
        webSocket,
        token,
        language,
        index === tokens.length - 1,
      );
    }
  }

  private async streamDelta(
    webSocket: WebSocket,
    token: string,
    language: string | undefined,
    last: boolean,
  ): Promise<void> {
    await this.send(webSocket, {
      type: 'text',
      token,
      last,
      interruptible: true,
      preemptible: true,
      ...(language ? { lang: language } : {}),
    });
  }

  private send(webSocket: WebSocket, message: object): Promise<void> {
    const previous = this.outboundQueues.get(webSocket) ?? Promise.resolve();
    const pending = previous.then(() =>
      this.writeWithBackpressure(webSocket, message),
    );
    this.outboundQueues.set(
      webSocket,
      pending.catch(() => undefined),
    );
    return pending;
  }

  private async writeWithBackpressure(
    webSocket: WebSocket,
    message: object,
  ): Promise<void> {
    const maxBufferedBytes = this.configService.get<number>(
      'VOICE_WS_MAX_BUFFERED_BYTES',
      1_048_576,
    );
    const timeoutMs = this.configService.get<number>(
      'VOICE_WS_BACKPRESSURE_TIMEOUT_MS',
      2_000,
    );
    const startedAt = Date.now();
    while (webSocket.bufferedAmount > maxBufferedBytes) {
      if (webSocket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - startedAt >= timeoutMs) {
        webSocket.close(1013, 'Outbound buffer stalled');
        throw new Error('ConversationRelay outbound buffer stalled');
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(message));
    }
  }

  private publicRequestUrl(request: IncomingMessage): string | undefined {
    const configured = this.configService
      .get<string>('VOICE_CONVERSATION_RELAY_PUBLIC_BASE_URL')
      ?.replace(/\/$/, '');
    if (configured) return `${configured}${request.url ?? ''}`;
    const host =
      this.header(request, 'x-forwarded-host') ?? request.headers.host;
    return host ? `wss://${host}${request.url ?? ''}` : undefined;
  }

  private rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    socket.write(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
    socket.destroy();
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private isAbortError(error: unknown): boolean {
    return (
      (error instanceof Error && error.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' &&
        error instanceof DOMException &&
        error.name === 'AbortError')
    );
  }
}
