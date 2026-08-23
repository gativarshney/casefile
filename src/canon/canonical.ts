/**
 * RFC 8785 (JSON Canonicalisation Scheme) with one deliberate restriction: floating
 * point numbers are rejected.
 *
 * Float arithmetic is used freely for internal statistical work. What is forbidden is a
 * float reaching persisted, hashed state, because float formatting is the largest
 * source of cross-platform serialisation drift — and a replay invariant that depends on
 * two machines formatting a double identically is not an invariant.
 *
 * Money is therefore integer paise, rates are integer basis points, timestamps are
 * integer epoch milliseconds, and computed scores cross into canonical state only
 * through {@link quantise}.
 */

export type Canonical =
  | string
  | number
  | boolean
  | null
  | readonly Canonical[]
  | { readonly [key: string]: Canonical };

export class CanonicalisationError extends TypeError {
  readonly path: string;

  constructor(message: string, path: string) {
    super(`${message} (at ${path === "" ? "<root>" : path})`);
    this.name = "CanonicalisationError";
    this.path = path;
  }
}

/** Beyond this, integers lose precision in other languages' JSON parsers. */
const MAX_EXACT_INTEGER = Number.MAX_SAFE_INTEGER;

const FLOAT_HINT =
  "floats cannot be canonicalised; use integer minor units, basis points, or quantise() for scores";

function reject(message: string, path: string): never {
  throw new CanonicalisationError(message, path);
}

function describePath(parent: string, key: string | number): string {
  if (typeof key === "number") return `${parent}[${key}]`;
  return parent === "" ? key : `${parent}.${key}`;
}

function serialise(value: unknown, path: string): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "string":
      return JSON.stringify(value);

    case "number": {
      if (!Number.isFinite(value)) reject(`non-finite number; ${FLOAT_HINT}`, path);
      if (!Number.isInteger(value)) reject(FLOAT_HINT, path);
      if (Object.is(value, -0)) return "0";
      if (Math.abs(value) > MAX_EXACT_INTEGER) {
        reject("integer exceeds the exactly-representable range", path);
      }
      return String(value);
    }

    case "bigint":
      reject("bigint is not canonicalisable; use a number or a decimal string", path);
      break;

    case "undefined":
      reject("undefined is not canonicalisable; use null or omit the key", path);
      break;

    case "function":
    case "symbol":
      reject(`${typeof value} is not canonicalisable`, path);
      break;

    default:
      break;
  }

  if (Array.isArray(value)) {
    const items = value.map((item, index) => serialise(item, describePath(path, index)));
    return `[${items.join(",")}]`;
  }

  // A Date, Map, Set or class instance reaching here is a bug at the call site.
  // Guessing an encoding would produce a digest nobody else can reproduce.
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    reject(`${(value as object).constructor?.name ?? "object"} is not a plain object`, path);
  }

  const record = value as Record<string, unknown>;
  // RFC 8785 orders keys by UTF-16 code unit, which is what JavaScript's default
  // string comparison already does.
  const members = Object.keys(record)
    .sort()
    .map((key) => {
      const entry = record[key];
      if (entry === undefined) {
        reject(
          "undefined is not canonicalisable; use null or omit the key",
          describePath(path, key),
        );
      }
      return `${JSON.stringify(key)}:${serialise(entry, describePath(path, key))}`;
    });
  return `{${members.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  return serialise(value, "");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export const SCORE_PRECISION = 6;

/**
 * The only sanctioned bridge from float arithmetic into canonical state.
 *
 * Returns a string rather than a rounded number so the value cannot be silently
 * re-widened into a float by a downstream JSON round trip.
 */
export function quantise(value: number, places: number = SCORE_PRECISION): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalisationError(`cannot quantise non-finite value ${value}`, "<quantise>");
  }
  if (!Number.isInteger(places) || places < 0 || places > 15) {
    throw new CanonicalisationError(`precision ${places} is out of range`, "<quantise>");
  }

  const negative = value < 0;
  const scaled = Math.abs(value) * 10 ** places;
  // Values that are decimally exact but stored a hair low (0.145 → 0.14499999999999999)
  // must round the way a reader expects, not the way the binary representation falls.
  const rounded = Math.round(scaled + Number.EPSILON * scaled);
  const digits = String(rounded).padStart(places + 1, "0");
  const whole = digits.slice(0, digits.length - places);
  const fraction = places === 0 ? "" : `.${digits.slice(digits.length - places)}`;
  const magnitude = `${whole}${fraction}`;
  return negative && rounded !== 0 ? `-${magnitude}` : magnitude;
}
