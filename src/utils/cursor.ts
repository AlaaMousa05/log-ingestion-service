import { parseIsoTimestamp } from "./timestamp.js";

interface CursorData {
  timestamp: string;
  id: string;
}

const BIGINT_ID_PATTERN = /^[1-9]\d*$/;
const MAX_BIGINT_ID = 9_223_372_036_854_775_807n;

function isValidId(value: string): boolean {
  return BIGINT_ID_PATTERN.test(value) && BigInt(value) <= MAX_BIGINT_ID;
}

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeCursor(cursor: string): CursorData | null {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);

    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }

    const { timestamp, id } = parsed as Partial<CursorData>;

    if (
      typeof timestamp !== "string" ||
      typeof id !== "string" ||
      !parseIsoTimestamp(timestamp) ||
      !isValidId(id)
    ) {
      return null;
    }

    return { timestamp, id };
  } catch {
    return null;
  }
}
