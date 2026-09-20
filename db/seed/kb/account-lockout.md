---
categories: access_identity
---

# Account lockout after failed sign-ins

## Symptom
"Your account has been temporarily locked" or repeated sign-in failures with a
password the user is certain is correct.

## Cause
Ten failed attempts in ten minutes triggers a lockout. The most common source
is not the user: it is a stale password cached on a phone, a mapped drive, or
a scheduled task retrying in the background.

## Resolution
1. Ask the user to fully close Outlook and Teams on their phone.
2. Wait for the smart lockout window to clear. It is 60 seconds after the last
   failed attempt, not 60 seconds from the lockout.
3. Sign in on a laptop first, not a phone.
4. If it locks again within the hour, the source is a cached credential. Check
   Windows Credential Manager on the laptop and remove any stale entries for
   the affected service, then sign in again.

## When to escalate
Repeated lockouts with no cached-credential source, or lockouts affecting more
than one person at once, are treated as a possible password-spray attempt and
go to security, not to the service desk.

## Scope
All Entra ID accounts.
