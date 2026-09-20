---
categories: hardware
---

# Laptop running slowly

## Symptom
General slowness, fans running constantly, applications taking a long time to
open.

## Triage questions worth asking first
- Is it slow all the time, or only on one application?
- Did it start after a specific update or install?
- How long since the last restart? Uptime over a fortnight is common and is
  frequently the whole problem.

## Resolution
1. Restart. Not sleep, not close the lid: a full restart.
2. Check free disk space. Under 10% free on the system drive causes exactly
   this. Empty the Downloads folder and the recycle bin first.
3. Open Task Manager (Windows) or Activity Monitor (macOS) and sort by CPU.
   A single pinned process is a different problem to general slowness.
4. Confirm Windows Update is not mid-download. An update in progress will
   consume the disk and make everything crawl.
5. If the device is more than four years old and none of the above applies,
   raise a hardware refresh rather than continuing to troubleshoot.

## Scope
Company-managed laptops. Not applicable to the warehouse tablets.
