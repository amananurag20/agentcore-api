import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PublicCustomerChatExceptionFilter } from './public-customer-chat-exception.filter';

describe('PublicCustomerChatExceptionFilter', () => {
  function execute(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const filter = new PublicCustomerChatExceptionFilter();
    filter.catch(exception, {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as never);
    return { status, json };
  }

  it('does not expose internal forbidden messages', () => {
    const result = execute(
      new ForbiddenException('Customer Chat is not enabled for org-secret'),
    );

    expect(result.status).toHaveBeenCalledWith(403);
    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'widget_forbidden',
        message: 'This website is not authorized to use this widget.',
      }),
    );
  });

  it('replaces validation details with a stable public response', () => {
    const result = execute(
      new BadRequestException('Secret validation implementation detail'),
    );

    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'invalid_request',
        message: 'The request is invalid.',
      }),
    );
  });

  it('replaces internal errors with a retry-safe message', () => {
    const result = execute(
      new InternalServerErrorException('database table name leaked'),
    );

    expect(result.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'request_failed',
        message: 'The request could not be completed. Please try again.',
      }),
    );
  });
});
