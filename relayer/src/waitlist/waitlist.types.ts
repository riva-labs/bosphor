/**
 * Adoption-signal capture (Milestone 2 deliverable c). A waitlist entry is one
 * developer registering early interest; `source` is an optional free-text tag
 * for where the signup came from (e.g. "dashboard", "docs").
 */
export interface WaitlistEntry {
  email: string;
  source?: string;
  createdAt: number;
}

/** Result of an add: `created` is false when the email was already registered. */
export interface WaitlistAddResult {
  created: boolean;
}
