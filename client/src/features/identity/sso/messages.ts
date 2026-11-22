/** Plain-language explanations for single sign-on refusals (server codes SSO_*). */
export const SSO_REFUSAL_MESSAGES: Record<string, { title: string; body: string }> = {
  SSO_UNAVAILABLE: { title: "Single sign-on is not available", body: "Single sign-on is turned off or not reachable right now. Sign in with your e-mail and password instead." },
  SSO_EXPIRED: { title: "This sign-in attempt expired", body: "The attempt took too long or was already used. Start again from the sign-in page." },
  SSO_CANCELLED: { title: "Sign-in was cancelled", body: "Microsoft did not complete the sign-in. You can try again." },
  SSO_FAILED: { title: "We could not verify your Microsoft sign-in", body: "The response from Microsoft could not be verified. Try again, or contact your administrator if this keeps happening." },
  SSO_NOT_LINKED: { title: "Your Microsoft account is not linked", body: "Sign in with your password and link Microsoft from Your account, or ask an administrator to link it." },
  SSO_ACCOUNT_EXISTS: { title: "An account with this e-mail already exists", body: "For your security we never link accounts by e-mail. Sign in with your password, then link Microsoft from Your account." },
  SSO_ACCOUNT_INACTIVE: { title: "This account is not active", body: "Contact support if you think this is a mistake." },
  SSO_LOCAL_SIGN_IN_REQUIRED: { title: "Sign in with your password first", body: "Your account needs a quick security update. Sign in with your e-mail and password to finish it." },
  SSO_DOMAIN_NOT_ALLOWED: { title: "This Microsoft account is not allowed", body: "Your organization limits single sign-on to specific e-mail domains." },
  SSO_ROLE_NOT_ASSIGNED: { title: "Access has not been assigned", body: "Ask your administrator to assign you the portal role in Microsoft Entra ID." },
  SSO_PROVISIONING_LIMIT: { title: "New accounts are paused", body: "Too many new accounts were created today. Try again tomorrow or contact support." },
  SSO_SESSION_CHANGED: { title: "Your session changed", body: "This attempt belongs to a different session. Sign in again and retry from the same browser tab." },
  SSO_MFA_REQUIRED: { title: "Multi-factor verification is required", body: "Microsoft did not confirm multi-factor verification. Verify with your portal authenticator instead." },
  SSO_WRONG_ACCOUNT: { title: "A different Microsoft account was used", body: "Sign in to Microsoft with the account linked to this portal account." },
  SSO_MAINTENANCE: { title: "Customer sign-in is paused for maintenance", body: "We are carrying out planned maintenance. Please try again later." },
  SSO_RESTRICTED: { title: "Sign-in is not allowed from here", body: "Your organization limits where you can sign in from. Contact your administrator if you need access." },
  SSO_IDENTITY_IN_USE: { title: "This Microsoft account is linked elsewhere", body: "It is already linked to a different portal account." },
};

export const ssoRefusal = (code: string | null | undefined) =>
  SSO_REFUSAL_MESSAGES[code ?? ""] ?? SSO_REFUSAL_MESSAGES.SSO_FAILED!;
