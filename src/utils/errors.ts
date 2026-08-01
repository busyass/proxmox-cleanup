import { ErrorType } from '../types';

/** Extract a human-readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Error carrying its classified reason, so callers can report it accurately. */
export class CleanupOperationError extends Error {
  readonly type: ErrorType;
  readonly recoverable: boolean;

  constructor(type: ErrorType, message: string, recoverable: boolean) {
    super(message);
    this.name = 'CleanupOperationError';
    this.type = type;
    this.recoverable = recoverable;
  }
}

/** Unclassified values resolve to 'unknown'. */
export function errorType(error: unknown): ErrorType {
  return error instanceof CleanupOperationError ? error.type : 'unknown';
}

/** Unclassified values are treated as non-recoverable. */
export function isRecoverable(error: unknown): boolean {
  return error instanceof CleanupOperationError ? error.recoverable : false;
}
