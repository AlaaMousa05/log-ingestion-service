interface CursorData {
  timestamp: string;
  id: string;
}

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
      typeof parsed.id !== "string"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}