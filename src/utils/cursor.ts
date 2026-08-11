import { parseIsoTimestamp } from "./timestamp.js";

interface CursorData {
  timestamp: string;
  id: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
}

export function decodeCursor(
  cursor: string,
): CursorData | null {
  try {
    const decoded = Buffer.from(
      cursor,
      "base64url",
    ).toString("utf8");

    const parsed = JSON.parse(decoded);

    if (
      typeof parsed.timestamp !== "string" ||
      typeof parsed.id !== "string" ||
      !parseIsoTimestamp(parsed.timestamp) ||
      !UUID_PATTERN.test(parsed.id)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}
