import { OrbitError } from './errors.js';

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: OrbitError };

export const Result = {
  ok<T>(value: T): Result<T> {
    return { ok: true, value };
  },

  fail<T>(error: OrbitError): Result<T> {
    return { ok: false, error };
  },

  fromThrowable<T>(fn: () => T, mapError: (err: unknown) => OrbitError): Result<T> {
    try {
      return Result.ok(fn());
    } catch (e) {
      return Result.fail(mapError(e));
    }
  },

  async fromAsyncThrowable<T>(
    fn: () => Promise<T>,
    mapError: (err: unknown) => OrbitError
  ): Promise<Result<T>> {
    try {
      return Result.ok(await fn());
    } catch (e) {
      return Result.fail(mapError(e));
    }
  },
};
