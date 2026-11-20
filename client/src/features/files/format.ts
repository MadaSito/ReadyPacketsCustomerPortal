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
