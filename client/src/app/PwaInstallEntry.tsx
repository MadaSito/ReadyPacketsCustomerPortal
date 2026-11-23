import { useState, useSyncExternalStore } from "react";
import { Button, Dialog } from "@/ui";
import { dismissInstall, getInitialInstall, getInstall, promptInstall, subscribeInstall } from "./pwaInstallState";

export function usePwaInstall() {
  const { available, installed } = useSyncExternalStore(subscribeInstall, getInstall, getInitialInstall);
  return { available, installed, prompt: promptInstall };
}

export function PwaInstallDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const { manual } = useSyncExternalStore(subscribeInstall, getInstall, getInitialInstall);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="sm"
      title="Install ReadyPackets" description="Add a shortcut that opens ReadyPackets in its own window."
      footer={<Button variant="secondary" onClick={() => { onOpenChange(false); dismissInstall(); }}>Don’t show again</Button>}>
      {manual === "ios" ? (
        <ol className="list-decimal space-y-2 ps-5 text-sm">
          <li>Open this page in Safari and tap Share.</li>
          <li>Choose Add to Home Screen. If needed, scroll down to find it or tap Edit Actions.</li>
          <li>Turn on Open as Web App if it appears, then tap Add.</li>
        </ol>
      ) : manual === "mac" ? (
        <ol className="list-decimal space-y-2 ps-5 text-sm">
          <li>In Safari, choose File, then Add to Dock.</li>
          <li>Confirm the name and click Add.</li>
          <li>Open ReadyPackets from the Dock.</li>
        </ol>
      ) : (
        <p className="text-sm">Use the install option in your browser menu or address bar, if available.</p>
      )}
    </Dialog>
  );
}

export function PwaInstallEntry() {
  const { available, prompt } = usePwaInstall();
  const [open, setOpen] = useState(false);
  return (
    <>
      {available && (
        <button type="button" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-2 font-semibold text-action underline-offset-2 hover:underline"
          onClick={() => { void prompt().then((result) => { if (result === "unavailable") setOpen(true); }); }}>
          Install app
        </button>
      )}
      <PwaInstallDialog open={open} onOpenChange={setOpen} />
    </>
  );
}
