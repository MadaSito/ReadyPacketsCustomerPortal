/** /account/sessions — moved: sessions now live on the Security page (kept so old links and bookmarks work). */
import { Redirect } from "wouter";

export default function SessionsPage() {
  return <Redirect to="/account/security" replace />;
}
