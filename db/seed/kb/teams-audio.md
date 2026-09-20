---
categories: email_collab
---

# Teams call audio problems

## Symptom
Audio cuts out mid-call, others hear robotic or chopped speech, or the
microphone is not picked up at all.

## Resolution
1. In Teams, go to Settings, Devices, and run "Make a test call". Note which
   device is selected for speaker and microphone.
2. If the wrong device is selected, change it. Bluetooth headsets often appear
   twice, once as "Hands-Free" and once as "Stereo". Choose Hands-Free for
   calls; Stereo has no microphone.
3. If audio cuts out on wifi only, move to the 5GHz SSID or connect by cable.
   The 2.4GHz band in the Manchester office is congested and drops calls.
4. Clear the Teams cache: quit Teams entirely, delete the contents of
   %appdata%\Microsoft\Teams\Cache on Windows, then reopen.

## When to escalate
Audio problems affecting several people on the same call at the same time are
a service issue, not a device issue. Check the Microsoft 365 service health
dashboard before troubleshooting individual devices.

## Scope
Teams desktop client on Windows and macOS.
