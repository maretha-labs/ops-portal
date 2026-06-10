// Cognito Pre-Sign-up trigger.
// Rejects any sign-in (including federated Google) whose email is not on the
// allowed domain, and auto-confirms valid federated users.
export const handler = async (event) => {
  const allowed = (process.env.ALLOWED_DOMAIN || "").toLowerCase();
  const email = (event?.request?.userAttributes?.email || "").toLowerCase();
  const domain = email.split("@")[1] || "";

  if (!allowed || domain !== allowed) {
    // Throwing fails the sign-up; Cognito shows the user an error.
    throw new Error(`Access is restricted to @${allowed} accounts.`);
  }

  // For Google (external IdP) sign-ups, confirm + verify so there is no extra step.
  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    event.response.autoConfirmUser = true;
    event.response.autoVerifyEmail = true;
  }
  return event;
};
