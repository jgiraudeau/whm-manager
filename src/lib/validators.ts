// cPanel usernames are typically lowercase and may include underscores.
// Depending on provider policy they can be longer than 8 characters.
export const CPANEL_USERNAME_RE = /^[a-z][a-z0-9_]{2,15}$/;

export function isValidCpanelUsername(value: string): boolean {
  return CPANEL_USERNAME_RE.test(value);
}
