import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, catchError, tap, throwError } from 'rxjs';
import { randomUUID } from 'crypto';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

@Injectable()
export class RequestLoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpRequest');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const response = context.switchToHttp().getResponse<Response>();
    const startedAt = Date.now();
    const requestId = this.resolveRequestId(request);
    response.setHeader('x-request-id', requestId);

    return next.handle().pipe(
      tap(() => {
        this.writeLog('info', request, response, requestId, startedAt);
      }),
      catchError((error: unknown) => {
        this.writeLog('error', request, response, requestId, startedAt, error);
        return throwError(() => error);
      }),
    );
  }

  private writeLog(
    level: 'info' | 'error',
    request: AuthenticatedRequest,
    response: Response,
    requestId: string,
    startedAt: number,
    error?: unknown,
  ) {
    const statusCode =
      error instanceof HttpException ? error.getStatus() : response.statusCode;
    const payload = {
      event: 'http_request',
      requestId,
      method: request.method,
      path: request.originalUrl ?? request.url,
      statusCode,
      durationMs: Date.now() - startedAt,
      userId: request.user?.sub,
      organizationId: request.user?.orgId,
      ip: this.resolveClientIp(request),
      userAgent: request.headers['user-agent'],
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    };

    const message = JSON.stringify(payload);

    if (level === 'error') {
      this.logger.error(message);
      return;
    }

    this.logger.log(message);
  }

  private resolveRequestId(request: AuthenticatedRequest): string {
    const requestId = request.headers['x-request-id'];

    if (typeof requestId === 'string' && requestId.trim()) {
      return requestId.trim();
    }

    if (Array.isArray(requestId) && requestId[0]?.trim()) {
      return requestId[0].trim();
    }

    return randomUUID();
  }

  private resolveClientIp(request: AuthenticatedRequest): string | undefined {
    const forwardedFor = request.headers['x-forwarded-for'];

    if (typeof forwardedFor === 'string' && forwardedFor.length > 0) {
      return forwardedFor.split(',')[0].trim();
    }

    if (Array.isArray(forwardedFor) && forwardedFor[0]) {
      return forwardedFor[0].split(',')[0].trim();
    }

    return request.ip ?? request.socket.remoteAddress;
  }
}
