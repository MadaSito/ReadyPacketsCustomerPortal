export function formatBytes(value: number | string): string {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KiB", "MiB", "GiB", "TiB", "PiB"];
  let scaled = bytes;
  let index = 0;
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024;
    index++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 }).format(scaled)} ${units[index]}`;
}

/** Round down the displayed allowance without implying no time is left below a minute. */
export function formatAudioTimeRemaining(seconds: number): string {
  if (seconds > 0 && seconds < 60) return "less than 1 minute";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds / 60) % 60;
  const hourLabel = `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const minuteLabel = `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  return hours === 0 ? minuteLabel : minutes === 0 ? hourLabel : `${hourLabel} ${minuteLabel}`;
}
