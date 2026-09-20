---
categories: network_connectivity
---

# VPN will not connect (GlobalProtect)

## Symptom
GlobalProtect sits on "Connecting", reports "Network error", or disconnects a
few seconds after connecting.

## Resolution
1. Confirm the portal address is vpn.northgate.example. A wrong or old portal
   address is the single most common cause.
2. Disconnect from any captive-portal wifi (hotel, cafe, airport) and confirm a
   browser can load a normal website first.
3. Right-click the GlobalProtect icon, choose Disable, wait ten seconds, then
   Enable.
4. Restart the device. This clears a stuck adapter more often than it should.
5. If the error is specifically "Required client certificate not found", the
   device certificate has expired. That needs IT and a reissue.

## Known limits
The VPN does not work on the guest wifi in the Leeds office. That is expected;
use the corporate SSID or a mobile hotspot.

## Scope
Windows and macOS laptops with GlobalProtect. Mobile devices use the Entra
application proxy instead and are not covered here.
