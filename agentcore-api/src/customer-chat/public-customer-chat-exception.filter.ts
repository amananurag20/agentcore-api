import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class PublicCustomerChatExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PublicCustomerChatExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status: HttpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const publicError = this.toPublicError(status);

    if (Number(status) >= 500) {
      this.logger.error(
        'Public customer chat request failed',
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(status).json({
      statusCode: status,
      error: publicError.error,
      code: publicError.code,
      message: publicError.message,
    });
  }

  private toPublicError(status: HttpStatus): {
    code: string;
    error: string;
    message: string;
  } {
    if (status === HttpStatus.BAD_REQUEST) {
      return {
        code: 'invalid_request',
        error: 'Bad Request',
        message: 'The request is invalid.',
      };
    }
    if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.NOT_FOUND) {
      return {
        code: 'invalid_visitor_session',
        error: status === HttpStatus.NOT_FOUND ? 'Not Found' : 'Unauthorized',
        message: 'The visitor session is no longer valid.',
      };
    }
    if (status === HttpStatus.FORBIDDEN) {
      return {
        code: 'widget_forbidden',
        error: 'Forbidden',
        message: 'This website is not authorized to use this widget.',
      };
    }
    if (status === HttpStatus.CONFLICT) {
      return {
        code: 'conversation_conflict',
        error: 'Conflict',
        message: 'The conversation changed. Refresh and try again.',
      };
    }
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      return {
        code: 'rate_limited',
        error: 'Too Many Requests',
        message: 'Too many requests. Please wait and try again.',
      };
    }
    if (status === HttpStatus.SERVICE_UNAVAILABLE) {
      return {
        code: 'unavailable',
        error: 'Service Unavailable',
        message: 'Chat is temporarily unavailable. Please try again shortly.',
      };
    }
    return {
      code: 'request_failed',
      error: Number(status) >= 500 ? 'Internal Server Error' : 'Request Failed',
      message:
        Number(status) >= 500
          ? 'The request could not be completed. Please try again.'
          : 'The request could not be completed.',
    };
  }
}
