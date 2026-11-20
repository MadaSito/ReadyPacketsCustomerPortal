import { Compass, ServerCrash } from "lucide-react";
import { Link } from "wouter";
import { Button, EmptyState } from "@/ui";

export function NotFoundPage() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <h1 className="sr-only">Page not found</h1>
      <EmptyState
        icon={Compass}
        title="We couldn't find that page"
        description="The link may be outdated, or the page may not be available to your account."
        action={
          <Button asChild>
            <Link href="/">Go to your dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}

export function ServiceUnavailablePage() {
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-12">
      <h1 className="sr-only">Service unavailable</h1>
      <EmptyState
        icon={ServerCrash}
        title="The portal is temporarily unavailable"
        description="We couldn't confirm your session with the server. Please try again in a moment."
        action={<Button onClick={() => window.location.reload()}>Try again</Button>}
      />
    </div>
  );
}
