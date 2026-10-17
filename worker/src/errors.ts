import type { ErrorCode } from '@nopear/protocol';
export class OpError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'OpError';
  }
}
