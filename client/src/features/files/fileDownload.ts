export function saveFileBlob(blob: Blob, displayName: string) {
  const href = URL.createObjectURL(blob);
  try {
    const trigger = document.createElement("a");
    trigger.href = href;
    trigger.download = displayName;
    document.body.append(trigger);
    try { trigger.click(); } finally { trigger.remove(); }
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(href), 30_000);
  }
}
