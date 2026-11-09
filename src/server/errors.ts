import type { ErrorCode } from '../shared/types';

export class DomainError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
  }
}
