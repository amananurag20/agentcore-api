import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Subscription } from 'rxjs';
import { Server as SocketIOServer, Socket } from 'socket.io';
import { RateLimitService } from '../rate-limit/rate-limit.service';
import { CustomerChatRealtimeService } from './customer-chat-realtime.service';
import { CustomerChatService } from './customer-chat.service';

type SocketAuth = {
  conversationId?: string;
  visitorToken?: string;
};

type MessageFrame = {
  clientMessageId?: string;
  content?: string;
};

type SocketSession = {
  conversationId: string;
  organizationId: string;
  visitorToken: string;
  clientIp: string;
  origin?: string;
  activeClientMessageId?: string;
  abortController?: AbortController;
  realtimeSubscription?: Subscription;
};

type AuthenticatedSocket = Socket & {
  data: Socket['data'] & {
    customerChatSession?: SocketSession;
  };
};

@Injectable()
export class CustomerChatGateway
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(CustomerChatGateway.name);
  private readonly sessions = new Map<string, SocketSession>();
  private readonly connectionsByConversation = new Map<string, number>();
  private server?: SocketIOServer;

  constructor(
    private readonly configService: ConfigService,
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly rateLimitService: RateLimitService,
    private readonly realtimeService: CustomerChatRealtimeService,
    private readonly customerChatService: CustomerChatService,
  ) {}

  onApplicationBootstrap(): void {
    const httpServer =
      this.httpAdapterHost.httpAdapter.getHttpServer() as HttpServer;
    const heartbeatMs = this.configService.get<number>(
      'CUSTOMER_CHAT_WS_HEARTBEAT_MS',
      25000,
    );
    this.server = new SocketIOServer(httpServer, {
      path: '/api/v1/customer-chat/widget/socket.io',
      serveClient: true,
      transports: ['websocket'],
      maxHttpBufferSize: 16 * 1024,
      perMessageDeflate: false,
      connectTimeout: this.configService.get<number>(
        'CUSTOMER_CHAT_WS_AUTH_TIMEOUT_MS',
        5000,
      ),
      pingInterval: heartbeatMs,
      pingTimeout: Math.max(5000, Math.round(heartbeatMs * 0.8)),
      cors: {
        origin: true,
        methods: ['GET'],
        credentials: false,
      },
    });
    this.server.use((socket, next) => {
      void this.authenticate(socket as AuthenticatedSocket)
        .then(() => next())
        .catch((error: unknown) => {
          const authError = new Error(this.publicErrorMessage(error)) as Error & {
            data?: Record<string, string>;
          };
          authError.data = {
            code: this.errorCode(error),
            message: this.publicErrorMessage(error),
          };
          next(authError);
        });
    });
    this.server.on('connection', (socket) =>
      this.openSession(socket as AuthenticatedSocket),
    );
  }

  onApplicationShutdown(): void {
    for (const socket of this.server?.sockets.sockets.values() ?? []) {
      socket.disconnect(true);
    }
    this.server?.close();
    this.server = undefined;
  }

  private async authenticate(socket: AuthenticatedSocket): Promise<void> {
    const maxConnections = this.configService.get<number>(
      'CUSTOMER_CHAT_WS_MAX_CONNECTIONS',
      2000,
    );
    if (this.sessions.size >= maxConnections) {
      throw Object.assign(new Error('Too many active connections'), {
        status: 503,
      });
    }
    const auth = (socket.handshake.auth ?? {}) as SocketAuth;
    if (!auth.conversationId || !auth.visitorToken) {
      throw Object.assign(new Error('Invalid visitor authentication'), {
        status: 401,
      });
    }
    const clientIp = this.resolveClientIp(socket.request);
    const origin =
      this.header(socket.request, 'origin') ??
      this.header(socket.request, 'referer');
    await this.rateLimitService.consume(
      `public-chat:socket-auth:ip:${clientIp}`,
      this.configService.get<number>(
        'PUBLIC_CHAT_MAX_CONFIG_FETCHES_PER_WINDOW',
        120,
      ),
      this.configService.get<number>(
        'PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS',
        60,
      ),
    );
    const authorized = await this.customerChatService.authorizePublicSocket(
      auth.conversationId,
      auth.visitorToken,
      origin,
    );
    const maxPerConversation = this.configService.get<number>(
      'CUSTOMER_CHAT_WS_MAX_CONNECTIONS_PER_CONVERSATION',
      5,
    );
    const count =
      this.connectionsByConversation.get(authorized.conversationId) ?? 0;
    if (count >= maxPerConversation) {
      throw Object.assign(new Error('Too many conversation connections'), {
        status: 429,
      });
    }
    socket.data.customerChatSession = {
      conversationId: authorized.conversationId,
      organizationId: authorized.organizationId,
      visitorToken: auth.visitorToken,
      clientIp,
      origin,
    };
  }

  private openSession(socket: AuthenticatedSocket): void {
    const session = socket.data.customerChatSession;
    if (!session) {
      socket.disconnect(true);
      return;
    }
    this.sessions.set(socket.id, session);
    const count =
      this.connectionsByConversation.get(session.conversationId) ?? 0;
    this.connectionsByConversation.set(session.conversationId, count + 1);
    session.realtimeSubscription = this.realtimeService
      .streamPublicConversation(session.conversationId)
      .subscribe({
        next: (event) => {
          if (event.type !== 'heartbeat') {
            socket.emit('conversation.event', event.data);
          }
        },
      });
    socket.on('message.send', (frame: MessageFrame) => {
      void this.generateReply(socket, session, frame).catch((error) => {
        this.logger.warn(
          `Customer chat Socket.IO message failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        socket.emit('message.error', {
          clientMessageId: frame?.clientMessageId,
          code: this.errorCode(error),
          message: this.publicErrorMessage(error),
        });
      });
    });
    socket.on(
      'message.cancel',
      (frame: Pick<MessageFrame, 'clientMessageId'>) => {
        if (
          frame?.clientMessageId &&
          frame.clientMessageId === session.activeClientMessageId
        ) {
          session.abortController?.abort(
            new DOMException('Cancelled', 'AbortError'),
          );
        }
      },
    );
    socket.once('disconnect', () => this.cleanupSession(socket, session));
    socket.emit('ready', {
      conversationId: session.conversationId,
      protocolVersion: 2,
      transport: 'socket.io',
    });
  }

  private async generateReply(
    socket: AuthenticatedSocket,
    session: SocketSession,
    frame: MessageFrame,
  ): Promise<void> {
    const content = frame?.content?.trim();
    const clientMessageId = frame?.clientMessageId?.trim();
    if (
      !content ||
      content.length > 2000 ||
      !clientMessageId ||
      clientMessageId.length > 100
    ) {
      socket.emit('message.error', {
        clientMessageId,
        code: 'invalid_message',
        message: 'Message is invalid or too long.',
      });
      return;
    }
    if (session.activeClientMessageId) {
      socket.emit('message.error', {
        clientMessageId,
        code: 'generation_in_progress',
        message: 'A reply is already being generated.',
      });
      return;
    }
    await this.rateLimitService.consume(
      `public-chat:socket-message:ip:${session.clientIp}`,
      this.configService.get<number>('PUBLIC_CHAT_MAX_MESSAGES_PER_WINDOW', 20),
      this.configService.get<number>(
        'PUBLIC_CHAT_RATE_LIMIT_WINDOW_SECONDS',
        60,
      ),
    );
    const leaseToken = randomUUID();
    const leaseKey = `customer-chat:generation:${session.conversationId}`;
    const leaseAcquired = await this.rateLimitService.acquireLease(
      leaseKey,
      leaseToken,
      this.configService.get<number>(
        'CUSTOMER_CHAT_GENERATION_LEASE_SECONDS',
        180,
      ),
    );
    if (!leaseAcquired) {
      socket.emit('message.error', {
        clientMessageId,
        code: 'generation_in_progress',
        message: 'A reply is already being generated for this conversation.',
      });
      return;
    }
    const abortController = new AbortController();
    session.activeClientMessageId = clientMessageId;
    session.abortController = abortController;
    socket.emit('message.started', { clientMessageId });
    try {
      const result = await this.customerChatService.sendPublicMessageStreaming(
        session.conversationId,
        { content, clientMessageId },
        session.visitorToken,
        session.origin,
        {
          signal: abortController.signal,
          onDelta: (delta) => {
            socket.emit('message.delta', { clientMessageId, delta });
          },
          onReplace: (message) => {
            socket.emit('message.replace', {
              clientMessageId,
              content: message,
            });
          },
        },
      );
      if (abortController.signal.aborted) {
        socket.emit('message.cancelled', { clientMessageId });
      } else {
        socket.emit('message.completed', { clientMessageId, result });
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        socket.emit('message.cancelled', { clientMessageId });
      } else {
        throw error;
      }
    } finally {
      session.activeClientMessageId = undefined;
      session.abortController = undefined;
      await this.rateLimitService.releaseLease(leaseKey, leaseToken);
    }
  }

  private cleanupSession(
    socket: AuthenticatedSocket,
    session: SocketSession,
  ): void {
    if (!this.sessions.delete(socket.id)) return;
    session.abortController?.abort(
      new DOMException('Socket disconnected', 'AbortError'),
    );
    session.realtimeSubscription?.unsubscribe();
    const count =
      this.connectionsByConversation.get(session.conversationId) ?? 1;
    if (count <= 1) {
      this.connectionsByConversation.delete(session.conversationId);
    } else {
      this.connectionsByConversation.set(session.conversationId, count - 1);
    }
  }

  private resolveClientIp(request: IncomingMessage): string {
    const trustedHops = Math.max(
      0,
      this.configService.get<number>('TRUST_PROXY_HOPS', 0),
    );
    const remote = request.socket.remoteAddress ?? 'unknown';
    if (!trustedHops) return remote;
    const forwarded =
      this.header(request, 'x-forwarded-for')
        ?.split(',')
        .map((entry) => entry.trim())
        .filter(Boolean) ?? [];
    const chain = [...forwarded, remote];
    return chain[Math.max(0, chain.length - trustedHops - 1)] ?? remote;
  }

  private header(request: IncomingMessage, name: string): string | undefined {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private errorCode(error: unknown): string {
    const status =
      typeof error === 'object' && error && 'status' in error
        ? Number(error.status)
        : 500;
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'origin_forbidden';
    if (status === 404) return 'not_found';
    if (status === 429) return 'rate_limited';
    if (status === 503) return 'unavailable';
    return 'generation_failed';
  }

  private publicErrorMessage(error: unknown): string {
    const code = this.errorCode(error);
    if (code === 'rate_limited') {
      return 'Too many requests. Please wait and try again.';
    }
    if (code === 'origin_forbidden') {
      return 'This website is not authorized to use this widget.';
    }
    if (code === 'unauthorized' || code === 'not_found') {
      return 'The visitor session is no longer valid.';
    }
    if (code === 'unavailable') {
      return 'Chat is temporarily at capacity. Please try again shortly.';
    }
    return 'The reply could not be completed. Please try again.';
  }
}
