import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

export interface BoundedJsonOptions {
  maxBytes?: number;
  maxDepth?: number;
  maxEntries?: number;
  maxStringLength?: number;
}

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function IsBoundedJson(
  options: BoundedJsonOptions = {},
  validationOptions?: ValidationOptions,
): PropertyDecorator {
  const limits = {
    maxBytes: options.maxBytes ?? 8 * 1024,
    maxDepth: options.maxDepth ?? 4,
    maxEntries: options.maxEntries ?? 50,
    maxStringLength: options.maxStringLength ?? 2048,
  };

  return (target, propertyKey) => {
    registerDecorator({
      name: 'isBoundedJson',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      constraints: [limits],
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          try {
            if (
              Buffer.byteLength(JSON.stringify(value), 'utf8') > limits.maxBytes
            ) {
              return false;
            }
          } catch {
            return false;
          }

          return inspectJson(value, 0, { entries: 0 }, limits);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be JSON with at most ${limits.maxBytes} bytes, depth ${limits.maxDepth}, ${limits.maxEntries} entries, and ${limits.maxStringLength} characters per string`;
        },
      },
    });
  };
}

function inspectJson(
  value: unknown,
  depth: number,
  state: { entries: number },
  limits: Required<BoundedJsonOptions>,
): boolean {
  if (depth > limits.maxDepth) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= limits.maxStringLength;

  if (Array.isArray(value)) {
    state.entries += value.length;
    return (
      state.entries <= limits.maxEntries &&
      value.every((entry) => inspectJson(entry, depth + 1, state, limits))
    );
  }

  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) return false;

  const entries = Object.entries(value);
  state.entries += entries.length;
  return (
    state.entries <= limits.maxEntries &&
    entries.every(
      ([key, entry]) =>
        !DANGEROUS_KEYS.has(key) &&
        key.length <= 128 &&
        inspectJson(entry, depth + 1, state, limits),
    )
  );
}
