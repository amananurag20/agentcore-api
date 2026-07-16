import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { VoiceReceptionistConfig } from '@prisma/client';
import { IncomingMessage, Server } from 'node:http';
import { Duplex } from 'node:stream';
import WebSocket, { RawData, WebSocketServer } from 'ws';
import { VoiceReceptionistService } from './voice-receptionist.service';
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
};

type RelaySession = {
  config: VoiceReceptionistConfig;
  callSid?: string;
  generation: number;
  durationTimer: NodeJS.Timeout;
};

@Injectable()
export class VoiceConversationRelayGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(VoiceConversationRelayGateway.name);
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024,
  });
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
    const match = request.url?.match(
      /^\/api\/v1\/voice-receptionist\/stream\/([^/?]+)(?:\?.*)?$/,
    );
    if (!match) return;
    const configId = decodeURIComponent(match[1]);
    void this.acceptUpgrade(configId, request, socket, head);
  };

  private async acceptUpgrade(
    configId: string,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    try {
      const signature = this.header(request, 'x-twilio-signature');
      const config = await this.voiceService.authorizeConversationRelay(
        configId,
        signature,
      );
      this.server.handleUpgrade(request, socket, head, (webSocket) => {
        this.openSession(webSocket, config);
      });
    } catch (error) {
      this.logger.warn(
        `Rejected ConversationRelay WebSocket for config=${configId}: ${error instanceof Error ? error.message : 'authorization failed'}`,
      );
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  }

  private openSession(
    webSocket: WebSocket,
    config: VoiceReceptionistConfig,
  ): void {
    const maxDurationSeconds = this.configService.get<number>(
      'VOICE_MAX_CALL_DURATION_SECONDS',
      1800,
    );
    const session: RelaySession = {
      config,
      generation: 0,
      durationTimer: setTimeout(() => {
        this.send(webSocket, {
          type: 'end',
          handoffData: JSON.stringify({
            action: 'close',
            reason: 'max-duration',
          }),
        });
      }, maxDurationSeconds * 1000),
    };
    webSocket.on('message', (data) => {
      void this.handleMessage(webSocket, session, data).catch((error) => {
        this.logger.error(
          `ConversationRelay message failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        this.streamText(
          webSocket,
          'I am sorry, I am having trouble answering right now. Please try again.',
        );
      });
    });
    webSocket.on('close', () => {
      clearTimeout(session.durationTimer);
      this.runtimeService.unregisterSession(session.callSid);
    });
    webSocket.on('error', (error) => {
      this.logger.warn(`ConversationRelay WebSocket error: ${error.message}`);
    });
  }

  private async handleMessage(
    webSocket: WebSocket,
    session: RelaySession,
    data: RawData,
  ): Promise<void> {
    let message: RelayMessage;
    try {
      const payload = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Buffer.from(new Uint8Array(data)).toString('utf8');
      message = JSON.parse(payload) as RelayMessage;
    } catch {
      webSocket.close(1007, 'Invalid JSON');
      return;
    }

    if (message.type === 'setup') {
      if (!message.callSid || !message.sessionId) {
        webSocket.close(1008, 'Invalid setup');
        return;
      }
      session.callSid = message.callSid;
      this.runtimeService.registerSession(
        session.config,
        message.callSid,
        (content, language) => this.streamText(webSocket, content, language),
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
    this.runtimeService.touch(session.callSid);

    if (message.type === 'interrupt') {
      session.generation += 1;
      await this.voiceService.handleConversationRelayInterrupt(
        session.config,
        session.callSid,
        message.utteranceUntilInterrupt,
        message.durationUntilInterruptMs,
      );
      this.runtimeService.publish({
        type: 'call.updated',
        organizationId: session.config.organizationId,
        providerCallId: session.callSid,
      });
      return;
    }

    if (message.type === 'prompt' && message.last === true) {
      const content = message.voicePrompt?.trim();
      if (!content) return;
      const generation = ++session.generation;
      const result = await this.voiceService.handleConversationRelayPrompt(
        session.config,
        session.callSid,
        content,
        undefined,
        message.lang,
      );
      this.runtimeService.publish({
        type: 'call.updated',
        organizationId: session.config.organizationId,
        providerCallId: session.callSid,
      });
      if (generation !== session.generation) return;
      if (result.type === 'end') {
        this.send(webSocket, result);
      } else {
        this.streamText(webSocket, result.content, result.language);
      }
      return;
    }

    if (message.type === 'dtmf' && message.digit) {
      const generation = ++session.generation;
      const result = await this.voiceService.handleConversationRelayPrompt(
        session.config,
        session.callSid,
        message.digit,
        message.digit,
      );
      this.runtimeService.publish({
        type: 'call.updated',
        organizationId: session.config.organizationId,
        providerCallId: session.callSid,
      });
      if (generation !== session.generation) return;
      if (result.type === 'end') this.send(webSocket, result);
      else this.streamText(webSocket, result.content, result.language);
    }
  }

  private streamText(
    webSocket: WebSocket,
    content: string,
    language?: string,
  ): void {
    const tokens = content.match(/\S+\s*/g) ?? [content];
    tokens.forEach((token, index) => {
      this.send(webSocket, {
        type: 'text',
        token,
        last: index === tokens.length - 1,
        interruptible: true,
        preemptible: true,
        ...(language ? { lang: language } : {}),
      });
    });
  }

  private send(webSocket: WebSocket, message: object): void {
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(JSON.stringify(message));
    }
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }
}
