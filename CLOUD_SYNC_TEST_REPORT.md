# Cloud Sync Test Report

**Date:** 14 October 2026  
**Environment:** Live Stock N Sales API on Render  
**Result:** Passed

## Test run

| Check | Result |
| --- | --- |
| API health and database connection | HTTP 200; backend working and database connected |
| Create temporary cloud test account | HTTP 201 |
| Upload a category and product to cloud sync | HTTP 200; product present in returned snapshot |
| Sign in as a second client and download inventory | HTTP 200; product and stock level matched |
| Update stock on the second client and sync | HTTP 200; stock changed from 30 to 24 |
| Sign in again and retrieve the updated stock | HTTP 200; updated stock level of 24 received |
| Remove temporary account and test data | HTTP 200; account deletion confirmed |

## Method

The test used a randomly generated, temporary account and a sample category
and product. Separate mobile authentication sessions simulated two devices:
the first uploaded inventory, the second downloaded and changed stock, and a
returning session received that change. The temporary account and its synced
data were deleted after verification. No test password was saved.

This verifies the live mobile API sync flow. It does not represent a UI test on
two physical phones. The mobile account-centre profile-management endpoint is
also outside this test; its backend workspace-guard fix still needs to be
deployed to Render.
