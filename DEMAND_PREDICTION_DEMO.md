# Demand Prediction Demo Dataset

This fictional cloud account has 30 calendar days of sample sales history for
testing the Stock N Sales demand prediction feature.

- **User:** Mila Kora
- **Business:** Harbour Market
- **History:** 14 September–13 October 2026
- **Data:** 3 categories, 5 products, 137 sales transactions
- **Server forecast checked:** 7 days starting 15 October 2026
- **Server model:** Trained model used for all five products

| Product | History days | Forecast demand over 7 days | Average per day |
| --- | ---: | ---: | ---: |
| Rice 5kg bag | 29 | 34.96 units | 4.99 units |
| Cooking oil 1L | 30 | 39.34 units | 5.62 units |
| Tinned mackerel | 30 | 44.01 units | 6.29 units |
| Bottled water 1.5L | 30 | 80.35 units | 11.48 units |
| Sweet biscuits | 30 | 80.35 units | 11.48 units |

All records are synthetic and exist only for demonstration. These forecasts
are predictions from the live model, not actual sales or a guarantee of future
demand. The demo account credentials were provided separately and should only
be used for testing.

After signing into this account on mobile, sync downloads the same sales
history. Mobile demand prediction uses its on-device estimator; desktop uses
the server model summarized above.
