---
categories: access_identity
---

# Password reset and expiry (Entra ID)

## Symptom
User cannot sign in. Message reads "Your password has expired", "The password
you entered is incorrect", or they are looping back to the sign-in page after
entering a correct password.

## Self-service reset
1. Go to https://aka.ms/sspr on any device.
2. Enter the full work email address and the characters shown.
3. Choose the verification method already registered: Authenticator app
   notification, text to the registered mobile, or the alternate email.
4. Set the new password. It must be at least 14 characters and cannot reuse
   any of the last 5.
5. Sign out of Outlook and Teams on the phone, then sign back in. The old
   password stays cached on mobile until you do.

## If self-service fails
Self-service needs at least one registered verification method. If the user
never registered one, or has changed phone, the reset must be done by IT.

## Password expiry window
Passwords expire after 90 days. Warnings appear 14 days out on Windows sign-in
but not on macOS, which is why Mac users are usually the ones caught out.

## Scope
All staff with an Entra ID account. Does not cover the warehouse scanner
accounts, which are local device accounts and are covered separately.
