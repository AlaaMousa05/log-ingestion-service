const ISO_8601_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;


export function parseIsoTimestamp(value: string): Date | null {
  const match = ISO_8601_TIMESTAMP.exec(value);

  if (!match) {
    return null;
  }

  const year = Number(match[1]!);
  const month = Number(match[2]!);
  const day = Number(match[3]!);
  const hour = Number(match[4]!);
  const minute = Number(match[5]!);
  const second = Number(match[6]!);
  const zone = match[7]!;

  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  if (zone !== "Z") {
    const offsetHour = Number(zone.slice(1, 3));
    const offsetMinute = Number(zone.slice(4, 6));

    if (offsetHour > 23 || offsetMinute > 59) {
      return null;
    }
  }

  const timestamp = new Date(value);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}
